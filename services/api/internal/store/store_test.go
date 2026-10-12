package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/kaizenflow/api/internal/simfake"
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
	if err := st.Publish(ctx, id, nil); err != nil {
		t.Fatal(err)
	}
	if err := st.ReplaceGraph(ctx, id, testfix.MiniNodes(), nil, nil); !errors.Is(err, store.ErrNotDraft) {
		t.Fatalf("edit after publish: %v", err)
	}
	if err := st.Publish(ctx, id, nil); !errors.Is(err, store.ErrNotDraft) {
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
	_ = st.Publish(ctx, id, nil)
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

func seededVersion(t *testing.T, st *store.Store, key string) int64 {
	t.Helper()
	id := newModel(t, st, key)
	if err := st.ReplaceGraph(ctx, id, testfix.MiniNodes(), testfix.MiniEdges(), nil); err != nil {
		t.Fatal(err)
	}
	if err := st.Publish(ctx, id, nil); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestScenarioRoundTrip(t *testing.T) {
	st := testfix.Seeded(t, "store_scenario")
	vid := seededVersion(t, st, "s")
	sid, err := st.CreateScenario(ctx, store.Scenario{ModelVersionID: vid, Name: "base", HorizonS: 14400,
		Injections: []map[string]any{{"target": "P", "failure": "bearing_wear", "at_s": 3600.0}}})
	if err != nil {
		t.Fatal(err)
	}
	sc, err := st.GetScenario(ctx, sid)
	if err != nil {
		t.Fatal(err)
	}
	if sc.HorizonS != 14400 || sc.Origin != "USER" || sc.StartState != "WARMUP" || sc.Replications != 50 ||
		len(sc.Injections) != 1 || sc.Overrides == nil || sc.Seed != nil {
		t.Fatalf("scenario = %+v", sc)
	}
	list, _ := st.ListScenarios(ctx, vid)
	if len(list) != 1 {
		t.Fatalf("list = %v", list)
	}
}

func TestRunLifecycleAndResultPersistence(t *testing.T) {
	st := testfix.Seeded(t, "store_run")
	vid := seededVersion(t, st, "r")
	sid, _ := st.CreateScenario(ctx, store.Scenario{ModelVersionID: vid, HorizonS: 3600})
	simStart := time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC)
	rid, err := st.InsertRun(ctx, sid, simStart, "FORECAST")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetRunStatus(ctx, rid, "RUNNING", nil); err != nil {
		t.Fatal(err)
	}
	res := simfake.Result(rid)
	if err := st.SaveResult(ctx, rid, &res); err != nil {
		t.Fatal(err)
	}
	run, _ := st.GetRun(ctx, rid)
	if run.Status != "DONE" || run.FinishedAt == nil || *run.EngineVersion != "0.1.0" || run.KPIs["throughput"] == nil {
		t.Fatalf("run = %+v", run)
	}
	ins, _ := st.ListInsights(ctx, rid)
	if len(ins) != 2 || ins[0].Kind != "RED_RISK" || *ins[0].Probability != 0.5 || ins[1].Payload["candidates"] == nil {
		t.Fatalf("insights = %+v", ins)
	}
	one, _ := st.GetInsight(ctx, ins[1].ID)
	if *one.SimRunID != rid {
		t.Fatalf("insight run = %v", one.SimRunID)
	}
	bands, _ := st.Bands(ctx, rid, "S", "coverage_h")
	if len(bands) != 2 || bands[1].P50 != 1 {
		t.Fatalf("bands = %v", bands)
	}
	all, _ := st.Bands(ctx, rid, "", "")
	sigs, _ := st.Signals(ctx, rid, "S", "")
	evs, _ := st.Events(ctx, rid, "", "COLOR_CHANGE")
	if len(all) != 2 || len(sigs) != 5000 || len(evs) != 1 || evs[0].Payload["state"] != "RED" {
		t.Fatalf("all=%d sigs=%d evs=%v", len(all), len(sigs), evs)
	}
	msg := "boom"
	_ = st.SetRunStatus(ctx, rid, "FAILED", &msg)
	run, _ = st.GetRun(ctx, rid)
	runs, _ := st.ListRuns(ctx, sid)
	if run.Status != "FAILED" || *run.Error != "boom" || len(runs) != 1 {
		t.Fatalf("failed run = %+v", run)
	}
}

func TestDailyForecastUsesLatestIssue(t *testing.T) {
	st := testfix.Seeded(t, "store_forecast")
	day := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	for i, v := range []float64{100, 240} {
		issued := day.Add(-time.Duration(48-24*i) * time.Hour)
		if _, err := st.Pool.Exec(ctx, `INSERT INTO forecast_band (issued_at, target_time, producer, subject, metric, p50)
			VALUES ($1, $2, 'PREDICT:HW', 'RAW-01', 'demand_daily', $3)`, issued, day, v); err != nil {
			t.Fatal(err)
		}
	}
	pts, err := st.DailyForecast(ctx, "RAW-01", "PREDICT:HW", day, day.AddDate(0, 0, 2))
	if err != nil || len(pts) != 1 || pts[0].P50 != 240 {
		t.Fatalf("points = %v %v", pts, err)
	}
}
