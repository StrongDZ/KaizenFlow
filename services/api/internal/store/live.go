package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/kaizenflow/api/internal/live"
)

const bindingCols = `id, model_key, subject, signal, source, json_path, transform, enabled, mode, derive`

func scanBinding(r pgx.Row) (live.Binding, error) {
	var b live.Binding
	err := r.Scan(&b.ID, &b.ModelKey, &b.Subject, &b.Signal, &b.Source, &b.JSONPath, &b.Transform, &b.Enabled, &b.Mode, &b.Derive)
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
	for i, b := range bs {
		if b.Mode == "" {
			bs[i].Mode = live.ModeSource
		}
		switch {
		case b.Subject == "":
			return &RefError{Key: "subject", Msg: "thiếu đối tượng (node hoặc edge)"}
		case b.Signal == "":
			return &RefError{Key: b.Subject, Msg: "thiếu tín hiệu"}
		case bs[i].Mode == live.ModeDerived && b.Derive == nil:
			return &RefError{Key: b.Subject, Msg: "thiếu công thức tự tính"}
		case bs[i].Mode == live.ModeSource && b.Source == "":
			return &RefError{Key: b.Subject, Msg: "thiếu nguồn dữ liệu"}
		case bs[i].Mode != live.ModeSource && bs[i].Mode != live.ModeDerived:
			return &RefError{Key: b.Subject, Msg: "cách lấy giá trị phải là từ nguồn hoặc tự tính"}
		}
	}
	return s.inTx(ctx, func(tx pgx.Tx) error {
		for _, b := range bs {
			if _, err := tx.Exec(ctx, `INSERT INTO data_binding (model_key, subject, signal, source, json_path, transform, enabled, mode, derive)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
				ON CONFLICT (model_key, subject, signal) DO UPDATE
				SET source = EXCLUDED.source, json_path = EXCLUDED.json_path, transform = EXCLUDED.transform, enabled = EXCLUDED.enabled,
				    mode = EXCLUDED.mode, derive = EXCLUDED.derive`,
				modelKey, b.Subject, b.Signal, b.Source, b.JSONPath, b.Transform, b.Enabled, b.Mode, b.Derive); err != nil {
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

// MapImage là ảnh mặt bằng làm nền của bản đồ AGV; Rev đổi mỗi lần tải ảnh mới.
type MapImage struct {
	Mime          string
	Data          []byte
	Width, Height int
	Rev           int64
}

func (s *Store) PutAgvMapImage(ctx context.Context, modelKey string, img MapImage) error {
	_, err := s.Pool.Exec(ctx, `INSERT INTO agv_map_image (model_key, mime, data, width, height, rev) VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (model_key) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, width = EXCLUDED.width,
		  height = EXCLUDED.height, rev = EXCLUDED.rev, updated_at = now()`, modelKey, img.Mime, img.Data, img.Width, img.Height, img.Rev)
	return err
}

func (s *Store) GetAgvMapImage(ctx context.Context, modelKey string) (*MapImage, error) {
	var img MapImage
	if err := s.Pool.QueryRow(ctx, `SELECT mime, data, width, height, rev FROM agv_map_image WHERE model_key = $1`, modelKey).
		Scan(&img.Mime, &img.Data, &img.Width, &img.Height, &img.Rev); err != nil {
		return nil, notFound(err)
	}
	return &img, nil
}

// DeleteAgvMapImage xoá ảnh nền; không có ảnh thì không làm gì.
func (s *Store) DeleteAgvMapImage(ctx context.Context, modelKey string) error {
	_, err := s.Pool.Exec(ctx, `DELETE FROM agv_map_image WHERE model_key = $1`, modelKey)
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

// deleteLiveConfig xoá mapping, nguồn dữ liệu, bản đồ AGV và dữ liệu live của một mô hình (gọi khi xoá mô hình).
func deleteLiveConfig(ctx context.Context, tx pgx.Tx, model string) error {
	for _, q := range []string{`DELETE FROM data_binding WHERE model_key = $1`, `DELETE FROM agv_map WHERE model_key = $1`, `DELETE FROM agv_map_image WHERE model_key = $1`, `DELETE FROM data_source WHERE model_key = $1`} {
		if _, err := tx.Exec(ctx, q, model); err != nil {
			return err
		}
	}
	return clearLiveTx(ctx, tx, model)
}

// LatestNowcastRun trả lần chạy dự báo từ trạng thái live đã xong gần nhất của một mô hình (nil nếu chưa có).
func (s *Store) LatestNowcastRun(ctx context.Context, model string) (*RunRow, error) {
	rows, err := s.ListRunRows(ctx, RunFilter{Model: model, Origin: "NOWCAST", Statuses: []string{"DONE"}, Limit: 1})
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return &rows[0], nil
}

// InsertInsight ghi một insight do Go sinh ra (không đi qua kết quả của sim), vd. cảnh báo lệch dự báo.
func (s *Store) InsertInsight(ctx context.Context, in Insight) (int64, error) {
	if in.Payload == nil {
		in.Payload = map[string]any{}
	}
	var id int64
	err := s.Pool.QueryRow(ctx, `INSERT INTO insight (sim_run_id, kind, subject_key, eta, probability, severity, payload)
		VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
		in.SimRunID, in.Kind, in.SubjectKey, in.ETA, in.Probability, in.Severity, in.Payload).Scan(&id)
	return id, err
}

// OpenInsightExists: đã có insight còn mở cùng loại, đối tượng và chỉ số (payload.metric) cho lần chạy này chưa.
func (s *Store) OpenInsightExists(ctx context.Context, runID int64, kind, subject, metric string) (bool, error) {
	var ok bool
	err := s.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM insight WHERE sim_run_id = $1 AND kind = $2 AND subject_key = $3
		AND status = 'OPEN' AND payload ->> 'metric' = $4)`, runID, kind, subject, metric).Scan(&ok)
	return ok, err
}

// SetInsightStatus đổi trạng thái insight (OPEN → ACK | DONE).
func (s *Store) SetInsightStatus(ctx context.Context, id int64, status string) error {
	tag, err := s.Pool.Exec(ctx, `UPDATE insight SET status = $2 WHERE id = $1`, id, status)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// RecentLiveValues trả tối đa n giá trị gần nhất của một tín hiệu thật, theo thứ tự thời gian tăng dần.
func (s *Store) RecentLiveValues(ctx context.Context, model, subject, name string, n int) ([]float64, error) {
	rows, err := s.Pool.Query(ctx, `SELECT coalesce(value, 0) FROM signal
		WHERE run_id IS NULL AND model_key = $1 AND subject = $2 AND name = $3 ORDER BY time DESC LIMIT $4`, model, subject, name, n)
	if err != nil {
		return nil, err
	}
	out, err := pgx.CollectRows(rows, pgx.RowTo[float64])
	if err != nil {
		return nil, err
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, nil
}

// SupersedeDrift đóng (DONE) mọi cảnh báo lệch đang mở của một mô hình: dự báo mới thay dự báo cũ nên cảnh báo về dự báo cũ hết ý nghĩa.
func (s *Store) SupersedeDrift(ctx context.Context, model string) (int64, error) {
	tag, err := s.Pool.Exec(ctx, `UPDATE insight SET status = 'DONE' WHERE kind = 'DRIFT' AND status = 'OPEN' AND sim_run_id IN (
		SELECT r.id FROM sim_run r JOIN scenario sc ON sc.id = r.scenario_id JOIN model_version v ON v.id = sc.model_version_id
		WHERE v.model_key = $1)`, model)
	return tag.RowsAffected(), err
}

// DataSource là một nguồn dữ liệu (thiết bị, topic) của một mô hình. Origin: feed (tự ghi khi nhận bản tin) hoặc manual (người dùng khai báo).
// FirstSeen, LastSeen theo giờ thật; Sample là bản tin mới nhất (hoặc mẫu người dùng dán).
type DataSource struct {
	ModelKey  string          `json:"model_key"`
	Source    string          `json:"source"`
	Desc      string          `json:"desc"`
	Origin    string          `json:"origin"`
	FirstSeen time.Time       `json:"first_seen"`
	LastSeen  time.Time       `json:"last_seen"`
	Count     int64           `json:"count"`
	Sample    json.RawMessage `json:"sample"`
}

// UpsertSources ghi một lô nguồn: cộng dồn số bản tin, giữ lần đầu thấy, cập nhật lần cuối và mẫu; mô tả rỗng không xoá mô tả cũ;
// nguồn đã khai báo tay vẫn là manual, và bản ghi manual mới chuyển nguồn tự ghi thành manual.
func (s *Store) UpsertSources(ctx context.Context, list []DataSource) error {
	if len(list) == 0 {
		return nil
	}
	return s.inTx(ctx, func(tx pgx.Tx) error {
		for _, d := range list {
			if d.Origin == "" {
				d.Origin = "feed"
			}
			var sample any
			if len(d.Sample) > 0 {
				sample = []byte(d.Sample)
			}
			if _, err := tx.Exec(ctx, `INSERT INTO data_source (model_key, source, description, origin, first_seen, last_seen, msg_count, sample)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
				ON CONFLICT (model_key, source) DO UPDATE SET
				  description = CASE WHEN EXCLUDED.description <> '' THEN EXCLUDED.description ELSE data_source.description END,
				  origin      = CASE WHEN EXCLUDED.origin = 'manual' THEN 'manual' ELSE data_source.origin END,
				  last_seen   = GREATEST(data_source.last_seen, EXCLUDED.last_seen),
				  msg_count   = data_source.msg_count + EXCLUDED.msg_count,
				  sample      = COALESCE(EXCLUDED.sample, data_source.sample)`,
				d.ModelKey, d.Source, d.Desc, d.Origin, d.FirstSeen, d.LastSeen, d.Count, sample); err != nil {
				return err
			}
		}
		return nil
	})
}

// ListSources trả mọi nguồn của một mô hình, theo tên nguồn.
func (s *Store) ListSources(ctx context.Context, model string) ([]DataSource, error) {
	rows, err := s.Pool.Query(ctx, `SELECT model_key, source, description, origin, first_seen, last_seen, msg_count, sample
		FROM data_source WHERE model_key = $1 ORDER BY source`, model)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (DataSource, error) {
		var d DataSource
		var sample []byte
		err := r.Scan(&d.ModelKey, &d.Source, &d.Desc, &d.Origin, &d.FirstSeen, &d.LastSeen, &d.Count, &sample)
		d.Sample = json.RawMessage(sample)
		return d, err
	})
}

// DeleteSource xoá một nguồn (ErrNotFound nếu không có). Ghép nối đang dùng nguồn đó do nơi gọi xử lý trước.
func (s *Store) DeleteSource(ctx context.Context, model, source string) error {
	tag, err := s.Pool.Exec(ctx, `DELETE FROM data_source WHERE model_key = $1 AND source = $2`, model, source)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
