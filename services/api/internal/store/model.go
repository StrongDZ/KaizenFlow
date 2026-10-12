package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

type Pos struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type GraphNode struct {
	Key       string         `json:"key"`
	NodeType  string         `json:"node_type"`
	Archetype string         `json:"archetype"`
	Name      string         `json:"name"`
	Params    map[string]any `json:"params"`
	CanvasPos *Pos           `json:"canvas_pos,omitempty"`
	// AssetParams là tham số của chính thiết bị, nằm dưới Params khi hợp nhất. Chỉ trả về với version
	// DRAFT: version đã Publish đã đông cứng tham số vào Params nên phải tự chứa, không đọc thiết bị nữa.
	AssetParams map[string]any `json:"asset_params,omitempty"`
	// AssetRetired: thiết bị đã đánh dấu ngừng dùng (sơ đồ hiển thị để biết cần thay).
	AssetRetired bool `json:"asset_retired,omitempty"`
}

type GraphEdge struct {
	Key      string         `json:"key"`
	Src      string         `json:"src"`
	Dst      string         `json:"dst"`
	Material string         `json:"material"`
	Params   map[string]any `json:"params"`
}

type Graph struct {
	VersionID            int64                      `json:"version_id"`
	ModelKey             string                     `json:"model_key"`
	Version              int                        `json:"version"`
	Status               string                     `json:"status"`
	Settings             map[string]any             `json:"settings"`
	Nodes                []GraphNode                `json:"nodes"`
	Edges                []GraphEdge                `json:"edges"`
	WarehouseCapacities  map[string]map[string]float64 `json:"warehouse_capacities,omitempty"`
	ProcessIOContracts   map[string]any             `json:"process_io_contracts,omitempty"`
}

type ModelSummary struct {
	ModelKey        string     `json:"model_key"`
	LatestVersionID int64      `json:"latest_version_id"`
	LatestVersion   int        `json:"latest_version"`
	Status          string     `json:"status"`
	Scenarios       int        `json:"scenarios"`
	Runs            int        `json:"runs"`
	LastRunAt       *time.Time `json:"last_run_at"`
}

type VersionInfo struct {
	ID        int64     `json:"id"`
	Version   int       `json:"version"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
	Nodes     int       `json:"nodes"`
	Scenarios int       `json:"scenarios"`
}

func (s *Store) CreateModel(ctx context.Context, key string, settings map[string]any) (int64, error) {
	if settings == nil {
		settings = map[string]any{}
	}
	var id int64
	err := s.Pool.QueryRow(ctx, `INSERT INTO model_version (model_key, version, settings) VALUES ($1, 1, $2) RETURNING id`,
		key, settings).Scan(&id)
	if isUnique(err) {
		return 0, &RefError{key, "Mô hình này đã tồn tại. Chọn tên khác."}
	}
	return id, err
}

func (s *Store) ListModels(ctx context.Context) ([]ModelSummary, error) {
	rows, err := s.Pool.Query(ctx, `WITH latest AS (
			SELECT DISTINCT ON (model_key) model_key, id, version, status FROM model_version ORDER BY model_key, version DESC
		)
		SELECT l.model_key, l.id, l.version, l.status,
		  (SELECT count(*) FROM scenario s JOIN model_version v ON v.id = s.model_version_id WHERE v.model_key = l.model_key),
		  (SELECT count(*) FROM sim_run r JOIN scenario s ON s.id = r.scenario_id
		     JOIN model_version v ON v.id = s.model_version_id WHERE v.model_key = l.model_key),
		  (SELECT max(r.created_at) FROM sim_run r JOIN scenario s ON s.id = r.scenario_id
		     JOIN model_version v ON v.id = s.model_version_id WHERE v.model_key = l.model_key)
		FROM latest l ORDER BY l.model_key`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (ModelSummary, error) {
		var m ModelSummary
		err := r.Scan(&m.ModelKey, &m.LatestVersionID, &m.LatestVersion, &m.Status, &m.Scenarios, &m.Runs, &m.LastRunAt)
		return m, err
	})
}

func (s *Store) ListVersions(ctx context.Context, key string) ([]VersionInfo, error) {
	rows, err := s.Pool.Query(ctx, `SELECT v.id, v.version, v.status, v.created_at,
		(SELECT count(*) FROM node n WHERE n.model_version_id = v.id),
		(SELECT count(*) FROM scenario s WHERE s.model_version_id = v.id)
		FROM model_version v WHERE v.model_key = $1 ORDER BY v.version`, key)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (VersionInfo, error) {
		var v VersionInfo
		err := r.Scan(&v.ID, &v.Version, &v.Status, &v.CreatedAt, &v.Nodes, &v.Scenarios)
		return v, err
	})
}

func (s *Store) GetGraph(ctx context.Context, id int64) (*Graph, error) {
	g := &Graph{VersionID: id, Nodes: []GraphNode{}, Edges: []GraphEdge{}}
	err := s.Pool.QueryRow(ctx, `SELECT model_key, version, status, settings FROM model_version WHERE id = $1`, id).
		Scan(&g.ModelKey, &g.Version, &g.Status, &g.Settings)
	if err != nil {
		return nil, notFound(err)
	}
	// Loại, vai trò và tên của node đến từ THIẾT BỊ (node không giữ bản sao nào nữa).
	// Tham số thiết bị chỉ ghép vào bản DRAFT; bản đã Publish đã đông cứng nên tự chứa.
	rows, err := s.Pool.Query(ctx, `SELECT n.key, t.code, t.archetype::text, a.name, n.params, n.canvas_pos,
		CASE WHEN $2 = 'DRAFT' THEN a.params ELSE '{}'::jsonb END, a.retired
		FROM node n JOIN asset a ON a.key = n.key JOIN node_type t ON t.id = a.node_type_id
		WHERE n.model_version_id = $1 ORDER BY n.id`, id, g.Status)
	if err != nil {
		return nil, err
	}
	g.Nodes, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (GraphNode, error) {
		var n GraphNode
		err := r.Scan(&n.Key, &n.NodeType, &n.Archetype, &n.Name, &n.Params, &n.CanvasPos,
			&n.AssetParams, &n.AssetRetired)
		return n, err
	})
	if err != nil {
		return nil, err
	}
	rows, err = s.Pool.Query(ctx, `SELECT e.key, sn.key, dn.key, coalesce(m.code, ''), e.params
		FROM edge e JOIN node sn ON sn.id = e.src_node_id JOIN node dn ON dn.id = e.dst_node_id
		LEFT JOIN material m ON m.id = e.material_id WHERE e.model_version_id = $1 ORDER BY e.id`, id)
	if err != nil {
		return nil, err
	}
	g.Edges, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (GraphEdge, error) {
		var e GraphEdge
		err := r.Scan(&e.Key, &e.Src, &e.Dst, &e.Material, &e.Params)
		return e, err
	})
	return g, err
}

// ReplaceGraph thay toàn bộ node/edge của một version DRAFT trong một transaction.
func (s *Store) ReplaceGraph(ctx context.Context, id int64, nodes []GraphNode, edges []GraphEdge, settings map[string]any) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var status string
	if err := tx.QueryRow(ctx, `SELECT status FROM model_version WHERE id = $1 FOR UPDATE`, id).Scan(&status); err != nil {
		return notFound(err)
	}
	if status != "DRAFT" {
		return ErrNotDraft
	}
	type typeRef struct {
		id        int64
		archetype string
	}
	types := map[string]typeRef{}
	rows, err := tx.Query(ctx, `SELECT id, code, archetype::text FROM node_type`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var t typeRef
		var code string
		if err := rows.Scan(&t.id, &code, &t.archetype); err != nil {
			return err
		}
		types[code] = t
	}
	rows.Close()
	// Node của sơ đồ phải là một thiết bị đã có trong danh mục Thiết bị: sơ đồ chỉ ĐẶT thiết bị,
	// không khai sinh thiết bị. Nhờ vậy mã node là duy nhất toàn app và dùng lại được ở mô hình khác.
	assetType := map[string]string{}
	rows, err = tx.Query(ctx, `SELECT a.key, t.code FROM asset a JOIN node_type t ON t.id = a.node_type_id`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var key, code string
		if err := rows.Scan(&key, &code); err != nil {
			return err
		}
		assetType[key] = code
	}
	rows.Close()
	mats := map[string]int64{}
	rows, err = tx.Query(ctx, `SELECT id, code FROM material`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var mid int64
		var code string
		if err := rows.Scan(&mid, &code); err != nil {
			return err
		}
		mats[code] = mid
	}
	rows.Close()
	for _, q := range []string{`DELETE FROM edge WHERE model_version_id = $1`, `DELETE FROM node WHERE model_version_id = $1`} {
		if _, err := tx.Exec(ctx, q, id); err != nil {
			return err
		}
	}
	nodeIDs := map[string]int64{}
	for _, n := range nodes {
		if _, dup := nodeIDs[n.Key]; dup || n.Key == "" {
			return &RefError{n.Key, "Mã node bị trùng hoặc để trống."}
		}
		code, known := assetType[n.Key]
		if !known {
			return &RefError{n.Key, "Chưa có thiết bị '" + n.Key + "' trong danh mục Thiết bị. Tạo thiết bị trước rồi đặt nó lên sơ đồ."}
		}
		// Loại node do danh mục Thiết bị quyết định; sơ đồ gửi loại khác là đang lệch dữ liệu.
		if n.NodeType != "" && n.NodeType != code {
			return &RefError{n.Key, "Thiết bị '" + n.Key + "' là loại " + code + ", không phải " + n.NodeType +
				". Đổi loại ở danh mục Thiết bị, hoặc chọn thiết bị khác."}
		}
		if _, ok := types[code]; !ok {
			return &RefError{n.Key, "Loại node '" + code + "' không còn trong Thư viện."}
		}
		params := n.Params
		if params == nil {
			params = map[string]any{}
		}
		var nid int64
		// Node chỉ còn: thuộc version nào, là thiết bị nào, override gì, nằm đâu trên sơ đồ.
		// Tên và loại không ghi lại ở đây — chúng thuộc thiết bị.
		if err := tx.QueryRow(ctx, `INSERT INTO node (model_version_id, key, params, canvas_pos)
			VALUES ($1, $2, $3, $4) RETURNING id`, id, n.Key, params, n.CanvasPos).Scan(&nid); err != nil {
			return err
		}
		nodeIDs[n.Key] = nid
	}
	seen := map[string]bool{}
	for _, e := range edges {
		if seen[e.Key] || e.Key == "" {
			return &RefError{e.Key, "Mã đường nối bị trùng hoặc để trống."}
		}
		seen[e.Key] = true
		src, ok1 := nodeIDs[e.Src]
		dst, ok2 := nodeIDs[e.Dst]
		if !ok1 || !ok2 {
			return &RefError{e.Key, "Đường nối trỏ tới node không còn trong sơ đồ ('" + e.Src + "' hoặc '" + e.Dst + "')."}
		}
		var mat *int64
		if e.Material != "" {
			mid, ok := mats[e.Material]
			if !ok {
				return &RefError{e.Key, "Vật tư '" + e.Material + "' chưa có trong Thư viện."}
			}
			mat = &mid
		}
		params := e.Params
		if params == nil {
			params = map[string]any{}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO edge (model_version_id, key, src_node_id, dst_node_id, material_id, params)
			VALUES ($1, $2, $3, $4, $5, $6)`, id, e.Key, src, dst, mat, params); err != nil {
			return err
		}
	}
	if settings != nil {
		if _, err := tx.Exec(ctx, `UPDATE model_version SET settings = $2 WHERE id = $1`, id, settings); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// Publish khoá một version lại. Trước khi khoá, tham số hiệu lực của từng thiết bị được ĐÔNG CỨNG
// vào node (freeze): bản đã Publish phải bất biến, nên sau này sửa thiết bị trong danh mục Thiết bị
// không được làm đổi đầu vào của bản này. `freeze` do nơi gọi truyền vào (đã hợp nhất sâu bằng
// resolve), map rỗng nghĩa là node đó không có gì phải đông cứng.
func (s *Store) Publish(ctx context.Context, id int64, freeze map[string]map[string]any) error {
	var done bool
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		var status string
		if err := tx.QueryRow(ctx, `SELECT status FROM model_version WHERE id = $1 FOR UPDATE`, id).Scan(&status); err != nil {
			return notFound(err)
		}
		if status != "DRAFT" {
			return nil // đã Publish hoặc đã Archive từ trước: trả ErrNotDraft phía dưới
		}
		done = true
		for key, params := range freeze {
			if len(params) == 0 {
				continue
			}
			if _, err := tx.Exec(ctx, `UPDATE node SET params = $3 WHERE model_version_id = $1 AND key = $2`,
				id, key, params); err != nil {
				return err
			}
		}
		_, err := tx.Exec(ctx, `UPDATE model_version SET status = 'PUBLISHED' WHERE id = $1 AND status = 'DRAFT'`, id)
		return err
	})
	if err != nil {
		return err
	}
	if done {
		return nil
	}
	return ErrNotDraft
}

// Clone tạo version DRAFT mới (version+1) với cùng node/edge/settings.
func (s *Store) Clone(ctx context.Context, id int64) (int64, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	var newID int64
	err = tx.QueryRow(ctx, `INSERT INTO model_version (model_key, version, settings)
		SELECT model_key, (SELECT max(version) + 1 FROM model_version m2 WHERE m2.model_key = m.model_key), settings
		FROM model_version m WHERE id = $1 RETURNING id`, id).Scan(&newID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO node (model_version_id, key, params, canvas_pos)
		SELECT $2, key, params, canvas_pos FROM node WHERE model_version_id = $1`, id, newID); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO edge (model_version_id, key, src_node_id, src_port, dst_node_id, dst_port, material_id, params)
		SELECT $2, e.key, ns.id, e.src_port, nd.id, e.dst_port, e.material_id, e.params FROM edge e
		JOIN node os ON os.id = e.src_node_id JOIN node ns ON ns.model_version_id = $2 AND ns.key = os.key
		JOIN node od ON od.id = e.dst_node_id JOIN node nd ON nd.model_version_id = $2 AND nd.key = od.key
		WHERE e.model_version_id = $1`, id, newID); err != nil {
		return 0, err
	}
	return newID, tx.Commit(ctx)
}
