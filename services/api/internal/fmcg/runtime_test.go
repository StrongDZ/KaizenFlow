package fmcg

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/kaizenflow/api/internal/store"
)

func TestBuildRuntimeNowcastForBimbo(t *testing.T) {
	g := &store.Graph{
		ModelKey: ModelKey,
		Nodes: []store.GraphNode{
			{Key: "FG_A", NodeType: "RACK_WAREHOUSE", Name: "Kho FG A", Params: map[string]any{
				"stock": []any{map[string]any{"material": "CASE-01", "initial": 180, "max": 1200}},
			}},
			{Key: "SHIP_A", NodeType: "SHIP_DOCK", Name: "Depot A", Params: map[string]any{
				"demand": []any{map[string]any{
					"kind":     "TAKT",
					"material": "CASE-01",
					"takt":     map[string]any{"dist": "exp", "mean": 360.0},
				}},
			}},
		},
		Edges: []store.GraphEdge{{Key: "FG_A>SHIP_A", Src: "FG_A", Dst: "SHIP_A", Material: "CASE-01"}},
	}
	types := map[string]store.NodeType{
		"RACK_WAREHOUSE": {Code: "RACK_WAREHOUSE", Name: "Kho", Archetype: "STORAGE", DefaultParams: json.RawMessage(`{}`)},
		"SHIP_DOCK":      {Code: "SHIP_DOCK", Name: "Cửa xuất", Archetype: "SINK", DefaultParams: json.RawMessage(`{}`)},
	}
	levels := map[string]map[string]float64{"FG_A": {"CASE-01": 260}}
	obs := map[string]Observation{"SHIP_A": {DemandPerHour: 11.5, FulfilledPerHour: 10.8, Samples: 8, WindowHours: 6}}

	overrides, meta, err := BuildRuntimeNowcast(g, types, levels, obs, time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC), 24*3600)
	if err != nil {
		t.Fatalf("BuildRuntimeNowcast() error = %v", err)
	}
	if len(overrides) != 1 {
		t.Fatalf("expected 1 override, got %d", len(overrides))
	}
	if overrides[0]["target"] != "SHIP_A" || overrides[0]["path"] != "/demand" {
		t.Fatalf("unexpected override header: %#v", overrides[0])
	}
	list, ok := overrides[0]["value"].([]any)
	if !ok || len(list) != 1 {
		t.Fatalf("unexpected override value: %#v", overrides[0]["value"])
	}
	demand, ok := list[0].(map[string]any)
	if !ok || demand["kind"] != "FORECAST" {
		t.Fatalf("unexpected demand override: %#v", list[0])
	}
	rates, ok := demand["hourly_rate"].([]float64)
	if !ok || len(rates) != 24 {
		t.Fatalf("unexpected hourly_rate: %#v", demand["hourly_rate"])
	}
	if rates[0] <= 0 {
		t.Fatalf("expected positive first rate, got %.2f", rates[0])
	}
	if meta == nil || meta["method"] != "HYBRID_LIVE_FLOW_BACKORDER" {
		t.Fatalf("unexpected meta: %#v", meta)
	}
}

func TestBuildRuntimeNowcastUsesBackorderLift(t *testing.T) {
	g := &store.Graph{
		ModelKey: ModelKey,
		Nodes: []store.GraphNode{
			{Key: "FG_A", NodeType: "RACK_WAREHOUSE", Name: "Kho FG A", Params: map[string]any{
				"stock": []any{map[string]any{"material": "CASE-01", "initial": 180, "max": 1200}},
			}},
			{Key: "SHIP_A", NodeType: "SHIP_DOCK", Name: "Depot A", Params: map[string]any{
				"demand": []any{map[string]any{
					"kind":     "TAKT",
					"material": "CASE-01",
					"takt":     map[string]any{"dist": "exp", "mean": 360.0},
				}},
			}},
		},
		Edges: []store.GraphEdge{{Key: "FG_A>SHIP_A", Src: "FG_A", Dst: "SHIP_A", Material: "CASE-01"}},
	}
	types := map[string]store.NodeType{
		"RACK_WAREHOUSE": {Code: "RACK_WAREHOUSE", Name: "Kho", Archetype: "STORAGE", DefaultParams: json.RawMessage(`{}`)},
		"SHIP_DOCK":      {Code: "SHIP_DOCK", Name: "Cửa xuất", Archetype: "SINK", DefaultParams: json.RawMessage(`{}`)},
	}
	levels := map[string]map[string]float64{"FG_A": {"CASE-01": 260}}
	obs := map[string]Observation{"SHIP_A": {
		DemandPerHour:    8.0,
		FulfilledPerHour: 6.0,
		BackorderPerHour: 3.0,
		Samples:          8,
		WindowHours:      6,
	}}

	_, meta, err := BuildRuntimeNowcast(g, types, levels, obs, time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC), 24*3600)
	if err != nil {
		t.Fatalf("BuildRuntimeNowcast() error = %v", err)
	}
	series := meta["series"].([]map[string]any)
	row := series[0]
	if row["source"] != "hybrid_live_backorder+takt" {
		t.Fatalf("source = %v, want hybrid_live_backorder+takt", row["source"])
	}
	if row["live_basis"] != "fulfilled+backorder" {
		t.Fatalf("basis = %v, want fulfilled+backorder", row["live_basis"])
	}
	if row["recent_per_hour"] != 9.0 {
		t.Fatalf("recent_per_hour = %v, want 9", row["recent_per_hour"])
	}
}

func TestBuildRuntimeNowcastAddsCoveragePressure(t *testing.T) {
	g := &store.Graph{
		ModelKey: ModelKey,
		Nodes: []store.GraphNode{
			{Key: "FG_A", NodeType: "RACK_WAREHOUSE", Name: "Kho FG A", Params: map[string]any{
				"stock": []any{map[string]any{"material": "CASE-01", "initial": 180, "max": 1200}},
			}},
			{Key: "SHIP_A", NodeType: "SHIP_DOCK", Name: "Depot A", Params: map[string]any{
				"demand": []any{map[string]any{
					"kind":     "TAKT",
					"material": "CASE-01",
					"takt":     map[string]any{"dist": "exp", "mean": 360.0},
				}},
			}},
		},
		Edges: []store.GraphEdge{{Key: "FG_A>SHIP_A", Src: "FG_A", Dst: "SHIP_A", Material: "CASE-01"}},
	}
	types := map[string]store.NodeType{
		"RACK_WAREHOUSE": {Code: "RACK_WAREHOUSE", Name: "Kho", Archetype: "STORAGE", DefaultParams: json.RawMessage(`{}`)},
		"SHIP_DOCK":      {Code: "SHIP_DOCK", Name: "Cửa xuất", Archetype: "SINK", DefaultParams: json.RawMessage(`{}`)},
	}
	levels := map[string]map[string]float64{"FG_A": {"CASE-01": 36}}
	obs := map[string]Observation{"SHIP_A": {
		DemandPerHour:    9.0,
		FulfilledPerHour: 8.0,
		BackorderPerHour: 2.0,
		Samples:          8,
		WindowHours:      6,
	}}

	_, meta, err := BuildRuntimeNowcast(g, types, levels, obs, time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC), 24*3600)
	if err != nil {
		t.Fatalf("BuildRuntimeNowcast() error = %v", err)
	}
	series := meta["series"].([]map[string]any)
	row := series[0]
	if row["source"] != "hybrid_live_backorder+takt+coverage" {
		t.Fatalf("source = %v, want hybrid_live_backorder+takt+coverage", row["source"])
	}
	if row["coverage_pressure"] == nil {
		t.Fatalf("coverage_pressure missing: %#v", row)
	}
	if row["pre_coverage_hours"] != 3.6 {
		t.Fatalf("pre_coverage_hours = %v, want 3.6", row["pre_coverage_hours"])
	}
	if row["blend_per_hour"].(float64) <= 9.5 {
		t.Fatalf("blend_per_hour = %v, want boosted > 9.5", row["blend_per_hour"])
	}
	actions := meta["replenishment"].([]map[string]any)
	if len(actions) != 1 {
		t.Fatalf("replenishment len = %d, want 1", len(actions))
	}
	if actions[0]["priority"] != "CRITICAL" {
		t.Fatalf("priority = %v, want CRITICAL", actions[0]["priority"])
	}
	if actions[0]["recommended_replenish"].(float64) <= 120 {
		t.Fatalf("recommended_replenish = %v, want > 120", actions[0]["recommended_replenish"])
	}
	cands := actions[0]["candidates"].([]any)
	if len(cands) != 1 {
		t.Fatalf("candidates len = %d, want 1", len(cands))
	}
	cand := cands[0].(map[string]any)
	if cand["action"].(map[string]any)["type"] != "REPLENISH" {
		t.Fatalf("candidate action = %#v", cand["action"])
	}
	if cand["overrides"].([]any)[0].(map[string]any)["path"] != "/stock" {
		t.Fatalf("candidate overrides = %#v", cand["overrides"])
	}
}
