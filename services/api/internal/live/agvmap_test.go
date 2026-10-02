package live

import (
	"math"
	"testing"
)

const okMap = `{"unit_m":1,"speed_mps":1.4,
 "points":[{"id":"A","x":0,"y":0,"kind":"station","node_key":"KHO"},{"id":"B","x":10,"y":0,"kind":"junction"}],
 "lanes":[{"id":"L1","from":"A","to":"B","capacity":2},{"id":"L2","from":"B","to":"A","capacity":1}]}`

func TestParseAndValidateMap(t *testing.T) {
	m, err := ParseMap([]byte(okMap))
	if err != nil {
		t.Fatal(err)
	}
	if issues := m.Validate(map[string]bool{"KHO": true}); len(issues) != 0 {
		t.Errorf("issues = %+v", issues)
	}
	if issues := m.Validate(nil); len(issues) != 0 {
		t.Errorf("nil node set means 'do not check node links': %+v", issues)
	}
}

func TestValidateMapFindsProblems(t *testing.T) {
	cases := map[string]string{
		"duplicate point": `{"speed_mps":1,"points":[{"id":"A","x":0,"y":0,"kind":"junction"},{"id":"A","x":1,"y":0,"kind":"junction"}],"lanes":[]}`,
		"bad kind":        `{"speed_mps":1,"points":[{"id":"A","x":0,"y":0,"kind":"garage"}],"lanes":[]}`,
		"lane to nowhere": `{"speed_mps":1,"points":[{"id":"A","x":0,"y":0,"kind":"junction"}],"lanes":[{"id":"L","from":"A","to":"Z","capacity":1}]}`,
		"self lane":       `{"speed_mps":1,"points":[{"id":"A","x":0,"y":0,"kind":"junction"}],"lanes":[{"id":"L","from":"A","to":"A","capacity":1}]}`,
		"zero capacity":   `{"speed_mps":1,"points":[{"id":"A","x":0,"y":0,"kind":"junction"},{"id":"B","x":1,"y":0,"kind":"junction"}],"lanes":[{"id":"L","from":"A","to":"B","capacity":0}]}`,
		"duplicate lane":  `{"speed_mps":1,"points":[{"id":"A","x":0,"y":0,"kind":"junction"},{"id":"B","x":1,"y":0,"kind":"junction"}],"lanes":[{"id":"L","from":"A","to":"B","capacity":1},{"id":"L","from":"B","to":"A","capacity":1}]}`,
		"no speed":        `{"points":[],"lanes":[]}`,
		"unknown node":    `{"speed_mps":1,"points":[{"id":"A","x":0,"y":0,"kind":"station","node_key":"NOPE"}],"lanes":[]}`,
	}
	for name, raw := range cases {
		m, err := ParseMap([]byte(raw))
		if err != nil {
			t.Errorf("%s: parse error %v", name, err)
			continue
		}
		if issues := m.Validate(map[string]bool{"KHO": true}); len(issues) == 0 {
			t.Errorf("%s: expected an issue", name)
		}
	}
	if _, err := ParseMap([]byte(`{not json`)); err == nil {
		t.Error("bad json must fail to parse")
	}
}

func TestTravelShortestPathBetweenNodeStations(t *testing.T) {
	m := &AgvMap{UnitM: 2, SpeedMPS: 1, Points: []MapPoint{
		{ID: "A", X: 0, Y: 0, Kind: "station", NodeKey: "SRC"},
		{ID: "J", X: 5, Y: 0, Kind: "junction"},
		{ID: "B", X: 10, Y: 0, Kind: "station", NodeKey: "DST"},
		{ID: "X", X: 5, Y: 50, Kind: "junction"},
	}, Lanes: []MapLane{
		{ID: "L1", From: "A", To: "J", Capacity: 1}, {ID: "L2", From: "J", To: "B", Capacity: 1},
		{ID: "L3", From: "A", To: "X", Capacity: 1}, {ID: "L4", From: "X", To: "B", Capacity: 1},
	}}
	secs, ok := m.Travel("SRC", "DST")
	if !ok || secs < 19.99 || secs > 20.01 { // (5+5) đơn vị × 2 m ÷ 1 m/s
		t.Fatalf("Travel = %v, %v; muốn 20", secs, ok)
	}
	if _, ok := m.Travel("DST", "SRC"); ok {
		t.Fatal("làn một chiều: không có đường về")
	}
	if _, ok := m.Travel("SRC", "NOPE"); ok {
		t.Fatal("node không có trạm trên bản đồ")
	}
	m.SpeedMPS = 0
	if _, ok := m.Travel("SRC", "DST"); ok {
		t.Fatal("tốc độ 0 thì không tính được")
	}
}

const legacyMap = `{"unit_m":1.5,"speed_mps":1.2,
 "points":[{"id":"A","x":0,"y":0,"kind":"station","node_key":"KHO"},{"id":"B","x":10,"y":20,"kind":"junction"}],
 "lanes":[{"id":"L1","from":"A","to":"B","capacity":2}]}`

func TestParseMapConvertsLegacyUnitsToMeters(t *testing.T) {
	m, err := ParseMap([]byte(legacyMap))
	if err != nil {
		t.Fatal(err)
	}
	if m.Version != 2 || m.UnitM != 0 {
		t.Fatalf("Version=%d UnitM=%v; muốn v2 và bỏ unit_m", m.Version, m.UnitM)
	}
	if b := m.Points[1]; b.X != 15 || b.Y != 30 {
		t.Errorf("điểm B = (%v,%v); muốn (15,30) mét", b.X, b.Y)
	}
	want := math.Hypot(15, 30)
	if got := m.LaneLengthM(m.Lanes[0]); math.Abs(got-want) > 1e-9 {
		t.Errorf("độ dài làn = %v; muốn %v", got, want)
	}
}

func TestParseMapV2KeepsMetersAndPath(t *testing.T) {
	raw := `{"v":2,"speed_mps":1,"points":[{"id":"A","x":0,"y":0,"kind":"junction"},{"id":"B","x":10,"y":0,"kind":"junction"}],
	 "lanes":[{"id":"L","from":"A","to":"B","capacity":1,"path":[{"x":5,"y":5}]}]}`
	m, err := ParseMap([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if m.Points[1].X != 10 {
		t.Errorf("v2 không được nhân thêm: %v", m.Points[1].X)
	}
	poly := m.Polyline(m.Lanes[0])
	if len(poly) != 3 || poly[1] != (Pt{5, 5}) {
		t.Fatalf("polyline = %+v", poly)
	}
	want := 2 * math.Hypot(5, 5)
	if got := m.LaneLengthM(m.Lanes[0]); math.Abs(got-want) > 1e-9 {
		t.Errorf("độ dài = %v; muốn %v (đường gấp khúc, không phải đoạn thẳng 10)", got, want)
	}
}

func TestNormalizeScalesLanePathOfLegacyMaps(t *testing.T) {
	m := &AgvMap{UnitM: 2, SpeedMPS: 1,
		Points: []MapPoint{{ID: "A", Kind: "junction"}, {ID: "B", X: 10, Kind: "junction"}},
		Lanes:  []MapLane{{ID: "L", From: "A", To: "B", Capacity: 1, Path: []Pt{{5, 5}}}}}
	m.Normalize()
	if p := m.Lanes[0].Path[0]; p != (Pt{10, 10}) {
		t.Errorf("điểm uốn = %+v; muốn (10,10)", p)
	}
	m.Normalize() // chạy lại không nhân đôi
	if m.Points[1].X != 20 || m.Lanes[0].Path[0] != (Pt{10, 10}) {
		t.Errorf("Normalize phải idempotent: %+v %+v", m.Points[1], m.Lanes[0].Path)
	}
}

func TestValidateRejectsNonFinitePath(t *testing.T) {
	m := &AgvMap{Version: 2, SpeedMPS: 1,
		Points: []MapPoint{{ID: "A", Kind: "junction"}, {ID: "B", X: 1, Kind: "junction"}},
		Lanes:  []MapLane{{ID: "L", From: "A", To: "B", Capacity: 1, Path: []Pt{{math.NaN(), 0}}}}}
	if len(m.Validate(nil)) == 0 {
		t.Error("điểm uốn NaN phải bị báo")
	}
}

func TestZeroLengthLaneIsSafe(t *testing.T) {
	m := &AgvMap{Version: 2, SpeedMPS: 1,
		Points: []MapPoint{{ID: "A", Kind: "junction"}, {ID: "B", Kind: "junction"}},
		Lanes:  []MapLane{{ID: "L", From: "A", To: "B", Capacity: 1}}}
	if got := m.LaneLengthM(m.Lanes[0]); got != 0 {
		t.Errorf("length = %v", got)
	}
	s, d := m.project(m.Lanes[0], 3, 4)
	if s != 0 || math.Abs(d-5) > 1e-9 {
		t.Errorf("project trên làn dài 0 = (%v,%v); muốn (0,5)", s, d)
	}
}
