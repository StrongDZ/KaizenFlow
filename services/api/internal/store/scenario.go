package store

import (
	"context"
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

func scanScenario(r pgx.Row) (Scenario, error) {
	var sc Scenario
	err := r.Scan(&sc.ID, &sc.ModelVersionID, &sc.ParentID, &sc.Origin, &sc.Name, &sc.HorizonS, &sc.StartState,
		&sc.Overrides, &sc.Injections, &sc.Action, &sc.Replications, &sc.Seed, &sc.CreatedAt)
	return sc, err
}

func (s *Store) GetScenario(ctx context.Context, id int64) (*Scenario, error) {
	sc, err := scanScenario(s.Pool.QueryRow(ctx, `SELECT `+scenarioCols+` FROM scenario WHERE id = $1`, id))
	if err != nil {
		return nil, notFound(err)
	}
	return &sc, nil
}

func (s *Store) ListScenarios(ctx context.Context, versionID int64) ([]Scenario, error) {
	rows, err := s.Pool.Query(ctx, `SELECT `+scenarioCols+` FROM scenario WHERE model_version_id = $1 ORDER BY id`, versionID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Scenario, error) { return scanScenario(r) })
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
