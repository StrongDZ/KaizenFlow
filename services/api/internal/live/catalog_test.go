package live

import "testing"

func names(defs []SignalDef) map[string]string {
	out := map[string]string{}
	for _, d := range defs {
		out[d.Name] = d.Kind
	}
	return out
}

func TestSignalsForProcessAndStorage(t *testing.T) {
	p := names(SignalsFor("PROCESS", nil))
	for _, n := range []string{"state", "count_in", "count_ok", "count_ng", "vibration"} {
		if _, ok := p[n]; !ok {
			t.Errorf("PROCESS missing %s", n)
		}
	}
	if p["state"] != "text" || p["count_ok"] != "number" {
		t.Errorf("kinds = %v", p)
	}
	st := names(SignalsFor("STORAGE", map[string]any{"stock": []any{
		map[string]any{"material": "RAW-01"}, map[string]any{"material": "RAW-02"}}}))
	if st["level:RAW-01"] != "number" || st["level:RAW-02"] != "number" || len(st) != 2 {
		t.Errorf("STORAGE signals = %v", st)
	}
}

func TestSignalsForPoolOnlyVehiclesHaveFleet(t *testing.T) {
	agv := names(SignalsFor("RESOURCE_POOL", map[string]any{"kind": "AGV"}))
	if agv["fleet"] != "fleet" || agv["busy"] != "number" || agv["queue_len"] != "number" {
		t.Errorf("AGV pool = %v", agv)
	}
	op := names(SignalsFor("RESOURCE_POOL", map[string]any{"kind": "OPERATOR"}))
	if _, ok := op["fleet"]; ok {
		t.Errorf("operators have no fleet position: %v", op)
	}
}

func TestEdgeSignalsTripOnlyForPoolMode(t *testing.T) {
	if _, ok := names(EdgeSignals("POOL"))["trip_s"]; !ok {
		t.Error("POOL edge needs trip_s")
	}
	if _, ok := names(EdgeSignals("NONE"))["trip_s"]; ok {
		t.Error("direct edge has no trip_s")
	}
	if _, ok := names(EdgeSignals(""))["moved"]; !ok {
		t.Error("every edge has moved")
	}
}

func TestValidSignal(t *testing.T) {
	stock := map[string]any{"stock": []any{map[string]any{"material": "RAW-01"}}}
	if !ValidSignal("STORAGE", stock, "level:RAW-01") || ValidSignal("STORAGE", stock, "state") {
		t.Error("storage validity wrong")
	}
	if !ValidSignal("STORAGE", stock, "level:RAW-09") {
		t.Error("a level of a material not yet in stock is allowed (stock may be added later)")
	}
	if !ValidSignal("PROCESS", nil, "state") || ValidSignal("PROCESS", nil, "level:X") {
		t.Error("process validity wrong")
	}
}
