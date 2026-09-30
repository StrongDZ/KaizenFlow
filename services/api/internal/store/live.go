package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/kaizenflow/api/internal/live"
)

const bindingCols = `id, model_key, subject, signal, source, json_path, transform, enabled`

func scanBinding(r pgx.Row) (live.Binding, error) {
	var b live.Binding
	err := r.Scan(&b.ID, &b.ModelKey, &b.Subject, &b.Signal, &b.Source, &b.JSONPath, &b.Transform, &b.Enabled)
	return b, err
}

// ListBindings trả mọi mapping của một mô hình (kể cả đang tắt).
func (s *Store) ListBindings(ctx context.Context, modelKey string) ([]live.Binding, error) {
	rows, err := s.Pool.Query(ctx, `SELECT `+bindingCols+` FROM data_binding WHERE model_key = $1 ORDER BY subject, signal`, modelKey)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (live.Binding, error) { return scanBinding(r) })
}

// AllBindings trả mapping đang bật của mọi mô hình (đường ingest dùng).
func (s *Store) AllBindings(ctx context.Context) ([]live.Binding, error) {
	rows, err := s.Pool.Query(ctx, `SELECT `+bindingCols+` FROM data_binding WHERE enabled ORDER BY id`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (live.Binding, error) { return scanBinding(r) })
}

// SaveBindings ghi (thêm hoặc cập nhật theo subject+signal) một lô mapping trong một transaction.
func (s *Store) SaveBindings(ctx context.Context, modelKey string, bs []live.Binding) error {
	for _, b := range bs {
		switch {
		case b.Subject == "":
			return &RefError{Key: "subject", Msg: "thiếu đối tượng (node hoặc edge)"}
		case b.Signal == "":
			return &RefError{Key: b.Subject, Msg: "thiếu tín hiệu"}
		case b.Source == "":
			return &RefError{Key: b.Subject, Msg: "thiếu nguồn dữ liệu"}
		}
	}
	return s.inTx(ctx, func(tx pgx.Tx) error {
		for _, b := range bs {
			if _, err := tx.Exec(ctx, `INSERT INTO data_binding (model_key, subject, signal, source, json_path, transform, enabled)
				VALUES ($1, $2, $3, $4, $5, $6, $7)
				ON CONFLICT (model_key, subject, signal) DO UPDATE
				SET source = EXCLUDED.source, json_path = EXCLUDED.json_path, transform = EXCLUDED.transform, enabled = EXCLUDED.enabled`,
				modelKey, b.Subject, b.Signal, b.Source, b.JSONPath, b.Transform, b.Enabled); err != nil {
				return err
			}
		}
		return nil
	})
}

// DeleteBinding xoá một mapping; id của mô hình khác thì coi như không có.
func (s *Store) DeleteBinding(ctx context.Context, modelKey string, id int64) error {
	tag, err := s.Pool.Exec(ctx, `DELETE FROM data_binding WHERE id = $1 AND model_key = $2`, id, modelKey)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteAllBindings xoá mọi mapping của một mô hình, trả số dòng đã xoá.
func (s *Store) DeleteAllBindings(ctx context.Context, modelKey string) (int64, error) {
	tag, err := s.Pool.Exec(ctx, `DELETE FROM data_binding WHERE model_key = $1`, modelKey)
	return tag.RowsAffected(), err
}

// GetAgvMap trả JSON đồ thị bản đồ AGV của mô hình.
func (s *Store) GetAgvMap(ctx context.Context, modelKey string) (json.RawMessage, error) {
	var g json.RawMessage
	if err := s.Pool.QueryRow(ctx, `SELECT graph FROM agv_map WHERE model_key = $1`, modelKey).Scan(&g); err != nil {
		return nil, notFound(err)
	}
	return g, nil
}

func (s *Store) PutAgvMap(ctx context.Context, modelKey string, graph json.RawMessage) error {
	_, err := s.Pool.Exec(ctx, `INSERT INTO agv_map (model_key, graph) VALUES ($1, $2)
		ON CONFLICT (model_key) DO UPDATE SET graph = EXCLUDED.graph, updated_at = now()`, modelKey, graph)
	return err
}

type LiveSignal struct {
	Time    time.Time
	Model   string
	Subject string
	Name    string
	Value   float64
}

type LiveEvent struct {
	Time    time.Time
	Model   string
	Subject string
	Type    string
	Payload map[string]any
}

// InsertLive ghi một lô tín hiệu và sự kiện thật (run_id NULL).
func (s *Store) InsertLive(ctx context.Context, sigs []LiveSignal, evs []LiveEvent) error {
	if len(sigs) == 0 && len(evs) == 0 {
		return nil
	}
	return s.inTx(ctx, func(tx pgx.Tx) error {
		if len(sigs) > 0 {
			rows := make([][]any, len(sigs))
			for i, x := range sigs {
				rows[i] = []any{x.Time, x.Model, x.Subject, x.Name, x.Value}
			}
			if _, err := tx.CopyFrom(ctx, pgx.Identifier{"signal"}, []string{"time", "model_key", "subject", "name", "value"},
				pgx.CopyFromRows(rows)); err != nil {
				return err
			}
		}
		if len(evs) > 0 {
			rows := make([][]any, len(evs))
			for i, x := range evs {
				p := x.Payload
				if p == nil {
					p = map[string]any{}
				}
				rows[i] = []any{x.Time, x.Model, x.Subject, x.Type, p}
			}
			if _, err := tx.CopyFrom(ctx, pgx.Identifier{"event_log"}, []string{"time", "model_key", "subject", "type", "payload"},
				pgx.CopyFromRows(rows)); err != nil {
				return err
			}
		}
		return nil
	})
}

// LiveSignals đọc tín hiệu thật của một mô hình theo thời gian tăng dần.
func (s *Store) LiveSignals(ctx context.Context, model, subject, name string, since, until *time.Time, limit int) ([]SignalRow, error) {
	if limit <= 0 || limit > 20000 {
		limit = 20000
	}
	rows, err := s.Pool.Query(ctx, `SELECT time, subject, name, coalesce(value, 0) FROM signal
		WHERE run_id IS NULL AND model_key = $1 AND ($2 = '' OR subject = $2) AND ($3 = '' OR name = $3)
		  AND ($4::timestamptz IS NULL OR time >= $4) AND ($5::timestamptz IS NULL OR time <= $5)
		ORDER BY time LIMIT $6`, model, subject, name, since, until, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (SignalRow, error) {
		var sg SignalRow
		err := r.Scan(&sg.T, &sg.Subject, &sg.Name, &sg.Value)
		return sg, err
	})
}

// LiveEvents đọc sự kiện thật gần nhất (mới nhất trước).
func (s *Store) LiveEvents(ctx context.Context, model, subject string, limit int) ([]EventRow, error) {
	if limit <= 0 || limit > 5000 {
		limit = 500
	}
	rows, err := s.Pool.Query(ctx, `SELECT time, subject, type, payload FROM event_log
		WHERE run_id IS NULL AND model_key = $1 AND ($2 = '' OR subject = $2) ORDER BY time DESC LIMIT $3`, model, subject, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (EventRow, error) {
		var e EventRow
		err := r.Scan(&e.T, &e.Subject, &e.Type, &e.Payload)
		return e, err
	})
}

// ClearLive xoá dữ liệu live (tín hiệu và sự kiện thật) của một mô hình; dữ liệu mô phỏng không bị đụng.
func (s *Store) ClearLive(ctx context.Context, model string) error {
	return s.inTx(ctx, func(tx pgx.Tx) error { return clearLiveTx(ctx, tx, model) })
}

func clearLiveTx(ctx context.Context, tx pgx.Tx, model string) error {
	for _, q := range []string{
		`DELETE FROM signal WHERE run_id IS NULL AND model_key = $1`,
		`DELETE FROM event_log WHERE run_id IS NULL AND model_key = $1`,
	} {
		if _, err := tx.Exec(ctx, q, model); err != nil {
			return err
		}
	}
	return nil
}

// deleteLiveConfig xoá mapping, bản đồ AGV và dữ liệu live của một mô hình (gọi khi xoá mô hình).
func deleteLiveConfig(ctx context.Context, tx pgx.Tx, model string) error {
	for _, q := range []string{`DELETE FROM data_binding WHERE model_key = $1`, `DELETE FROM agv_map WHERE model_key = $1`} {
		if _, err := tx.Exec(ctx, q, model); err != nil {
			return err
		}
	}
	return clearLiveTx(ctx, tx, model)
}
