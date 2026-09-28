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
	IsBuiltin     bool            `json:"is_builtin"`
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
