package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

type Scenario struct {
	ID             int64            `json:"id"`
	ModelVersionID int64            `json:"model_version_id"`
	ParentID       *int64           `json:"parent_id"`
	Origin         string           `json:"origin"`
	Name           string           `json:"name"`
	HorizonS       float64          `json:"horizon_s"`
	StartState     string           `json:"start_state"`
	Overrides      []map[string]any `json:"overrides"`
	Injections     []map[string]any `json:"injections"`
	Action         map[string]any   `json:"action"`
	Replications   int              `json:"replications"`
	Seed           *int64           `json:"seed"`
	CreatedAt      time.Time        `json:"created_at"`
}

// DailyPoint là một điểm dự báo nhu cầu theo ngày (forecast_band, metric demand_daily).
type DailyPoint struct {
	Day time.Time
	P50 float64
}

func (s *Store) CreateScenario(ctx context.Context, sc Scenario) (int64, error) {
	if sc.Origin == "" {
		sc.Origin = "USER"
	}
	if sc.StartState == "" {
		sc.StartState = "WARMUP"
	}
	if sc.Replications <= 0 {
		sc.Replications = 50
	}
	if sc.Overrides == nil {
		sc.Overrides = []map[string]any{}
	}
	if sc.Injections == nil {
		sc.Injections = []map[string]any{}
	}
	var id int64
	err := s.Pool.QueryRow(ctx, `INSERT INTO scenario (model_version_id, parent_id, origin, name, horizon, start_state,
		overrides, injections, action, replications, seed)
		VALUES ($1, $2, $3, $4, make_interval(secs => $5), $6, $7, $8, $9, $10, $11) RETURNING id`,
		sc.ModelVersionID, sc.ParentID, sc.Origin, sc.Name, sc.HorizonS, sc.StartState,
		sc.Overrides, sc.Injections, sc.Action, sc.Replications, sc.Seed).Scan(&id)
	return id, err
}

const scenarioCols = `id, model_version_id, parent_id, origin, coalesce(name, ''), extract(epoch FROM horizon)::float8,
	start_state, overrides, injections, action, replications, seed, created_at`

func scenarioTargets(sc *Scenario) []any {
	return []any{&sc.ID, &sc.ModelVersionID, &sc.ParentID, &sc.Origin, &sc.Name, &sc.HorizonS, &sc.StartState,
		&sc.Overrides, &sc.Injections, &sc.Action, &sc.Replications, &sc.Seed, &sc.CreatedAt}
}

func scanScenario(r pgx.Row) (Scenario, error) {
	var sc Scenario
	err := r.Scan(scenarioTargets(&sc)...)
	return sc, err
}

// ScenarioRow là scenario kèm số run và trạng thái run gần nhất.
type ScenarioRow struct {
	Scenario
	Runs          int     `json:"runs"`
	LastRunStatus *string `json:"last_run_status"`
}

func (s *Store) GetScenario(ctx context.Context, id int64) (*Scenario, error) {
	sc, err := scanScenario(s.Pool.QueryRow(ctx, `SELECT `+scenarioCols+` FROM scenario WHERE id = $1`, id))
	if err != nil {
		return nil, notFound(err)
	}
	return &sc, nil
}

func (s *Store) ListScenarios(ctx context.Context, versionID int64) ([]ScenarioRow, error) {
	rows, err := s.Pool.Query(ctx, `SELECT `+scenarioCols+`,
		(SELECT count(*) FROM sim_run r WHERE r.scenario_id = scenario.id),
		(SELECT r.status FROM sim_run r WHERE r.scenario_id = scenario.id ORDER BY r.id DESC LIMIT 1)
		FROM scenario WHERE model_version_id = $1 ORDER BY id`, versionID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (ScenarioRow, error) {
		var x ScenarioRow
		err := r.Scan(append(scenarioTargets(&x.Scenario), &x.Runs, &x.LastRunStatus)...)
		return x, err
	})
}

// DailyForecast trả điểm demand_daily của lô issued_at mới nhất trong [from, to).
func (s *Store) DailyForecast(ctx context.Context, material, producer string, from, to time.Time) ([]DailyPoint, error) {
	rows, err := s.Pool.Query(ctx, `SELECT target_time, p50 FROM forecast_band
		WHERE producer = $1 AND subject = $2 AND metric = 'demand_daily'
		  AND issued_at = (SELECT max(issued_at) FROM forecast_band WHERE producer = $1 AND subject = $2 AND metric = 'demand_daily')
		  AND target_time >= $3 AND target_time < $4 ORDER BY target_time`, producer, material, from, to)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (DailyPoint, error) {
		var p DailyPoint
		var v float32
		err := r.Scan(&p.Day, &v)
		p.P50 = float64(v)
		return p, err
	})
}

func (s *Store) UpdateScenario(ctx context.Context, id int64, sc Scenario) error {
	if sc.StartState == "" {
		sc.StartState = "WARMUP"
	}
	if sc.Replications <= 0 {
		sc.Replications = 50
	}
	if sc.Overrides == nil {
		sc.Overrides = []map[string]any{}
	}
	if sc.Injections == nil {
		sc.Injections = []map[string]any{}
	}
	return s.inTx(ctx, func(tx pgx.Tx) error {
		var locked int64
		if err := tx.QueryRow(ctx, `SELECT id FROM scenario WHERE id = $1 FOR UPDATE`, id).Scan(&locked); err != nil {
			return notFound(err)
		}
		var runs int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM sim_run WHERE scenario_id = $1`, id).Scan(&runs); err != nil {
			return err
		}
		if runs > 0 {
			return &LockedError{Msg: "scenario đã có lần chạy nên không sửa được, hãy nhân bản", Usage: map[string]int{"runs": runs}}
		}
		_, err := tx.Exec(ctx, `UPDATE scenario SET name = $2, horizon = make_interval(secs => $3), start_state = $4,
			overrides = $5, injections = $6, replications = $7 WHERE id = $1`,
			id, sc.Name, sc.HorizonS, sc.StartState, sc.Overrides, sc.Injections, sc.Replications)
		return err
	})
}

// CloneScenario sao chép thông số của một scenario thành scenario USER mới, không mang theo dòng dõi (parent_id, action).
func (s *Store) CloneScenario(ctx context.Context, id int64) (int64, error) {
	var newID int64
	err := s.Pool.QueryRow(ctx, `INSERT INTO scenario (model_version_id, parent_id, origin, name, horizon, start_state,
		overrides, injections, action, replications, seed)
		SELECT model_version_id, NULL, 'USER', coalesce(nullif(name, ''), 'Scenario #' || id) || ' (bản sao)', horizon,
			start_state, overrides, injections, NULL, replications, seed
		FROM scenario WHERE id = $1 RETURNING id`, id).Scan(&newID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	return newID, err
}
