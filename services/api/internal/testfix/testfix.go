// Package testfix cung cấp đồ thị mẫu và catalog cho test.
package testfix

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/kaizenflow/api/internal/catalog"
	"github.com/kaizenflow/api/internal/store"
	"github.com/kaizenflow/api/internal/testdb"
)

func MiniNodes() []store.GraphNode {
	return []store.GraphNode{
		{Key: "SRC", NodeType: "DOCK_IN", Params: map[string]any{
			"arrivals": map[string]any{"interarrival": 60.0},
			"lots":     []any{map[string]any{"material": "RAW-01", "qty": 10.0}}}},
		{Key: "S", NodeType: "RACK_WAREHOUSE", Params: map[string]any{}},
		{Key: "OUT", NodeType: "SHIP_DOCK", Params: map[string]any{
			"demand": []any{map[string]any{"kind": "TAKT", "material": "RAW-01", "takt": 60.0}}}},
		{Key: "TUG", NodeType: "TUGGER", Params: map[string]any{}},
	}
}

func MiniEdges() []store.GraphEdge {
	return []store.GraphEdge{
		{Key: "SRC>S", Src: "SRC", Dst: "S", Material: "RAW-01", Params: map[string]any{}},
		{Key: "S>OUT", Src: "S", Dst: "OUT", Material: "RAW-01", Params: map[string]any{"mode": "POOL", "pool": "TUG", "lot": 1.0}},
	}
}

// Types dựng catalog built-in trong bộ nhớ (không cần DB).
func Types() map[string]store.NodeType {
	out := map[string]store.NodeType{}
	for i, b := range catalog.Builtins {
		schema, _ := catalog.SchemaFor(b.Archetype)
		out[b.Code] = store.NodeType{ID: int64(i + 1), Code: b.Code, Name: b.Name, Archetype: b.Archetype,
			ParamSchema: schema, DefaultParams: json.RawMessage(b.Defaults), Signals: json.RawMessage(b.Signals),
			FailureModes: json.RawMessage(b.FailureModes), UI: json.RawMessage(b.UI), IsBuiltin: true}
	}
	return out
}

// MiniGraph trả Graph PUBLISHED dựng từ MiniNodes/MiniEdges với archetype đã điền.
func MiniGraph() *store.Graph {
	types := Types()
	nodes := MiniNodes()
	for i := range nodes {
		nodes[i].Archetype = types[nodes[i].NodeType].Archetype
	}
	return &store.Graph{VersionID: 1, ModelKey: "mini", Version: 1, Status: "PUBLISHED",
		Settings: map[string]any{}, Nodes: nodes, Edges: MiniEdges()}
}

func Seeded(t *testing.T, name string) *store.Store {
	t.Helper()
	pool := testdb.New(t, name)
	if err := catalog.Seed(context.Background(), pool); err != nil {
		t.Fatal(err)
	}
	return store.New(pool)
}
