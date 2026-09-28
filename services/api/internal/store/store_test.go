package store_test

import (
	"context"
	"errors"
	"testing"

	"github.com/kaizenflow/api/internal/store"
	"github.com/kaizenflow/api/internal/testfix"
)

var ctx = context.Background()

func newModel(t *testing.T, st *store.Store, key string) int64 {
	t.Helper()
	id, err := st.CreateModel(ctx, key, map[string]any{"warmup_s": 1800.0})
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestGraphRoundTripAndPublishLock(t *testing.T) {
	st := testfix.Seeded(t, "store_graph")
	id := newModel(t, st, "mini")
	if err := st.ReplaceGraph(ctx, id, testfix.MiniNodes(), testfix.MiniEdges(), nil); err != nil {
		t.Fatal(err)
	}
	g, err := st.GetGraph(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if g.Status != "DRAFT" || len(g.Nodes) != 4 || len(g.Edges) != 2 || g.Settings["warmup_s"] != 1800.0 {
		t.Fatalf("graph = %+v", g)
	}
	if g.Nodes[3].Archetype != "RESOURCE_POOL" || g.Edges[1].Params["pool"] != "TUG" || g.Edges[1].Material != "RAW-01" {
		t.Fatalf("nodes/edges = %+v %+v", g.Nodes, g.Edges)
	}
	// lưu lại lần hai: thay toàn bộ, không trùng
	if err := st.ReplaceGraph(ctx, id, testfix.MiniNodes()[:3], testfix.MiniEdges()[:1], map[string]any{"sample_s": 30.0}); err != nil {
		t.Fatal(err)
	}
	g, _ = st.GetGraph(ctx, id)
	if len(g.Nodes) != 3 || len(g.Edges) != 1 || g.Settings["sample_s"] != 30.0 {
		t.Fatalf("after replace: %d nodes %d edges %v", len(g.Nodes), len(g.Edges), g.Settings)
	}
	if err := st.Publish(ctx, id); err != nil {
		t.Fatal(err)
	}
	if err := st.ReplaceGraph(ctx, id, testfix.MiniNodes(), nil, nil); !errors.Is(err, store.ErrNotDraft) {
		t.Fatalf("edit after publish: %v", err)
	}
	if err := st.Publish(ctx, id); !errors.Is(err, store.ErrNotDraft) {
		t.Fatalf("double publish: %v", err)
	}
	if _, err := st.GetGraph(ctx, 9999); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
}

func TestReplaceGraphRejectsBadReferences(t *testing.T) {
	st := testfix.Seeded(t, "store_refs")
	id := newModel(t, st, "m")
	var re *store.RefError
	bad := testfix.MiniNodes()
	bad[0].NodeType = "NOPE"
	if err := st.ReplaceGraph(ctx, id, bad, nil, nil); !errors.As(err, &re) || re.Key != "SRC" {
		t.Fatalf("unknown type: %v", err)
	}
	edges := testfix.MiniEdges()
	edges[0].Dst = "GHOST"
	if err := st.ReplaceGraph(ctx, id, testfix.MiniNodes(), edges, nil); !errors.As(err, &re) || re.Key != "SRC>S" {
		t.Fatalf("unknown node: %v", err)
	}
	edges = testfix.MiniEdges()
	edges[0].Material = "UNOBTAINIUM"
	if err := st.ReplaceGraph(ctx, id, testfix.MiniNodes(), edges, nil); !errors.As(err, &re) || re.Key != "SRC>S" {
		t.Fatalf("unknown material: %v", err)
	}
	g, _ := st.GetGraph(ctx, id)
	if len(g.Nodes) != 0 { // transaction rollback: không để lại gì
		t.Fatalf("partial write left %d nodes", len(g.Nodes))
	}
	if _, err := st.CreateModel(ctx, "m", nil); !errors.As(err, &re) {
		t.Fatalf("duplicate model: %v", err)
	}
}

func TestCloneCopiesGraphAsNewDraft(t *testing.T) {
	st := testfix.Seeded(t, "store_clone")
	id := newModel(t, st, "c")
	_ = st.ReplaceGraph(ctx, id, testfix.MiniNodes(), testfix.MiniEdges(), nil)
	_ = st.Publish(ctx, id)
	id2, err := st.Clone(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	g, _ := st.GetGraph(ctx, id2)
	if g.Version != 2 || g.Status != "DRAFT" || len(g.Nodes) != 4 || len(g.Edges) != 2 || g.Edges[1].Src != "S" {
		t.Fatalf("clone = %+v", g)
	}
	vs, _ := st.ListVersions(ctx, "c")
	ms, _ := st.ListModels(ctx)
	if len(vs) != 2 || len(ms) != 1 || ms[0].LatestVersion != 2 {
		t.Fatalf("versions=%v models=%v", vs, ms)
	}
}

func TestNodeTypesAndMaterials(t *testing.T) {
	st := testfix.Seeded(t, "store_catalog")
	types, err := st.NodeTypes(ctx)
	if err != nil || types["STAMP_PRESS"].Archetype != "PROCESS" {
		t.Fatalf("types: %v %v", err, types["STAMP_PRESS"])
	}
	if _, err := st.CreateMaterial(ctx, store.Material{Code: "ECU-001", Name: "ECU"}); err != nil {
		t.Fatal(err)
	}
	codes, _ := st.MaterialCodes(ctx)
	if len(codes) != 7 {
		t.Fatalf("codes = %v", codes)
	}
}
