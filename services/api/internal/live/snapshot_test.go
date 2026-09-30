package live

import (
	"testing"
)

func stock(items ...map[string]any) []any {
	out := make([]any, len(items))
	for i, it := range items {
		out[i] = it
	}
	return out
}

func TestBuildSnapshotReplacesStockLevelsAndKeepsOtherFields(t *testing.T) {
	nodes := []NodeInfo{
		{Key: "KHO_A", Archetype: "STORAGE", Params: map[string]any{"stock": stock(
			map[string]any{"material": "RAW-01", "initial": 300.0, "max": 1000.0},
			map[string]any{"material": "RAW-02", "initial": 10.0})}},
		{Key: "SUP", Archetype: "SOURCE", Params: map[string]any{}},
	}
	levels := map[string]map[string]float64{"KHO_A": {"RAW-01": 230, "RAW-03": 5}, "SUP": {"X": 1}, "GHOST": {"Y": 2}}
	out := BuildSnapshot(nodes, levels, nil)
	if len(out.Overrides) != 1 {
		t.Fatalf("overrides = %+v", out.Overrides)
	}
	o := out.Overrides[0]
	if o["target"] != "KHO_A" || o["path"] != "/stock" {
		t.Fatalf("override = %+v", o)
	}
	list := o["value"].([]any)
	byMat := map[string]map[string]any{}
	for _, x := range list {
		m := x.(map[string]any)
		byMat[m["material"].(string)] = m
	}
	if len(list) != 3 || byMat["RAW-01"]["initial"] != 230.0 || byMat["RAW-01"]["max"] != 1000.0 {
		t.Errorf("RAW-01 must take the live level and keep max: %+v", byMat["RAW-01"])
	}
	if byMat["RAW-02"]["initial"] != 10.0 {
		t.Errorf("a material without a live level keeps its configured start: %+v", byMat["RAW-02"])
	}
	if byMat["RAW-03"]["initial"] != 5.0 {
		t.Errorf("a live material missing from the stock list is appended: %+v", byMat["RAW-03"])
	}
	// đầu vào không bị sửa
	if nodes[0].Params["stock"].([]any)[0].(map[string]any)["initial"] != 300.0 {
		t.Error("input params were mutated")
	}
	if len(out.Injections) != 0 {
		t.Errorf("injections = %+v", out.Injections)
	}
}

func TestBuildSnapshotStopsMachinesThatAreDownForTheirRepairTime(t *testing.T) {
	nodes := []NodeInfo{
		{Key: "P1", Archetype: "PROCESS", Params: map[string]any{"mttr": map[string]any{"dist": "norm", "mean": 600.0, "sd": 60.0}}},
		{Key: "P2", Archetype: "PROCESS", Params: map[string]any{}},
		{Key: "P3", Archetype: "PROCESS", Params: map[string]any{}},
		{Key: "KHO", Archetype: "STORAGE", Params: map[string]any{}},
	}
	states := map[string]string{"P1": "DOWN", "P2": "DOWN", "P3": "RUNNING", "KHO": "DOWN", "GHOST": "DOWN"}
	out := BuildSnapshot(nodes, nil, states)
	if len(out.Injections) != 2 {
		t.Fatalf("injections = %+v", out.Injections)
	}
	got := map[string]map[string]any{}
	for _, inj := range out.Injections {
		got[inj["target"].(string)] = inj
	}
	if got["P1"]["kind"] != "planned_stop" || got["P1"]["at_s"] != 0.0 || got["P1"]["duration_s"] != 600.0 {
		t.Errorf("P1 = %+v", got["P1"])
	}
	if got["P2"]["duration_s"] != DefaultRepairS {
		t.Errorf("P2 without MTTR uses the default: %+v", got["P2"])
	}
}

func TestBuildSnapshotClampsNegativeLevelsAndReportsWhatItDid(t *testing.T) {
	nodes := []NodeInfo{{Key: "K", Archetype: "STORAGE", Params: map[string]any{"stock": stock(map[string]any{"material": "M", "initial": 5.0})}}}
	out := BuildSnapshot(nodes, map[string]map[string]float64{"K": {"M": -3}}, map[string]string{})
	v := out.Overrides[0]["value"].([]any)[0].(map[string]any)["initial"]
	if v != 0.0 {
		t.Errorf("negative level must clamp to 0, got %v", v)
	}
	if len(out.Notes) == 0 {
		t.Error("the snapshot must describe what it applied")
	}
	empty := BuildSnapshot(nodes, nil, nil)
	if len(empty.Overrides) != 0 || len(empty.Injections) != 0 {
		t.Errorf("no live data → no overrides: %+v", empty)
	}
}

func TestDistMean(t *testing.T) {
	cases := []struct {
		in   any
		want float64
		ok   bool
	}{
		{120.0, 120, true},
		{map[string]any{"dist": "const", "value": 30.0}, 30, true},
		{map[string]any{"dist": "norm", "mean": 90.0, "sd": 15.0}, 90, true},
		{map[string]any{"dist": "norm", "mean_s": 45.0, "sd_s": 5.0}, 45, true},
		{map[string]any{"dist": "exp", "mean": 100.0}, 100, true},
		{map[string]any{"dist": "lognorm", "mean": 50.0, "cv": 0.3}, 50, true},
		{map[string]any{"dist": "tri", "min": 1.0, "mode": 2.0, "max": 6.0}, 3, true},
		{map[string]any{"dist": "uniform", "min": 2.0, "max": 4.0}, 3, true},
		{map[string]any{"dist": "weibull", "shape": 1.0, "scale": 10.0}, 10, true},
		{map[string]any{"dist": "mystery"}, 0, false},
		{nil, 0, false},
		{"text", 0, false},
	}
	for _, c := range cases {
		got, ok := DistMean(c.in)
		if ok != c.ok || (ok && (got < c.want-1e-9 || got > c.want+1e-9)) {
			t.Errorf("DistMean(%v) = %v, %v; want %v, %v", c.in, got, ok, c.want, c.ok)
		}
	}
}
