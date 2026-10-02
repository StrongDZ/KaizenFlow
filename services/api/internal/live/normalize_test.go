package live

import (
	"testing"
	"time"
)

var t0 = time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC)

func f(v float64) *float64 { return &v }

func TestNormalizeState(t *testing.T) {
	b := Binding{Subject: "STAMP_2", Signal: "state", Source: "plc/prs-02/status", JSONPath: "st", Enabled: true,
		Transform: Transform{Enum: map[string]string{"RUN": "RUNNING", "ALARM": "DOWN", "WAIT_IN": "STARVED"}}}
	msg := Message{Source: "plc/prs-02/status", TS: t0, Payload: map[string]any{"st": "ALARM"}}
	rs, errs := Normalize("m", []Binding{b}, msg)
	if len(errs) != 0 || len(rs) != 1 {
		t.Fatalf("rs=%v errs=%v", rs, errs)
	}
	r := rs[0]
	if !r.IsText || r.Text != "DOWN" || r.Subject != "STAMP_2" || r.Signal != "state" || r.Model != "m" || !r.TS.Equal(t0) {
		t.Errorf("bad reading %+v", r)
	}
}

func TestNormalizeNumberScaleOffset(t *testing.T) {
	b := Binding{Subject: "KHO_A", Signal: "level:RAW-01", Source: "wms/wh-a/stock", JSONPath: "items[sku=RAW-01].qty", Enabled: true,
		Transform: Transform{Scale: f(2), Offset: f(1)}}
	msg := Message{Source: "wms/wh-a/stock", TS: t0, Payload: map[string]any{"items": []any{map[string]any{"sku": "RAW-01", "qty": 10.0}}}}
	rs, errs := Normalize("m", []Binding{b}, msg)
	if len(errs) != 0 || len(rs) != 1 || rs[0].Num != 21 || rs[0].IsText {
		t.Fatalf("rs=%+v errs=%v", rs, errs)
	}
}

func TestNormalizeAcceptsNumericString(t *testing.T) {
	b := Binding{Subject: "X", Signal: "count_ok", Source: "s", JSONPath: "n", Enabled: true}
	rs, errs := Normalize("m", []Binding{b}, Message{Source: "s", TS: t0, Payload: map[string]any{"n": "42.5"}})
	if len(errs) != 0 || len(rs) != 1 || rs[0].Num != 42.5 {
		t.Fatalf("rs=%+v errs=%v", rs, errs)
	}
}

func TestNormalizeSkipsDisabledAndNonMatching(t *testing.T) {
	off := Binding{Subject: "A", Signal: "count_ok", Source: "s", JSONPath: "n", Enabled: false}
	other := Binding{Subject: "B", Signal: "count_ok", Source: "other", JSONPath: "n", Enabled: true}
	rs, errs := Normalize("m", []Binding{off, other}, Message{Source: "s", TS: t0, Payload: map[string]any{"n": 1.0}})
	if len(rs) != 0 || len(errs) != 0 {
		t.Fatalf("rs=%+v errs=%v", rs, errs)
	}
}

func TestNormalizeBadValuesReportErrorsButKeepGood(t *testing.T) {
	good := Binding{Subject: "A", Signal: "count_ok", Source: "s", JSONPath: "n", Enabled: true}
	missing := Binding{Subject: "B", Signal: "count_ok", Source: "s", JSONPath: "nope", Enabled: true}
	notNum := Binding{Subject: "C", Signal: "count_ok", Source: "s", JSONPath: "txt", Enabled: true}
	badEnum := Binding{Subject: "D", Signal: "state", Source: "s", JSONPath: "txt", Enabled: true,
		Transform: Transform{Enum: map[string]string{"RUN": "RUNNING"}}}
	msg := Message{Source: "s", TS: t0, Payload: map[string]any{"n": 3.0, "txt": "hello"}}
	rs, errs := Normalize("m", []Binding{good, missing, notNum, badEnum}, msg)
	if len(rs) != 1 || rs[0].Subject != "A" {
		t.Errorf("rs=%+v", rs)
	}
	if len(errs) != 3 {
		t.Errorf("errs=%v", errs)
	}
}

func TestNormalizeStateWithoutEnumUppercasesRaw(t *testing.T) {
	b := Binding{Subject: "A", Signal: "state", Source: "s", JSONPath: "st", Enabled: true}
	rs, _ := Normalize("m", []Binding{b}, Message{Source: "s", TS: t0, Payload: map[string]any{"st": "running"}})
	if len(rs) != 1 || rs[0].Text != "RUNNING" {
		t.Fatalf("%+v", rs)
	}
}

func TestNormalizeFleet(t *testing.T) {
	b := Binding{Subject: "TUG_A", Signal: "fleet", Source: "agv/tug-a/+/pos", Enabled: true,
		Transform: Transform{Fields: map[string]string{"state": "mode"}}}
	msg := Message{Source: "agv/tug-a/01/pos", TS: t0, Payload: map[string]any{
		"id": "TUG-A-01", "x": 12.5, "y": 4.0, "mode": "MOVING", "seg": "L07", "load": 20.0}}
	rs, errs := Normalize("m", []Binding{b}, msg)
	if len(errs) != 0 || len(rs) != 1 || rs[0].Fleet == nil {
		t.Fatalf("rs=%+v errs=%v", rs, errs)
	}
	v := rs[0].Fleet
	if v.ID != "TUG-A-01" || v.X != 12.5 || v.Y != 4 || v.State != "MOVING" || v.Lane != "L07" || v.Load != 20 || rs[0].Subject != "TUG_A" {
		t.Errorf("bad vehicle %+v", v)
	}
}

func TestNormalizeFleetNeedsIDAndPosition(t *testing.T) {
	b := Binding{Subject: "TUG_A", Signal: "fleet", Source: "s", Enabled: true}
	_, errs := Normalize("m", []Binding{b}, Message{Source: "s", TS: t0, Payload: map[string]any{"x": 1.0}})
	if len(errs) != 1 {
		t.Fatalf("errs=%v", errs)
	}
}

func TestNormalizeFleetAppliesFrameAndKeepsRaw(t *testing.T) {
	b := Binding{Subject: "TUG_A", Signal: "fleet", Source: "agv/+/pos", Enabled: true,
		Transform: Transform{Frame: &Frame{Scale: 0.001, RotDeg: 90, DX: 10, DY: 20}}}
	rs, errs := Normalize("m", []Binding{b}, Message{Source: "agv/a/pos", TS: t0,
		Payload: map[string]any{"id": "T1", "x": 2000.0, "y": 0.0, "th": 10.0, "st": "MOVING"}})
	if len(errs) != 0 || len(rs) != 1 {
		t.Fatalf("rs=%v errs=%v", rs, errs)
	}
	v := rs[0].Fleet
	if !near(v.X, 10) || !near(v.Y, 22) { // 2000 mm = 2 m, xoay 90° → (0,2), dịch (10,20)
		t.Errorf("toạ độ bản đồ = (%v,%v); muốn (10,22)", v.X, v.Y)
	}
	if v.RawX != 2000 || v.RawY != 0 {
		t.Errorf("toạ độ gốc phải giữ nguyên: (%v,%v)", v.RawX, v.RawY)
	}
	if v.Heading == nil || !near(*v.Heading, 100) {
		t.Errorf("hướng = %v; muốn 100", v.Heading)
	}
}

func TestNormalizeFleetWithoutHeadingLeavesItNil(t *testing.T) {
	b := Binding{Subject: "TUG_A", Signal: "fleet", Source: "s", Enabled: true}
	rs, _ := Normalize("m", []Binding{b}, Message{Source: "s", TS: t0, Payload: map[string]any{"id": "T1", "x": 1.0, "y": 2.0}})
	if rs[0].Fleet.Heading != nil {
		t.Errorf("không có trường hướng thì Heading phải nil: %v", *rs[0].Fleet.Heading)
	}
}
