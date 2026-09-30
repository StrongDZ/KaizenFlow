package resolve_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/kaizenflow/api/internal/resolve"
	"github.com/kaizenflow/api/internal/simapi"
	"github.com/kaizenflow/api/internal/store"
	"github.com/kaizenflow/api/internal/testfix"
)

var (
	ctx   = context.Background()
	tz    = time.FixedZone("ICT", 7*3600)
	start = time.Date(2026, 10, 1, 8, 0, 0, 0, tz)
)

func scenario() *store.Scenario {
	return &store.Scenario{ID: 5, Origin: "USER", HorizonS: 7200, StartState: "WARMUP", Replications: 10}
}

func build(g *store.Graph, sc *store.Scenario, fc resolve.ForecastLookup, opt resolve.Options) (*simapi.RunRequest, error) {
	return resolve.Build(ctx, g, testfix.Types(), []string{"RAW-01"}, sc, 42, start, fc, opt)
}

func node(r *simapi.RunRequest, key string) simapi.Node {
	for _, n := range r.Nodes {
		if n.Key == key {
			return n
		}
	}
	return simapi.Node{}
}

func TestMergesDefaultsPoolsAndEdges(t *testing.T) {
	g := testfix.MiniGraph()
	g.Settings = map[string]any{"warmup_s": 1800.0}
	r, err := build(g, scenario(), nil, resolve.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Nodes) != 3 || len(r.Pools) != 1 {
		t.Fatalf("nodes=%d pools=%d", len(r.Nodes), len(r.Pools))
	}
	src := node(r, "SRC").Params
	if src["arrivals"].(map[string]any)["interarrival"] != 60.0 || len(src["lots"].([]any)) != 1 {
		t.Fatalf("SRC params = %v", src)
	}
	if node(r, "S").Params["capacity"] != 2000.0 {
		t.Fatalf("storage defaults not merged: %v", node(r, "S").Params)
	}
	p := r.Pools[0]
	if p.Key != "TUG" || p.Kind != "TUGGER" || p.Count != 2 {
		t.Fatalf("pool = %+v", p)
	}
	e := r.Edges[1]
	if e["key"] != "S>OUT" || e["src"] != "S" || e["dst"] != "OUT" || e["material"] != "RAW-01" || e["mode"] != "POOL" || e["pool"] != "TUG" {
		t.Fatalf("edge = %v", e)
	}
	if r.InitialState.Mode != "WARMUP" || r.InitialState.WarmupS != 1800 || r.Seed != 42 || !r.Recommend {
		t.Fatalf("run fields = %+v", r)
	}
	if r.Outputs.SampleS != 60 || len(r.Outputs.RawReps) != 1 || r.RunID != 42 || r.HorizonS != 7200 {
		t.Fatalf("outputs = %+v", r.Outputs)
	}
}

func TestTypeSignalsAndFailureModesMerged(t *testing.T) {
	g := testfix.MiniGraph()
	g.Nodes = append(g.Nodes, store.GraphNode{Key: "P", NodeType: "STAMP_PRESS", Archetype: "PROCESS",
		Params: map[string]any{"recipes": []any{}}})
	r, err := build(g, scenario(), nil, resolve.Options{})
	if err != nil {
		t.Fatal(err)
	}
	fm := node(r, "P").Params["failure_modes"].([]any)
	if len(fm) != 1 || fm[0].(map[string]any)["code"] != "bearing_wear" || len(node(r, "P").Params["signals"].([]any)) != 1 {
		t.Fatalf("P params = %v", node(r, "P").Params)
	}
}

func TestOverridesApplyToPoolsNodesAndUnknownTarget(t *testing.T) {
	sc := scenario()
	sc.Overrides = []map[string]any{
		{"target": "TUG", "path": "/count", "value": 3.0},
		{"target": "S", "path": "/replenish/rop", "value": 5.0},
		{"target": "S>OUT", "path": "/lot", "value": 2.0},
	}
	r, err := build(testfix.MiniGraph(), sc, nil, resolve.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if r.Pools[0].Count != 3 || node(r, "S").Params["replenish"].(map[string]any)["rop"] != 5.0 || r.Edges[1]["lot"] != 2.0 {
		t.Fatalf("overrides not applied: %+v %v %v", r.Pools[0], node(r, "S").Params, r.Edges[1])
	}
	sc.Overrides = []map[string]any{{"target": "GHOST", "path": "/count", "value": 1.0}}
	_, err = build(testfix.MiniGraph(), sc, nil, resolve.Options{})
	var ie *resolve.IssueError
	if !errors.As(err, &ie) || ie.Key != "GHOST" {
		t.Fatalf("unknown target: %v", err)
	}
}

func TestStartStatesSeedAndRecommend(t *testing.T) {
	sc := scenario()
	sc.StartState = "EMPTY"
	seed := int64(7)
	sc.Seed = &seed
	sc.Origin = "RECOMMENDER"
	r, _ := build(testfix.MiniGraph(), sc, nil, resolve.Options{})
	if r.InitialState.Mode != "EMPTY" || r.InitialState.WarmupS != 0 || r.Seed != 7 || r.Recommend {
		t.Fatalf("got %+v", r)
	}
}

// LIVE_SNAPSHOT: tồn kho và máy hỏng đến từ overrides/injections của scenario; sim chạy từ giây 0, không chạy ấm.
func TestLiveSnapshotStartsFromEmptyStateWithoutWarmup(t *testing.T) {
	sc := scenario()
	sc.Origin = "NOWCAST"
	sc.StartState = "LIVE_SNAPSHOT"
	g := testfix.MiniGraph()
	g.Settings = map[string]any{"warmup_s": 1800.0}
	r, err := build(g, sc, nil, resolve.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if r.InitialState.Mode != "EMPTY" || r.InitialState.WarmupS != 0 {
		t.Fatalf("initial state = %+v", r.InitialState)
	}
	var ie *resolve.IssueError
	sc.StartState = "NO_SUCH_STATE"
	if _, err := build(g, sc, nil, resolve.Options{}); !errors.As(err, &ie) {
		t.Fatalf("unknown start state must still be rejected: %v", err)
	}
}

func TestStockOverrideReplacesTheWholeListForALiveStart(t *testing.T) {
	sc := scenario()
	sc.StartState = "LIVE_SNAPSHOT"
	sc.Overrides = []map[string]any{{"target": "S", "path": "/stock", "value": []any{map[string]any{"material": "RAW-01", "initial": 42.0, "max": 100.0}}}}
	r, err := build(testfix.MiniGraph(), sc, nil, resolve.Options{})
	if err != nil {
		t.Fatal(err)
	}
	stock := node(r, "S").Params["stock"].([]any)
	if len(stock) != 1 || stock[0].(map[string]any)["initial"] != 42.0 {
		t.Fatalf("stock = %+v", stock)
	}
}

// Horizon dài (dự báo nhiều ngày): lấy mẫu thưa để dải dự báo không phình ra, và không chạy đề xuất (mỗi ứng viên là một lần chạy đầy đủ).
func TestLongHorizonSamplesCoarselyAndSkipsRecommend(t *testing.T) {
	sc := scenario()
	sc.HorizonS = 7 * 86400
	r, err := build(testfix.MiniGraph(), sc, nil, resolve.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if r.Outputs.SampleS < 1500 || r.Outputs.SampleS > 1600 {
		t.Errorf("7 days should sample about every 25 minutes, got %v s", r.Outputs.SampleS)
	}
	if r.Recommend {
		t.Error("recommend must be off beyond 12 hours")
	}
	if len(r.Outputs.RawReps) != 0 || r.Outputs.Sensors {
		t.Errorf("a multi-day run must not record raw events or sensor traces (millions of rows): %+v", r.Outputs)
	}
	short, _ := build(testfix.MiniGraph(), scenario(), nil, resolve.Options{})
	if len(short.Outputs.RawReps) != 1 || !short.Outputs.Sensors {
		t.Errorf("a short run keeps replication 0 raw and sensors on: %+v", short.Outputs)
	}
	if short.Outputs.SampleS != 60 || !short.Recommend {
		t.Errorf("a 2-hour run keeps 60 s sampling and recommend: %+v %v", short.Outputs, short.Recommend)
	}
	g := testfix.MiniGraph()
	g.Settings = map[string]any{"sample_s": 300.0}
	kept, _ := build(g, scenario(), nil, resolve.Options{})
	if kept.Outputs.SampleS != 300 {
		t.Errorf("an explicit sample_s must be respected when the horizon is short: %v", kept.Outputs.SampleS)
	}
}

func forecastGraph() *store.Graph {
	g := testfix.MiniGraph()
	g.Nodes[2].Params = map[string]any{"demand": []any{map[string]any{
		"kind": "FORECAST", "material": "RAW-01", "forecast_ref": map[string]any{"producer": "PREDICT:HW"}}}}
	return g
}

func TestForecastDemandBecomesHourlyRate(t *testing.T) {
	fc := func(_ context.Context, material, producer string, from, to time.Time) ([]store.DailyPoint, error) {
		if material != "RAW-01" || producer != "PREDICT:HW" || !from.Equal(time.Date(2026, 10, 1, 0, 0, 0, 0, tz)) {
			t.Fatalf("lookup args %s %s %v", material, producer, from)
		}
		return []store.DailyPoint{{Day: time.Date(2026, 10, 1, 0, 0, 0, 0, tz), P50: 240}}, nil
	}
	r, err := build(forecastGraph(), scenario(), fc, resolve.Options{})
	if err != nil {
		t.Fatal(err)
	}
	d := node(r, "OUT").Params["demand"].([]any)[0].(map[string]any)
	rates := d["hourly_rate"].([]float64)
	if len(rates) != 2 || rates[0] != 10 || d["forecast_ref"] != nil {
		t.Fatalf("demand = %v", d)
	}
	g := forecastGraph()
	g.Settings = map[string]any{"shift_profile": []any{1.0}}
	var ie *resolve.IssueError
	if _, err := build(g, scenario(), fc, resolve.Options{}); !errors.As(err, &ie) || ie.Key != "settings" {
		t.Fatalf("bad profile: %v", err)
	}
	empty := func(context.Context, string, string, time.Time, time.Time) ([]store.DailyPoint, error) { return nil, nil }
	if _, err := build(forecastGraph(), scenario(), empty, resolve.Options{}); !errors.As(err, &ie) || ie.Key != "RAW-01" {
		t.Fatalf("missing forecast: %v", err)
	}
	r, err = build(forecastGraph(), scenario(), nil, resolve.Options{ForValidation: true})
	if err != nil || node(r, "OUT").Params["demand"].([]any)[0].(map[string]any)["hourly_rate"].([]float64)[0] != 0 {
		t.Fatalf("validation mode: %v", err)
	}
}

func TestForecastUsesPlantTimezoneNotServerTime(t *testing.T) {
	ict := time.FixedZone("ICT", 7*3600)
	day := time.Date(2026, 10, 1, 0, 0, 0, 0, ict) // Predict ghi 00:00 giờ nhà máy
	fc := func(_ context.Context, _, _ string, from, to time.Time) ([]store.DailyPoint, error) {
		if day.Before(from) || !day.Before(to) {
			t.Fatalf("day %v outside [%v, %v)", day, from, to)
		}
		return []store.DailyPoint{{Day: day, P50: 240}}, nil
	}
	profile := make([]any, 24)
	for i := range profile {
		profile[i] = 0.0
	}
	profile[8] = 1.0 // toàn bộ nhu cầu rơi vào 08:00 giờ nhà máy
	g := forecastGraph()
	g.Settings = map[string]any{"shift_profile": profile, "timezone": "Asia/Ho_Chi_Minh"}
	utcStart := time.Date(2026, 10, 1, 1, 0, 0, 0, time.UTC) // = 08:00 ICT, server chạy UTC
	r, err := resolve.Build(ctx, g, testfix.Types(), []string{"RAW-01"}, scenario(), 42, utcStart, fc, resolve.Options{})
	if err != nil {
		t.Fatal(err)
	}
	rates := node(r, "OUT").Params["demand"].([]any)[0].(map[string]any)["hourly_rate"].([]float64)
	if rates[0] != 240 || rates[1] != 0 {
		t.Fatalf("rates = %v", rates)
	}
	g.Settings = map[string]any{"timezone": "Mars/Olympus"}
	var ie *resolve.IssueError
	if _, err := resolve.Build(ctx, g, testfix.Types(), nil, scenario(), 1, utcStart, fc, resolve.Options{}); !errors.As(err, &ie) || ie.Key != "settings" {
		t.Fatalf("bad tz: %v", err)
	}
}
