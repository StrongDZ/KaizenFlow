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
}

type GraphEdge struct {
	Key      string         `json:"key"`
	Src      string         `json:"src"`
	Dst      string         `json:"dst"`
	Material string         `json:"material"`
	Params   map[string]any `json:"params"`
}

type Graph struct {
	VersionID int64          `json:"version_id"`
	ModelKey  string         `json:"model_key"`
	Version   int            `json:"version"`
	Status    string         `json:"status"`
	Settings  map[string]any `json:"settings"`
	Nodes     []GraphNode    `json:"nodes"`
	Edges     []GraphEdge    `json:"edges"`
}

type ModelSummary struct {
	ModelKey        string `json:"model_key"`
	LatestVersionID int64  `json:"latest_version_id"`
	LatestVersion   int    `json:"latest_version"`
	Status          string `json:"status"`
}

type VersionInfo struct {
	ID        int64     `json:"id"`
	Version   int       `json:"version"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
}

func (s *Store) CreateModel(ctx context.Context, key string, settings map[string]any) (int64, error) {
	if settings == nil {
		settings = map[string]any{}
	}
	var id int64
	err := s.Pool.QueryRow(ctx, `INSERT INTO model_version (model_key, version, settings) VALUES ($1, 1, $2) RETURNING id`,
		key, settings).Scan(&id)
	if isUnique(err) {
		return 0, &RefError{key, "model already exists"}
	}
	return id, err
}

func (s *Store) ListModels(ctx context.Context) ([]ModelSummary, error) {
	rows, err := s.Pool.Query(ctx, `SELECT DISTINCT ON (model_key) model_key, id, version, status
		FROM model_version ORDER BY model_key, version DESC`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (ModelSummary, error) {
		var m ModelSummary
		err := r.Scan(&m.ModelKey, &m.LatestVersionID, &m.LatestVersion, &m.Status)
		return m, err
	})
}

func (s *Store) ListVersions(ctx context.Context, key string) ([]VersionInfo, error) {
	rows, err := s.Pool.Query(ctx, `SELECT id, version, status, created_at FROM model_version
		WHERE model_key = $1 ORDER BY version`, key)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (VersionInfo, error) {
		var v VersionInfo
		err := r.Scan(&v.ID, &v.Version, &v.Status, &v.CreatedAt)
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
	rows, err := s.Pool.Query(ctx, `SELECT n.key, t.code, n.archetype::text, coalesce(n.name, ''), n.params, n.canvas_pos
		FROM node n JOIN node_type t ON t.id = n.node_type_id WHERE n.model_version_id = $1 ORDER BY n.id`, id)
	if err != nil {
		return nil, err
	}
	g.Nodes, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (GraphNode, error) {
		var n GraphNode
		err := r.Scan(&n.Key, &n.NodeType, &n.Archetype, &n.Name, &n.Params, &n.CanvasPos)
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
		t, ok := types[n.NodeType]
		if !ok {
			return &RefError{n.Key, "unknown node type '" + n.NodeType + "'"}
		}
		if _, dup := nodeIDs[n.Key]; dup || n.Key == "" {
			return &RefError{n.Key, "duplicate or empty node key"}
		}
		params := n.Params
		if params == nil {
			params = map[string]any{}
		}
		var nid int64
		if err := tx.QueryRow(ctx, `INSERT INTO node (model_version_id, key, node_type_id, archetype, name, params, canvas_pos)
			VALUES ($1, $2, $3, $4::archetype, $5, $6, $7) RETURNING id`,
			id, n.Key, t.id, t.archetype, n.Name, params, n.CanvasPos).Scan(&nid); err != nil {
			return err
		}
		nodeIDs[n.Key] = nid
	}
	seen := map[string]bool{}
	for _, e := range edges {
		if seen[e.Key] || e.Key == "" {
			return &RefError{e.Key, "duplicate or empty edge key"}
		}
		seen[e.Key] = true
		src, ok1 := nodeIDs[e.Src]
		dst, ok2 := nodeIDs[e.Dst]
		if !ok1 || !ok2 {
			return &RefError{e.Key, "unknown node '" + e.Src + "' or '" + e.Dst + "'"}
		}
		var mat *int64
		if e.Material != "" {
			mid, ok := mats[e.Material]
			if !ok {
				return &RefError{e.Key, "unknown material '" + e.Material + "'"}
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

func (s *Store) Publish(ctx context.Context, id int64) error {
	tag, err := s.Pool.Exec(ctx, `UPDATE model_version SET status = 'PUBLISHED' WHERE id = $1 AND status = 'DRAFT'`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 1 {
		return nil
	}
	var st string
	if err := s.Pool.QueryRow(ctx, `SELECT status FROM model_version WHERE id = $1`, id).Scan(&st); err != nil {
		return notFound(err)
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
	if _, err := tx.Exec(ctx, `INSERT INTO node (model_version_id, key, node_type_id, archetype, name, params, canvas_pos)
		SELECT $2, key, node_type_id, archetype, name, params, canvas_pos FROM node WHERE model_version_id = $1`, id, newID); err != nil {
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
