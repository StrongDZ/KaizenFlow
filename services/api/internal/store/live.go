package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/kaizenflow/api/internal/live"
)

const bindingCols = `id, model_key, subject, signal, source, json_path, transform, enabled, mode, derive, false`

func scanBinding(r pgx.Row) (live.Binding, error) {
	var b live.Binding
	err := r.Scan(&b.ID, &b.ModelKey, &b.Subject, &b.Signal, &b.Source, &b.JSONPath, &b.Transform, &b.Enabled, &b.Mode, &b.Derive, &b.Shared)
	return b, err
}

// Ghép nối của THIẾT BỊ lưu một lần với model_key = '' và áp cho mọi mô hình có thiết bị đó;
// ghép nối của ĐƯỜNG NỐI vẫn thuộc một mô hình. Hai hàm đọc dưới đây trải hàng toàn cục ra theo
// mô hình, nên mọi phần còn lại (Normalize, coverage, estimate) không cần biết chuyện này.
const bindingGlobalCols = `b.id, $1::text, b.subject, b.signal, b.source, b.json_path, b.transform, b.enabled, b.mode, b.derive, true`

// nodeModels: cặp (mô hình, mã thiết bị) có thật trong sơ đồ của mô hình, mọi version.
const nodeModels = `SELECT DISTINCT v.model_key, n.key FROM node n JOIN model_version v ON v.id = n.model_version_id`

// ListBindings trả mọi mapping của một mô hình (kể cả đang tắt), gồm cả ghép nối thiết bị dùng chung.
func (s *Store) ListBindings(ctx context.Context, modelKey string) ([]live.Binding, error) {
	rows, err := s.Pool.Query(ctx, `WITH nm AS (`+nodeModels+`)
		SELECT `+bindingCols+` FROM data_binding WHERE model_key = $1
		UNION ALL
		SELECT `+bindingGlobalCols+` FROM data_binding b
		WHERE b.model_key = '' AND EXISTS (SELECT 1 FROM nm WHERE nm.model_key = $1 AND nm.key = b.subject)
		ORDER BY subject, signal`, modelKey)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (live.Binding, error) { return scanBinding(r) })
}

// ListAssetBindings trả ghép nối tín hiệu của thiết bị (toàn cục, không thuộc mô hình nào).
func (s *Store) ListAssetBindings(ctx context.Context) ([]live.Binding, error) {
	rows, err := s.Pool.Query(ctx, `SELECT id, model_key, subject, signal, source, json_path, transform, enabled, mode, derive, true
		FROM data_binding WHERE model_key = '' ORDER BY subject, signal`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (live.Binding, error) { return scanBinding(r) })
}

// ListStoredBindings trả mọi hàng ghép nối đúng như lưu, kể cả đang tắt: ghép nối thiết bị giữ model_key
// rỗng, không trải theo mô hình. Dùng khi cần thao tác trên chính các hàng, như xoá một nguồn ở mọi nơi.
func (s *Store) ListStoredBindings(ctx context.Context) ([]live.Binding, error) {
	rows, err := s.Pool.Query(ctx, `SELECT id, model_key, subject, signal, source, json_path, transform, enabled, mode, derive, model_key = ''
		FROM data_binding ORDER BY model_key, subject, signal`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (live.Binding, error) { return scanBinding(r) })
}

// AllBindings trả mapping đang bật của mọi mô hình (đường ingest dùng).
func (s *Store) AllBindings(ctx context.Context) ([]live.Binding, error) {
	rows, err := s.Pool.Query(ctx, `WITH nm AS (`+nodeModels+`)
		SELECT `+bindingCols+` FROM data_binding WHERE enabled AND model_key <> ''
		UNION ALL
		SELECT b.id, nm.model_key, b.subject, b.signal, b.source, b.json_path, b.transform, b.enabled, b.mode, b.derive, true
		FROM data_binding b JOIN nm ON nm.key = b.subject
		WHERE b.enabled AND b.model_key = ''
		ORDER BY id`)
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
			// Tín hiệu của một thiết bị là thuộc tính của thiết bị, không của mô hình: ghép một lần,
			// mọi mô hình có thiết bị đó dùng chung. Chỉ ghép nối đường nối mới thuộc mô hình.
			var isAsset bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM asset WHERE key = $1)`, b.Subject).Scan(&isAsset); err != nil {
				return err
			}
			scope := modelKey
			if isAsset {
				scope = ""
			}
			if _, err := tx.Exec(ctx, `INSERT INTO data_binding (model_key, subject, signal, source, json_path, transform, enabled, mode, derive)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
				ON CONFLICT (model_key, subject, signal) DO UPDATE
				SET source = EXCLUDED.source, json_path = EXCLUDED.json_path, transform = EXCLUDED.transform, enabled = EXCLUDED.enabled,
				    mode = EXCLUDED.mode, derive = EXCLUDED.derive`,
				scope, b.Subject, b.Signal, b.Source, b.JSONPath, b.Transform, b.Enabled, b.Mode, b.Derive); err != nil {
				return err
			}
		}
		return nil
	})
}

// DeleteBinding xoá một mapping; id của mô hình khác thì coi như không có. Ghép nối thiết bị
// (toàn cục) xoá được từ trong mô hình, và khi đó mất ở mọi mô hình — đúng vì nó là của thiết bị.
func (s *Store) DeleteBinding(ctx context.Context, modelKey string, id int64) error {
	tag, err := s.Pool.Exec(ctx, `DELETE FROM data_binding WHERE id = $1 AND model_key IN ($2, '')`, id, modelKey)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteAllBindings xoá mọi mapping của một mô hình, trả số dòng đã xoá. Ghép nối thiết bị chỉ bị
// xoá khi thiết bị đó không còn mô hình nào khác dùng, để không làm mất cấu hình của mô hình khác.
func (s *Store) DeleteAllBindings(ctx context.Context, modelKey string) (int64, error) {
	var n int64
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM data_binding WHERE model_key = $1`, modelKey)
		if err != nil {
			return err
		}
		n = tag.RowsAffected()
		tag, err = tx.Exec(ctx, `WITH nm AS (`+nodeModels+`)
			DELETE FROM data_binding b WHERE b.model_key = ''
			  AND EXISTS (SELECT 1 FROM nm WHERE nm.model_key = $1 AND nm.key = b.subject)
			  AND NOT EXISTS (SELECT 1 FROM nm WHERE nm.model_key <> $1 AND nm.key = b.subject)`, modelKey)
		if err != nil {
			return err
		}
		n += tag.RowsAffected()
		return nil
	})
	return n, err
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

// assetKeys trả tập mã thiết bị (để biết một subject là thiết bị hay đường nối).
func (s *Store) assetKeys(ctx context.Context, q querier) (map[string]bool, error) {
	rows, err := q.Query(ctx, `SELECT key FROM asset`)
	if err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			rows.Close()
			return nil, err
		}
		out[k] = true
	}
	rows.Close()
	return out, rows.Err()
}

// InsertLive ghi một lô tín hiệu và sự kiện thật (run_id NULL).
//
// Tín hiệu của một THIẾT BỊ lưu một lần với model_key = '': nó là số đọc của chính cái máy, không
// phải của mô hình, nên hai mô hình dùng chung máy đó không được lưu hai bản (trước đây mỗi mô hình
// một bản, cùng giờ cùng giá trị). Tín hiệu của ĐƯỜNG NỐI vẫn theo mô hình vì đường nối chỉ tồn tại
// trong một bố trí. Ghép nối của thiết bị là duy nhất toàn cục nên các bản trùng luôn cùng giá trị.
func (s *Store) InsertLive(ctx context.Context, sigs []LiveSignal, evs []LiveEvent) error {
	if len(sigs) == 0 && len(evs) == 0 {
		return nil
	}
	return s.inTx(ctx, func(tx pgx.Tx) error {
		assets, err := s.assetKeys(ctx, tx)
		if err != nil {
			return err
		}
		if len(sigs) > 0 {
			seen := map[[3]string]bool{}
			rows := make([][]any, 0, len(sigs))
			for _, x := range sigs {
				model := x.Model
				if assets[x.Subject] {
					model = ""
					ref := [3]string{x.Subject, x.Name, x.Time.UTC().Format(time.RFC3339Nano)}
					if seen[ref] {
						continue
					}
					seen[ref] = true
				}
				rows = append(rows, []any{x.Time, model, x.Subject, x.Name, x.Value})
			}
			if _, err := tx.CopyFrom(ctx, pgx.Identifier{"signal"}, []string{"time", "model_key", "subject", "name", "value"},
				pgx.CopyFromRows(rows)); err != nil {
				return err
			}
		}
		if len(evs) > 0 {
			seen := map[[3]string]bool{}
			rows := make([][]any, 0, len(evs))
			for _, x := range evs {
				p := x.Payload
				if p == nil {
					p = map[string]any{}
				}
				model := x.Model
				if assets[x.Subject] {
					model = ""
					ref := [3]string{x.Subject, x.Type, x.Time.UTC().Format(time.RFC3339Nano)}
					if seen[ref] {
						continue
					}
					seen[ref] = true
				}
				rows = append(rows, []any{x.Time, model, x.Subject, x.Type, p})
			}
			if _, err := tx.CopyFrom(ctx, pgx.Identifier{"event_log"}, []string{"time", "model_key", "subject", "type", "payload"},
				pgx.CopyFromRows(rows)); err != nil {
				return err
			}
		}
		return nil
	})
}

// liveScope: hàng live thuộc mô hình $1 — của chính mô hình, cộng hàng toàn cục của các thiết bị
// đang nằm trong sơ đồ mô hình đó.
const liveScope = `(model_key = $1 OR (model_key = '' AND subject IN (
	SELECT n.key FROM node n JOIN model_version v ON v.id = n.model_version_id WHERE v.model_key = $1)))`

// LiveSignals đọc tín hiệu thật của một mô hình theo thời gian tăng dần.
func (s *Store) LiveSignals(ctx context.Context, model, subject, name string, since, until *time.Time, limit int) ([]SignalRow, error) {
	if limit <= 0 || limit > 20000 {
		limit = 20000
	}
	rows, err := s.Pool.Query(ctx, `SELECT time, subject, name, coalesce(value, 0) FROM signal
		WHERE run_id IS NULL AND `+liveScope+` AND ($2 = '' OR subject = $2) AND ($3 = '' OR name = $3)
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
		WHERE run_id IS NULL AND `+liveScope+` AND ($2 = '' OR subject = $2) ORDER BY time DESC LIMIT $3`, model, subject, limit)
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

// clearLiveTx xoá dữ liệu live của một mô hình: hàng của chính mô hình, cộng hàng toàn cục của các
// thiết bị mà KHÔNG mô hình nào khác đang dùng (xoá live của một mô hình không được làm mất dữ liệu
// thật của mô hình khác đang chạy trên cùng thiết bị đó).
func clearLiveTx(ctx context.Context, tx pgx.Tx, model string) error {
	for _, table := range []string{"signal", "event_log"} {
		if _, err := tx.Exec(ctx, `DELETE FROM `+table+` WHERE run_id IS NULL AND model_key = $1`, model); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `WITH nm AS (`+nodeModels+`)
			DELETE FROM `+table+` x WHERE x.run_id IS NULL AND x.model_key = ''
			  AND EXISTS (SELECT 1 FROM nm WHERE nm.model_key = $1 AND nm.key = x.subject)
			  AND NOT EXISTS (SELECT 1 FROM nm WHERE nm.model_key <> $1 AND nm.key = x.subject)`, model); err != nil {
			return err
		}
	}
	return nil
}

// deleteLiveConfig xoá mapping, nguồn dữ liệu, bản đồ AGV và dữ liệu live của một mô hình (gọi khi xoá mô hình).
func deleteLiveConfig(ctx context.Context, tx pgx.Tx, model string) error {
	// Nguồn dữ liệu KHÔNG bị xoá theo mô hình: nó là thiết bị/topic ngoài đời, mô hình khác còn dùng.
	for _, q := range []string{`DELETE FROM data_binding WHERE model_key = $1`, `DELETE FROM agv_map WHERE model_key = $1`, `DELETE FROM agv_map_image WHERE model_key = $1`} {
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
		WHERE run_id IS NULL AND `+liveScope+` AND subject = $2 AND name = $3 ORDER BY time DESC LIMIT $4`, model, subject, name, n)
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
	// ModelKey chỉ còn ở đường vào (feed cho biết lô thuộc mô hình nào); danh mục nguồn là toàn cục
	// nên trường này không được lưu và luôn trống khi đọc ra.
	ModelKey  string          `json:"model_key,omitempty"`
	Source    string          `json:"source"`
	Desc      string          `json:"desc"`
	Origin    string          `json:"origin"`
	FirstSeen time.Time       `json:"first_seen"`
	LastSeen  time.Time       `json:"last_seen"`
	Count     int64           `json:"count"`
	Sample    json.RawMessage `json:"sample"`
	// Models là các mô hình đang có ghép nối dùng nguồn này (chỉ đọc, suy từ ghép nối).
	Models []string `json:"models"`
}

// UpsertSources ghi một lô nguồn: cộng dồn số bản tin, giữ lần đầu thấy, cập nhật lần cuối và mẫu; mô tả rỗng không xoá mô tả cũ;
// nguồn đã khai báo tay vẫn là manual, và bản ghi manual mới chuyển nguồn tự ghi thành manual.
// Nguồn là một thiết bị/topic ngoài đời nên danh mục là TOÀN CỤC: `ModelKey` của mỗi dòng bị bỏ qua.
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
			if _, err := tx.Exec(ctx, `INSERT INTO data_source (source, description, origin, first_seen, last_seen, msg_count, sample)
				VALUES ($1, $2, $3, $4, $5, $6, $7)
				ON CONFLICT (source) DO UPDATE SET
				  description = CASE WHEN EXCLUDED.description <> '' THEN EXCLUDED.description ELSE data_source.description END,
				  origin      = CASE WHEN EXCLUDED.origin = 'manual' THEN 'manual' ELSE data_source.origin END,
				  first_seen  = LEAST(data_source.first_seen, EXCLUDED.first_seen),
				  last_seen   = GREATEST(data_source.last_seen, EXCLUDED.last_seen),
				  msg_count   = data_source.msg_count + EXCLUDED.msg_count,
				  sample      = COALESCE(EXCLUDED.sample, data_source.sample)`,
				d.Source, d.Desc, d.Origin, d.FirstSeen, d.LastSeen, d.Count, sample); err != nil {
				return err
			}
		}
		return nil
	})
}

const sourceCols = `d.source, d.description, d.origin, d.first_seen, d.last_seen, d.msg_count, d.sample`

func scanSource(r pgx.CollectableRow) (DataSource, error) {
	var d DataSource
	var sample []byte
	var models []string
	err := r.Scan(&d.Source, &d.Desc, &d.Origin, &d.FirstSeen, &d.LastSeen, &d.Count, &sample, &models)
	d.Sample = json.RawMessage(sample)
	if models == nil {
		models = []string{}
	}
	d.Models = models
	return d, err
}

// sourceUse: mô hình nào đang có ghép nối dùng nguồn nào. Ghép nối của thiết bị là toàn cục
// (model_key = '') nên phải quy về các mô hình đang chứa thiết bị đó.
// So khớp theo tên nguồn chính xác: ghép nối dùng ký tự thay thế (+, #) khớp lúc nhận bản tin
// (live.MatchSource) chứ không quy được ra SQL, nên nguồn chỉ khớp qua wildcard sẽ hiện là "chưa ghép".
const sourceUse = `used AS (
		SELECT b.source, b.model_key AS model FROM data_binding b WHERE b.model_key <> ''
		UNION
		SELECT b.source, v.model_key FROM data_binding b
		  JOIN node n ON n.key = b.subject JOIN model_version v ON v.id = n.model_version_id
		  WHERE b.model_key = ''
	), agg AS (
		SELECT source, array_agg(DISTINCT model ORDER BY model) AS models FROM used GROUP BY source
	)`

const sourceModels = `coalesce(a.models, '{}'::text[])`
const sourceFrom = `FROM data_source d LEFT JOIN agg a ON a.source = d.source`

// ListAllSources trả toàn bộ danh mục nguồn, kèm các mô hình đang dùng từng nguồn.
func (s *Store) ListAllSources(ctx context.Context) ([]DataSource, error) {
	rows, err := s.Pool.Query(ctx, `WITH `+sourceUse+`
		SELECT `+sourceCols+`, `+sourceModels+` `+sourceFrom+` ORDER BY d.source`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, scanSource)
}

// ListSources trả các nguồn liên quan tới một mô hình: nguồn đã được mô hình đó ghép nối (kể cả qua
// ghép nối thiết bị dùng chung), cộng các nguồn chưa ghép ở đâu cả — vì đó chính là những cái người
// dùng cần ghép tiếp. Nguồn đang thuộc riêng mô hình khác thì không hiện ở đây.
func (s *Store) ListSources(ctx context.Context, model string) ([]DataSource, error) {
	rows, err := s.Pool.Query(ctx, `WITH `+sourceUse+`
		SELECT `+sourceCols+`, `+sourceModels+` `+sourceFrom+`
		WHERE a.models IS NULL OR $1::text = ANY(a.models)
		ORDER BY d.source`, model)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, scanSource)
}

// DeleteSource xoá một nguồn khỏi danh mục (ErrNotFound nếu không có). Ghép nối đang dùng nguồn đó
// do nơi gọi xử lý trước. Nguồn là toàn cục nên xoá là xoá cho mọi mô hình.
func (s *Store) DeleteSource(ctx context.Context, source string) error {
	tag, err := s.Pool.Exec(ctx, `DELETE FROM data_source WHERE source = $1`, source)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
