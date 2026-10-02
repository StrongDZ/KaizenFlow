package live

import "testing"

// Khung: làn nằm ngang A(0,0)→B(20,0), làn ngược B→A dịch 0,2 m sang bên, làn nối tiếp B→C(40,0), làn rẽ B→D(20,20).
func matchMap() *AgvMap {
	return &AgvMap{Version: 2, SpeedMPS: 1,
		Points: []MapPoint{
			{ID: "A", X: 0, Y: 0, Kind: "junction"}, {ID: "B", X: 20, Y: 0, Kind: "junction"},
			{ID: "C", X: 40, Y: 0, Kind: "junction"}, {ID: "D", X: 20, Y: 20, Kind: "junction"}},
		Lanes: []MapLane{
			{ID: "AB", From: "A", To: "B", Capacity: 2},
			{ID: "BC", From: "B", To: "C", Capacity: 2},
			{ID: "BD", From: "B", To: "D", Capacity: 2},
			{ID: "BA", From: "B", To: "A", Capacity: 2, Path: []Pt{{10, 0.2}}},
		}}
}

func TestMatchNearestLaneAndProgress(t *testing.T) {
	m := matchMap()
	got := m.Match(10, -1, MatchIn{})
	if got.Off || got.Lane != "AB" || !near(got.S, 10) || !near(got.Dist, 1) {
		t.Errorf("Match = %+v", got)
	}
}

func TestMatchOutsideToleranceIsOffMap(t *testing.T) {
	m := matchMap()
	got := m.Match(10, 8, MatchIn{})
	if !got.Off || got.Lane != "" {
		t.Errorf("xe cách làn 8 m phải ngoài đường: %+v", got)
	}
}

func TestMatchOppositeLanesUseHeading(t *testing.T) {
	m := matchMap()
	east, west := 0.0, 180.0
	if got := m.Match(5, 0.1, MatchIn{Heading: &east}); got.Lane != "AB" {
		t.Errorf("hướng đông phải vào AB: %+v", got)
	}
	if got := m.Match(5, 0.1, MatchIn{Heading: &west}); got.Lane != "BA" {
		t.Errorf("hướng tây phải vào BA: %+v", got)
	}
}

func TestMatchPrefersPreviousLaneWhenTied(t *testing.T) {
	m := matchMap()
	if got := m.Match(5, 0.1, MatchIn{PrevLane: "BA"}); got.Lane != "BA" {
		t.Errorf("giữ làn cũ khi hai làn ngang nhau: %+v", got)
	}
}

func TestMatchAtJunctionUsesState(t *testing.T) {
	m := matchMap()
	// Đúng ngã ba B: AB (cuối làn), BC và BD (đầu làn) đều cách 0 m.
	if got := m.Match(20, 0, MatchIn{State: "WAITING"}); got.Lane != "AB" || !near(got.S, 20) {
		t.Errorf("xe đang chờ ở ngã ba là chờ ở cuối làn đến: %+v", got)
	}
	if got := m.Match(20, 0, MatchIn{State: "MOVING"}); got.Lane == "AB" || got.S != 0 {
		t.Errorf("xe đang chạy ngay ngã ba vừa rời đầu làn kế: %+v", got)
	}
}

func TestMatchFollowsPolylineNotChord(t *testing.T) {
	m := &AgvMap{Version: 2, SpeedMPS: 1,
		Points: []MapPoint{{ID: "A", X: 0, Y: 0, Kind: "junction"}, {ID: "B", X: 10, Y: 0, Kind: "junction"}},
		Lanes:  []MapLane{{ID: "L", From: "A", To: "B", Capacity: 1, Path: []Pt{{5, 8}}}}}
	if got := m.Match(5, 8, MatchIn{}); got.Off || !near(got.Dist, 0) {
		t.Errorf("điểm uốn nằm trên làn: %+v", got)
	}
	if got := m.Match(5, 0, MatchIn{}); !got.Off {
		t.Errorf("đoạn thẳng nối hai đầu không phải là làn (cách 8 m): %+v", got)
	}
}
