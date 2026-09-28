package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/kaizenflow/api/internal/simapi"
)

type Run struct {
	ID            int64          `json:"id"`
	ScenarioID    int64          `json:"scenario_id"`
	Purpose       string         `json:"purpose"`
	Status        string         `json:"status"`
	SimStart      time.Time      `json:"sim_start"`
	KPIs          map[string]any `json:"kpis"`
	Error         *string        `json:"error"`
	EngineVersion *string        `json:"engine_version"`
	CreatedAt     time.Time      `json:"created_at"`
	FinishedAt    *time.Time     `json:"finished_at"`
}

type Insight struct {
	ID          int64          `json:"id"`
	SimRunID    *int64         `json:"sim_run_id"`
	Kind        string         `json:"kind"`
	SubjectKey  *string        `json:"subject_key"`
	ETA         *time.Time     `json:"eta"`
	Probability *float64       `json:"probability"`
	Severity    *int           `json:"severity"`
	Payload     map[string]any `json:"payload"`
	Status      string         `json:"status"`
	CreatedAt   time.Time      `json:"created_at"`
}

type BandRow struct {
	Subject string    `json:"subject"`
	Metric  string    `json:"metric"`
	T       time.Time `json:"t"`
	P10     float64   `json:"p10"`
	P50     float64   `json:"p50"`
	P90     float64   `json:"p90"`
}

type EventRow struct {
	T       time.Time      `json:"t"`
	Rep     int            `json:"rep"`
	Subject string         `json:"subject"`
	Type    string         `json:"type"`
	Payload map[string]any `json:"payload"`
}

type SignalRow struct {
	T       time.Time `json:"t"`
	Rep     int       `json:"rep"`
	Subject string    `json:"subject"`
	Name    string    `json:"name"`
	Value   float64   `json:"value"`
}

func (s *Store) InsertRun(ctx context.Context, scenarioID int64, simStart time.Time, purpose string) (int64, error) {
	var id int64
	err := s.Pool.QueryRow(ctx, `INSERT INTO sim_run (scenario_id, purpose, sim_start) VALUES ($1, $2, $3) RETURNING id`,
		scenarioID, purpose, simStart).Scan(&id)
	return id, err
}

func (s *Store) SetRunStatus(ctx context.Context, id int64, status string, errMsg *string) error {
	tag, err := s.Pool.Exec(ctx, `UPDATE sim_run SET status = $2::text, error = $3,
		finished_at = CASE WHEN $2::text IN ('DONE', 'FAILED') THEN now() ELSE finished_at END WHERE id = $1`,
		id, status, errMsg)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

const runCols = `id, scenario_id, purpose, status, sim_start, kpis, error, engine_version, created_at, finished_at`

func scanRun(r pgx.Row) (Run, error) {
	var run Run
	var kpis []byte
	err := r.Scan(&run.ID, &run.ScenarioID, &run.Purpose, &run.Status, &run.SimStart, &kpis, &run.Error,
		&run.EngineVersion, &run.CreatedAt, &run.FinishedAt)
	if err == nil && kpis != nil {
		err = json.Unmarshal(kpis, &run.KPIs)
	}
	return run, err
}

func (s *Store) GetRun(ctx context.Context, id int64) (*Run, error) {
	run, err := scanRun(s.Pool.QueryRow(ctx, `SELECT `+runCols+` FROM sim_run WHERE id = $1`, id))
	if err != nil {
		return nil, notFound(err)
	}
	return &run, nil
}

func (s *Store) ListRuns(ctx context.Context, scenarioID int64) ([]Run, error) {
	rows, err := s.Pool.Query(ctx, `SELECT `+runCols+` FROM sim_run WHERE scenario_id = $1 ORDER BY id DESC`, scenarioID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Run, error) { return scanRun(r) })
}

// SaveResult lưu toàn bộ kết quả một run trong một transaction; dữ liệu lớn dùng COPY.
func (s *Store) SaveResult(ctx context.Context, runID int64, res *simapi.Result) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `UPDATE sim_run SET status = 'DONE', kpis = $2, engine_version = $3, finished_at = now()
		WHERE id = $1`, runID, res.KPIs, res.EngineVersion); err != nil {
		return err
	}
	for _, in := range res.Insights {
		payload := in.Payload
		if payload == nil {
			payload = map[string]any{}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO insight (sim_run_id, kind, subject_key, eta, probability, severity, payload)
			VALUES ($1, $2, $3, $4, $5, $6, $7)`, runID, in.Kind, in.SubjectKey, in.ETA, in.Probability, in.Severity, payload); err != nil {
			return err
		}
	}
	bands := make([][]any, len(res.Bands))
	for i, b := range res.Bands {
		bands[i] = []any{b.IssuedAt, b.TargetTime, b.Producer, runID, b.Subject, b.Metric, float32(b.P10), float32(b.P50), float32(b.P90)}
	}
	if _, err := tx.CopyFrom(ctx, pgx.Identifier{"forecast_band"},
		[]string{"issued_at", "target_time", "producer", "ref_id", "subject", "metric", "p10", "p50", "p90"},
		pgx.CopyFromRows(bands)); err != nil {
		return err
	}
	sigs := make([][]any, len(res.Signals))
	for i, sg := range res.Signals {
		sigs[i] = []any{sg.Time, runID, int16(sg.Rep), sg.Subject, sg.Name, sg.Value}
	}
	if _, err := tx.CopyFrom(ctx, pgx.Identifier{"signal"}, []string{"time", "run_id", "rep", "subject", "name", "value"},
		pgx.CopyFromRows(sigs)); err != nil {
		return err
	}
	evs := make([][]any, len(res.Events))
	for i, ev := range res.Events {
		p := ev.Payload
		if p == nil {
			p = map[string]any{}
		}
		evs[i] = []any{ev.Time, runID, int16(ev.Rep), ev.Subject, ev.Type, p}
	}
	if _, err := tx.CopyFrom(ctx, pgx.Identifier{"event_log"}, []string{"time", "run_id", "rep", "subject", "type", "payload"},
		pgx.CopyFromRows(evs)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

const insightCols = `id, sim_run_id, kind, subject_key, eta, probability, severity, payload, status, created_at`

func scanInsight(r pgx.Row) (Insight, error) {
	var in Insight
	var prob *float32
	var sev *int16
	err := r.Scan(&in.ID, &in.SimRunID, &in.Kind, &in.SubjectKey, &in.ETA, &prob, &sev, &in.Payload, &in.Status, &in.CreatedAt)
	if prob != nil {
		p := float64(*prob)
		in.Probability = &p
	}
	if sev != nil {
		v := int(*sev)
		in.Severity = &v
	}
	return in, err
}

func (s *Store) ListInsights(ctx context.Context, runID int64) ([]Insight, error) {
	rows, err := s.Pool.Query(ctx, `SELECT `+insightCols+` FROM insight WHERE sim_run_id = $1 ORDER BY id`, runID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Insight, error) { return scanInsight(r) })
}

func (s *Store) GetInsight(ctx context.Context, id int64) (*Insight, error) {
	in, err := scanInsight(s.Pool.QueryRow(ctx, `SELECT `+insightCols+` FROM insight WHERE id = $1`, id))
	if err != nil {
		return nil, notFound(err)
	}
	return &in, nil
}

func (s *Store) Bands(ctx context.Context, runID int64, subject, metric string) ([]BandRow, error) {
	rows, err := s.Pool.Query(ctx, `SELECT subject, metric, target_time, coalesce(p10, 0), coalesce(p50, 0), coalesce(p90, 0)
		FROM forecast_band WHERE ref_id = $1 AND producer = 'SIM' AND ($2 = '' OR subject = $2) AND ($3 = '' OR metric = $3)
		ORDER BY subject, metric, target_time`, runID, subject, metric)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (BandRow, error) {
		var b BandRow
		var p10, p50, p90 float32
		err := r.Scan(&b.Subject, &b.Metric, &b.T, &p10, &p50, &p90)
		b.P10, b.P50, b.P90 = float64(p10), float64(p50), float64(p90)
		return b, err
	})
}

func (s *Store) Events(ctx context.Context, runID int64, subject, typ string) ([]EventRow, error) {
	rows, err := s.Pool.Query(ctx, `SELECT time, rep, subject, type, payload FROM event_log
		WHERE run_id = $1 AND ($2 = '' OR subject = $2) AND ($3 = '' OR type = $3) ORDER BY time LIMIT 5000`, runID, subject, typ)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (EventRow, error) {
		var e EventRow
		var rep int16
		err := r.Scan(&e.T, &rep, &e.Subject, &e.Type, &e.Payload)
		e.Rep = int(rep)
		return e, err
	})
}

func (s *Store) Signals(ctx context.Context, runID int64, subject, name string) ([]SignalRow, error) {
	rows, err := s.Pool.Query(ctx, `SELECT time, rep, subject, name, coalesce(value, 0) FROM signal
		WHERE run_id = $1 AND ($2 = '' OR subject = $2) AND ($3 = '' OR name = $3) ORDER BY time LIMIT 20000`, runID, subject, name)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (SignalRow, error) {
		var sg SignalRow
		var rep int16
		err := r.Scan(&sg.T, &rep, &sg.Subject, &sg.Name, &sg.Value)
		sg.Rep = int(rep)
		return sg, err
	})
}
