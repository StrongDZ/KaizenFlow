package store

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
)

type NodeType struct {
	ID            int64           `json:"id"`
	Code          string          `json:"code"`
	Name          string          `json:"name"`
	Archetype     string          `json:"archetype"`
	ParamSchema   json.RawMessage `json:"param_schema"`
	DefaultParams json.RawMessage `json:"default_params"`
	Signals       json.RawMessage `json:"signals"`
	FailureModes  json.RawMessage `json:"failure_modes"`
	UI            json.RawMessage `json:"ui"`
	IsBuiltin     bool            `json:"is_builtin"` // nạp từ bộ mẫu ban đầu; chỉ là nhãn nguồn gốc, không khoá gì
}

type Material struct {
	ID   int64  `json:"id"`
	Code string `json:"code"`
	Name string `json:"name"`
	Unit string `json:"unit"`
}

func orJSON(r json.RawMessage, def string) json.RawMessage {
	if len(r) == 0 {
		return json.RawMessage(def)
	}
	return r
}

func (s *Store) ListNodeTypes(ctx context.Context) ([]NodeType, error) {
	rows, err := s.Pool.Query(ctx, `SELECT id, code, name, archetype::text, param_schema, default_params,
		signals, failure_modes, ui, is_builtin FROM node_type ORDER BY archetype, code`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (NodeType, error) {
		var t NodeType
		err := r.Scan(&t.ID, &t.Code, &t.Name, &t.Archetype, &t.ParamSchema, &t.DefaultParams,
			&t.Signals, &t.FailureModes, &t.UI, &t.IsBuiltin)
		return t, err
	})
}

func (s *Store) NodeTypes(ctx context.Context) (map[string]NodeType, error) {
	list, err := s.ListNodeTypes(ctx)
	if err != nil {
		return nil, err
	}
	out := make(map[string]NodeType, len(list))
	for _, t := range list {
		out[t.Code] = t
	}
	return out, nil
}

func (s *Store) CreateNodeType(ctx context.Context, t NodeType) (int64, error) {
	var id int64
	err := s.Pool.QueryRow(ctx, `INSERT INTO node_type
		(code, name, archetype, param_schema, default_params, signals, failure_modes, ui, is_builtin)
		VALUES ($1, $2, $3::archetype, $4, $5, $6, $7, $8, false) RETURNING id`,
		t.Code, t.Name, t.Archetype, t.ParamSchema, orJSON(t.DefaultParams, "{}"), orJSON(t.Signals, "[]"),
		orJSON(t.FailureModes, "[]"), orJSON(t.UI, "{}")).Scan(&id)
	if isUnique(err) {
		return 0, &RefError{t.Code, "node type already exists"}
	}
	return id, err
}

func (s *Store) ListMaterials(ctx context.Context) ([]Material, error) {
	rows, err := s.Pool.Query(ctx, `SELECT id, code, coalesce(name, ''), unit FROM material ORDER BY code`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Material, error) {
		var m Material
		err := r.Scan(&m.ID, &m.Code, &m.Name, &m.Unit)
		return m, err
	})
}

func (s *Store) MaterialCodes(ctx context.Context) ([]string, error) {
	list, err := s.ListMaterials(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]string, len(list))
	for i, m := range list {
		out[i] = m.Code
	}
	return out, nil
}

func (s *Store) CreateMaterial(ctx context.Context, m Material) (int64, error) {
	if m.Unit == "" {
		m.Unit = "pcs"
	}
	var id int64
	err := s.Pool.QueryRow(ctx, `INSERT INTO material (code, name, unit) VALUES ($1, $2, $3) RETURNING id`,
		m.Code, m.Name, m.Unit).Scan(&id)
	if isUnique(err) {
		return 0, &RefError{m.Code, "material already exists"}
	}
	return id, err
}

// NodeTypeRow là node type kèm số version đang dùng nó (mọi trạng thái).
type NodeTypeRow struct {
	NodeType
	UsedInVersions int `json:"used_in_versions"`
}

// VersionUse là một version dùng một node type hoặc vật tư.
type VersionUse struct {
	VersionID int64  `json:"version_id"`
	ModelKey  string `json:"model_key"`
	Version   int    `json:"version"`
	Status    string `json:"status"`
	Nodes     int    `json:"nodes"`
}

type NodeTypeUsage struct {
	Versions []VersionUse `json:"versions"`
	// Assets là các thiết bị trong danh mục Thiết bị đang mang loại này; còn thiết bị thì chưa xoá được loại.
	Assets []string `json:"assets"`
}

type NodeTypeDetail struct {
	NodeType
	Usage NodeTypeUsage `json:"usage"`
}

func (s *Store) ListNodeTypeRows(ctx context.Context) ([]NodeTypeRow, error) {
	rows, err := s.Pool.Query(ctx, `SELECT t.id, t.code, t.name, t.archetype::text, t.param_schema, t.default_params,
		t.signals, t.failure_modes, t.ui, t.is_builtin,
		(SELECT count(DISTINCT n.model_version_id) FROM node n JOIN asset a ON a.key = n.key WHERE a.node_type_id = t.id)
		FROM node_type t ORDER BY t.archetype, t.code`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (NodeTypeRow, error) {
		var t NodeTypeRow
		err := r.Scan(&t.ID, &t.Code, &t.Name, &t.Archetype, &t.ParamSchema, &t.DefaultParams,
			&t.Signals, &t.FailureModes, &t.UI, &t.IsBuiltin, &t.UsedInVersions)
		return t, err
	})
}

type querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

func nodeTypeUsage(ctx context.Context, q querier, code string) ([]VersionUse, error) {
	rows, err := q.Query(ctx, `SELECT v.id, v.model_key, v.version, v.status, count(n.id)
		FROM node n JOIN asset a ON a.key = n.key JOIN node_type t ON t.id = a.node_type_id
		  JOIN model_version v ON v.id = n.model_version_id
		WHERE t.code = $1 GROUP BY v.id ORDER BY v.model_key, v.version`, code)
	if err != nil {
		return nil, err
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (VersionUse, error) {
		var u VersionUse
		err := r.Scan(&u.VersionID, &u.ModelKey, &u.Version, &u.Status, &u.Nodes)
		return u, err
	})
	if list == nil {
		list = []VersionUse{}
	}
	return list, err
}

// nodeTypeAssets trả mã các thiết bị đang mang loại node này.
func nodeTypeAssets(ctx context.Context, q querier, code string) ([]string, error) {
	rows, err := q.Query(ctx, `SELECT a.key FROM asset a JOIN node_type t ON t.id = a.node_type_id
		WHERE t.code = $1 ORDER BY a.key`, code)
	if err != nil {
		return nil, err
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (string, error) {
		var k string
		err := r.Scan(&k)
		return k, err
	})
	if list == nil {
		list = []string{}
	}
	return list, err
}

func (s *Store) GetNodeTypeDetail(ctx context.Context, code string) (*NodeTypeDetail, error) {
	var d NodeTypeDetail
	err := s.Pool.QueryRow(ctx, `SELECT id, code, name, archetype::text, param_schema, default_params, signals,
		failure_modes, ui, is_builtin FROM node_type WHERE code = $1`, code).
		Scan(&d.ID, &d.Code, &d.Name, &d.Archetype, &d.ParamSchema, &d.DefaultParams, &d.Signals, &d.FailureModes, &d.UI, &d.IsBuiltin)
	if err != nil {
		return nil, notFound(err)
	}
	if d.Usage.Versions, err = nodeTypeUsage(ctx, s.Pool, code); err != nil {
		return nil, err
	}
	d.Usage.Assets, err = nodeTypeAssets(ctx, s.Pool, code)
	return &d, err
}

// MaterialRow là vật tư kèm số version đang dùng nó (qua edge hoặc chuỗi mã trong tham số node).
type MaterialRow struct {
	Material
	UsedInVersions int `json:"used_in_versions"`
}

type MaterialEdgeUse struct {
	VersionID int64  `json:"version_id"`
	ModelKey  string `json:"model_key"`
	Version   int    `json:"version"`
	Key       string `json:"key"`
	Src       string `json:"src"`
	Dst       string `json:"dst"`
}

type MaterialNodeUse struct {
	VersionID int64  `json:"version_id"`
	ModelKey  string `json:"model_key"`
	Version   int    `json:"version"`
	Key       string `json:"key"`
	NodeType  string `json:"node_type"`
}

type MaterialUsage struct {
	Edges     []MaterialEdgeUse `json:"edges"`
	Nodes     []MaterialNodeUse `json:"nodes"`
	NodeTypes []string          `json:"node_types"`
}

type MaterialDetail struct {
	Material
	Usage MaterialUsage `json:"usage"`
}

// Vật tư được tham chiếu theo mã bằng chuỗi JSON (lots, stock, recipes, demand), không có khoá ngoại,
// nên "đang dùng" phải quét cả JSON. position(...) khớp chuỗi chính xác (LIKE coi "_" là ký tự đại diện).
func (s *Store) ListMaterialRows(ctx context.Context) ([]MaterialRow, error) {
	rows, err := s.Pool.Query(ctx, `SELECT m.id, m.code, coalesce(m.name, ''), m.unit,
		(SELECT count(DISTINCT u.v) FROM (
			SELECT e.model_version_id AS v FROM edge e WHERE e.material_id = m.id
			UNION ALL
			SELECT n.model_version_id FROM node n WHERE position('"' || m.code || '"' in n.params::text) > 0
		) u)
		FROM material m ORDER BY m.code`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (MaterialRow, error) {
		var m MaterialRow
		err := r.Scan(&m.ID, &m.Code, &m.Name, &m.Unit, &m.UsedInVersions)
		return m, err
	})
}

func (s *Store) GetMaterialDetail(ctx context.Context, code string) (*MaterialDetail, error) {
	var d MaterialDetail
	err := s.Pool.QueryRow(ctx, `SELECT id, code, coalesce(name, ''), unit FROM material WHERE code = $1`, code).
		Scan(&d.ID, &d.Code, &d.Name, &d.Unit)
	if err != nil {
		return nil, notFound(err)
	}
	rows, err := s.Pool.Query(ctx, `SELECT v.id, v.model_key, v.version, e.key, sn.key, dn.key
		FROM edge e JOIN model_version v ON v.id = e.model_version_id
		JOIN node sn ON sn.id = e.src_node_id JOIN node dn ON dn.id = e.dst_node_id
		WHERE e.material_id = $1 ORDER BY v.model_key, v.version, e.key`, d.ID)
	if err != nil {
		return nil, err
	}
	if d.Usage.Edges, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (MaterialEdgeUse, error) {
		var u MaterialEdgeUse
		err := r.Scan(&u.VersionID, &u.ModelKey, &u.Version, &u.Key, &u.Src, &u.Dst)
		return u, err
	}); err != nil {
		return nil, err
	}
	rows, err = s.Pool.Query(ctx, `SELECT v.id, v.model_key, v.version, n.key, t.code
		FROM node n JOIN model_version v ON v.id = n.model_version_id
		  JOIN asset a ON a.key = n.key JOIN node_type t ON t.id = a.node_type_id
		WHERE position('"' || $1::text || '"' in n.params::text) > 0 ORDER BY v.model_key, v.version, n.key`, code)
	if err != nil {
		return nil, err
	}
	if d.Usage.Nodes, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (MaterialNodeUse, error) {
		var u MaterialNodeUse
		err := r.Scan(&u.VersionID, &u.ModelKey, &u.Version, &u.Key, &u.NodeType)
		return u, err
	}); err != nil {
		return nil, err
	}
	rows, err = s.Pool.Query(ctx, `SELECT code FROM node_type
		WHERE position('"' || $1::text || '"' in default_params::text) > 0 ORDER BY code`, code)
	if err != nil {
		return nil, err
	}
	if d.Usage.NodeTypes, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (string, error) {
		var c string
		return c, r.Scan(&c)
	}); err != nil {
		return nil, err
	}
	if d.Usage.Edges == nil {
		d.Usage.Edges = []MaterialEdgeUse{}
	}
	if d.Usage.Nodes == nil {
		d.Usage.Nodes = []MaterialNodeUse{}
	}
	if d.Usage.NodeTypes == nil {
		d.Usage.NodeTypes = []string{}
	}
	return &d, nil
}

// NodeTypeUpdate: trường nil/rỗng nghĩa là giữ nguyên giá trị hiện có.
type NodeTypeUpdate struct {
	Name          string
	DefaultParams json.RawMessage
	Signals       json.RawMessage
	FailureModes  json.RawMessage
	UI            json.RawMessage
}

func jsonOrNil(r json.RawMessage) any {
	if len(r) == 0 {
		return nil
	}
	return string(r)
}

func (s *Store) UpdateNodeType(ctx context.Context, code string, u NodeTypeUpdate) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		var id int64
		if err := tx.QueryRow(ctx, `SELECT id FROM node_type WHERE code = $1 FOR UPDATE`, code).Scan(&id); err != nil {
			return notFound(err)
		}
		var frozen int
		if err := tx.QueryRow(ctx, `SELECT count(DISTINCT v.id) FROM node n JOIN model_version v ON v.id = n.model_version_id
			JOIN asset a ON a.key = n.key
			WHERE a.node_type_id = $1 AND v.status <> 'DRAFT'`, id).Scan(&frozen); err != nil {
			return err
		}
		if frozen > 0 {
			usage, err := nodeTypeUsage(ctx, tx, code)
			if err != nil {
				return err
			}
			return &LockedError{Msg: "node type đang được version đã Publish dùng nên không sửa được, hãy nhân bản", Usage: NodeTypeUsage{Versions: usage}}
		}
		_, err := tx.Exec(ctx, `UPDATE node_type SET name = $2, default_params = coalesce($3::jsonb, default_params),
			signals = coalesce($4::jsonb, signals), failure_modes = coalesce($5::jsonb, failure_modes), ui = coalesce($6::jsonb, ui)
			WHERE id = $1`, id, u.Name, jsonOrNil(u.DefaultParams), jsonOrNil(u.Signals), jsonOrNil(u.FailureModes), jsonOrNil(u.UI))
		return err
	})
}

func (s *Store) DeleteNodeType(ctx context.Context, code string) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		var id int64
		if err := tx.QueryRow(ctx, `SELECT id FROM node_type WHERE code = $1 FOR UPDATE`, code).Scan(&id); err != nil {
			return notFound(err)
		}
		usage, err := nodeTypeUsage(ctx, tx, code)
		if err != nil {
			return err
		}
		if len(usage) > 0 {
			return &LockedError{Msg: "node type đang được dùng nên không xoá được", Usage: NodeTypeUsage{Versions: usage}}
		}
		assets, err := nodeTypeAssets(ctx, tx, code)
		if err != nil {
			return err
		}
		if len(assets) > 0 {
			return &LockedError{Msg: "Còn thiết bị mang loại này trong danh mục Thiết bị nên chưa xoá được loại. Xoá hoặc đổi loại các thiết bị đó trước.",
				Usage: NodeTypeUsage{Versions: usage, Assets: assets}}
		}
		_, err = tx.Exec(ctx, `DELETE FROM node_type WHERE id = $1`, id)
		return err
	})
}

// materialCounts đếm nơi dùng một vật tư (spec §6.2): edge, chuỗi mã trong node.params, chuỗi mã trong node_type.default_params.
func materialCounts(ctx context.Context, tx pgx.Tx, id int64, code string) (edges, nodes, types int, err error) {
	err = tx.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM edge WHERE material_id = $1),
		(SELECT count(*) FROM node WHERE position('"' || $2::text || '"' in params::text) > 0),
		(SELECT count(*) FROM node_type WHERE position('"' || $2::text || '"' in default_params::text) > 0)`,
		id, code).Scan(&edges, &nodes, &types)
	return
}

func materialLocked(msg string, edges, nodes, types int) *LockedError {
	return &LockedError{Msg: msg, Usage: map[string]int{"edges": edges, "nodes": nodes, "node_types": types}}
}

func (s *Store) UpdateMaterial(ctx context.Context, code, name string, unit *string) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		var id int64
		var cur string
		if err := tx.QueryRow(ctx, `SELECT id, unit FROM material WHERE code = $1 FOR UPDATE`, code).Scan(&id, &cur); err != nil {
			return notFound(err)
		}
		newUnit := cur
		if unit != nil && *unit != "" && *unit != cur {
			e, n, t, err := materialCounts(ctx, tx, id, code)
			if err != nil {
				return err
			}
			if e+n+t > 0 {
				return materialLocked("vật tư đang được dùng nên không đổi được đơn vị", e, n, t)
			}
			newUnit = *unit
		}
		_, err := tx.Exec(ctx, `UPDATE material SET name = $2, unit = $3 WHERE id = $1`, id, name, newUnit)
		return err
	})
}

func (s *Store) DeleteMaterial(ctx context.Context, code string) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		var id int64
		if err := tx.QueryRow(ctx, `SELECT id FROM material WHERE code = $1 FOR UPDATE`, code).Scan(&id); err != nil {
			return notFound(err)
		}
		e, n, t, err := materialCounts(ctx, tx, id, code)
		if err != nil {
			return err
		}
		if e+n+t > 0 {
			return materialLocked("vật tư đang được dùng nên không xoá được", e, n, t)
		}
		_, err = tx.Exec(ctx, `DELETE FROM material WHERE id = $1`, id)
		return err
	})
}
