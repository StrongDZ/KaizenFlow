package live

import (
	"testing"
	"time"
)

func num(subject, signal string, at time.Time, v float64) Reading {
	return Reading{Model: "m", Subject: subject, Signal: signal, TS: at, Num: v}
}

func TestStateApplyAndSnapshot(t *testing.T) {
	s := NewState()
	wall := time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC)
	s.Apply("m", []Reading{
		{Model: "m", Subject: "STAMP_2", Signal: "state", TS: t0, Text: "RUNNING", IsText: true},
		num("STAMP_2", "count_ok", t0, 5),
		{Model: "m", Subject: "TUG_A", Signal: "fleet", TS: t0, Fleet: &Vehicle{ID: "TUG-A-01", X: 1, Y: 2, State: "MOVING"}},
	}, wall)
	snap := s.Snapshot("m", wall.Add(3*time.Second), nil)
	st := snap.Subjects["STAMP_2"]
	if st.State != "RUNNING" || st.Signals["count_ok"].V != 5 || st.AgeMS != 3000 {
		t.Errorf("subject snap %+v", st)
	}
	if !snap.Now.Equal(t0) {
		t.Errorf("now = %v", snap.Now)
	}
	if len(snap.Fleet["TUG_A"]) != 1 || snap.Fleet["TUG_A"][0].ID != "TUG-A-01" {
		t.Errorf("fleet %+v", snap.Fleet)
	}
}

func TestStateNowIsMaxTimestampAndIgnoresOlderReadings(t *testing.T) {
	s := NewState()
	wall := time.Now()
	s.Apply("m", []Reading{num("A", "count_ok", t0.Add(10*time.Second), 10)}, wall)
	s.Apply("m", []Reading{num("A", "count_ok", t0, 1)}, wall)
	snap := s.Snapshot("m", wall, nil)
	if snap.Subjects["A"].Signals["count_ok"].V != 10 || !snap.Now.Equal(t0.Add(10*time.Second)) {
		t.Errorf("older reading overwrote newer: %+v", snap)
	}
}

func TestStateRateForMoved(t *testing.T) {
	s := NewState()
	wall := time.Now()
	for i := 0; i < 5; i++ {
		s.Apply("m", []Reading{num("E1", "moved", t0.Add(time.Duration(i*10)*time.Second), float64(i*20))}, wall)
	}
	snap := s.Snapshot("m", wall, nil)
	r := snap.Subjects["E1"].Rate
	if r == nil || *r < 1.99 || *r > 2.01 {
		t.Fatalf("rate = %v, want 2/s", r)
	}
}

func TestStateSignalRateUsesRecentHistory(t *testing.T) {
	s := NewState()
	wall := time.Now()
	points := []struct {
		at time.Time
		v  float64
	}{
		{t0, 10},
		{t0.Add(2 * time.Hour), 34},
		{t0.Add(4 * time.Hour), 58},
		{t0.Add(6 * time.Hour), 82},
	}
	for _, p := range points {
		s.Apply("m", []Reading{num("SHIP_A", "demand", p.at, p.v)}, wall)
	}
	rate, samples, spanH, ok := s.SignalRate("m", "SHIP_A", "demand", 6*time.Hour)
	if !ok {
		t.Fatal("SignalRate returned false")
	}
	if samples != 4 || spanH < 5.9 || spanH > 6.1 {
		t.Fatalf("SignalRate window = samples:%d span:%v", samples, spanH)
	}
	if rate < 11.9 || rate > 12.1 {
		t.Fatalf("SignalRate = %v, want 12/h", rate)
	}
}

func TestStateCoverageFromLevelDrops(t *testing.T) {
	s := NewState()
	wall := time.Now()
	// 60 phút, tồn giảm 10 mỗi 10 phút (=60/giờ), có một lần nạp +100 không được tính là tiêu thụ.
	levels := []float64{300, 290, 280, 270, 360, 350, 340}
	for i, lv := range levels {
		s.Apply("m", []Reading{num("KHO", "level:RAW-01", t0.Add(time.Duration(i*10)*time.Minute), lv)}, wall)
	}
	snap := s.Snapshot("m", wall, nil)
	cov, ok := snap.Subjects["KHO"].Signals["coverage_h"]
	if !ok {
		t.Fatal("no coverage_h")
	}
	// 5 lần giảm × 10 = 50 trong 60 phút → 50/giờ; 340/50 = 6,8 giờ
	if cov.V < 6.7 || cov.V > 6.9 {
		t.Errorf("coverage_h = %v, want ≈6.8", cov.V)
	}
}

func TestCoverageNeedsHistoryAndReportsNoUse(t *testing.T) {
	if _, ok := Coverage([]Sample{{TS: t0, V: 100}}, 3600); ok {
		t.Error("one sample is not enough")
	}
	flat := []Sample{{TS: t0, V: 100}, {TS: t0.Add(20 * time.Minute), V: 100}}
	cov, ok := Coverage(flat, 3600)
	if !ok || cov != NoUseCoverage {
		t.Errorf("flat level → %v %v, want %v", cov, ok, NoUseCoverage)
	}
}

func TestStatePrunesHistoryToWindow(t *testing.T) {
	s := NewState()
	wall := time.Now()
	for i := 0; i < 600; i++ {
		s.Apply("m", []Reading{num("K", "level:X", t0.Add(time.Duration(i)*time.Minute), 1000-float64(i))}, wall)
	}
	if n := s.historyLen("m", "K", "level:X"); n > 380 {
		t.Errorf("history not pruned: %d", n)
	}
}

func TestSnapshotMarksBoundSources(t *testing.T) {
	s := NewState()
	wall := time.Now()
	s.NoteSource("", Message{Source: "plc/prs-02/status", TS: t0, Desc: "Máy dập 2", Payload: map[string]any{"st": "RUN"}}, wall)
	s.NoteSource("", Message{Source: "plc/prs-03/status", TS: t0, Payload: map[string]any{"st": "RUN"}}, wall)
	bs := []Binding{{Subject: "STAMP_2", Signal: "state", Source: "plc/prs-02/status", Enabled: true}}
	snap := s.Snapshot("m", wall, bs)
	if len(snap.Sources) != 2 {
		t.Fatalf("sources = %+v", snap.Sources)
	}
	bound := map[string]bool{}
	for _, so := range snap.Sources {
		bound[so.Source] = so.Bound
	}
	if !bound["plc/prs-02/status"] || bound["plc/prs-03/status"] {
		t.Errorf("bound flags = %v", bound)
	}
	if snap.Sources[0].Desc == "" && snap.Sources[1].Desc == "" {
		t.Error("desc lost")
	}
}

func TestSnapshotListsOnlyTheSourcesOfItsOwnModelPlusUntaggedOnes(t *testing.T) {
	s := NewState()
	wall := time.Now()
	s.NoteSource("a", Message{Source: "feed-a/x", TS: t0, Payload: 1.0}, wall)
	s.NoteSource("b", Message{Source: "feed-b/y", TS: t0, Payload: 1.0}, wall)
	s.NoteSource("", Message{Source: "mqtt/z", TS: t0, Payload: 1.0}, wall)
	names := func(model string) map[string]bool {
		out := map[string]bool{}
		for _, so := range s.Snapshot(model, wall, nil).Sources {
			out[so.Source] = true
		}
		return out
	}
	if got := names("a"); !got["feed-a/x"] || got["feed-b/y"] || !got["mqtt/z"] || len(got) != 2 {
		t.Errorf("a sees %v", got)
	}
	if got := names("b"); got["feed-a/x"] || !got["feed-b/y"] || !got["mqtt/z"] || len(got) != 2 {
		t.Errorf("b sees %v", got)
	}
}

func TestSameSourceFromTwoModelsIsCountedPerModel(t *testing.T) {
	s := NewState()
	wall := time.Now()
	for i := 0; i < 3; i++ {
		s.NoteSource("a", Message{Source: "plc/m/status", TS: t0, Payload: 1.0}, wall)
	}
	s.NoteSource("b", Message{Source: "plc/m/status", TS: t0, Payload: 1.0}, wall)
	count := func(model string) int64 {
		for _, so := range s.Snapshot(model, wall, nil).Sources {
			return so.Count
		}
		return -1
	}
	if count("a") != 3 || count("b") != 1 {
		t.Errorf("a=%d b=%d, muốn 3 và 1", count("a"), count("b"))
	}
}

// Danh mục nguồn toàn cục: một topic là một dòng dù hai feed cùng phát; bản tin mới nhất thắng, số bản tin cộng lại.
func TestAllSourcesMergesTheSameTopicAcrossModels(t *testing.T) {
	s := NewState()
	wall := time.Now()
	for i := 0; i < 3; i++ {
		s.NoteSource("a", Message{Source: "plc/m/status", TS: t0, Desc: "Máy M", Payload: 1.0}, wall.Add(-time.Minute))
	}
	s.NoteSource("b", Message{Source: "plc/m/status", TS: t0.Add(time.Minute), Payload: 2.0}, wall)
	s.NoteSource("", Message{Source: "mqtt/z", TS: t0, Payload: 9.0}, wall)
	all := s.AllSources(wall)
	if len(all) != 2 || all[0].Source != "mqtt/z" || all[1].Source != "plc/m/status" {
		t.Fatalf("nguồn = %+v", all)
	}
	m := all[1]
	if m.Count != 4 || m.Last != 2.0 || m.AgeMS != 0 || m.Desc != "Máy M" {
		t.Errorf("gộp sai: %+v", m)
	}
}

func TestStateClearForgetsModel(t *testing.T) {
	s := NewState()
	s.Apply("m", []Reading{num("A", "count_ok", t0, 1)}, time.Now())
	s.Clear("m")
	if snap := s.Snapshot("m", time.Now(), nil); len(snap.Subjects) != 0 {
		t.Errorf("not cleared: %+v", snap)
	}
}

// Feed bắt đầu lại với giờ ảo sớm hơn giờ ảo của phiên trước (phiên trước chạy ×600 nên đã đi xa vào tương lai): bản tin mới
// không được bị coi là "cũ hơn" rồi bỏ đi, nếu không giao diện đứng hình.
func TestStateStartsANewSessionWhenTimeJumpsFarBackwards(t *testing.T) {
	s := NewState()
	wall := time.Now()
	s.Apply("m", []Reading{num("A", "count_ok", t0.Add(48*time.Hour), 500), {Model: "m", Subject: "A", Signal: "state", TS: t0.Add(48 * time.Hour), Text: "DOWN", IsText: true}}, wall)
	s.Apply("m", []Reading{num("A", "count_ok", t0, 3), {Model: "m", Subject: "A", Signal: "state", TS: t0, Text: "RUNNING", IsText: true}}, wall)
	snap := s.Snapshot("m", wall, nil)
	if snap.Subjects["A"].Signals["count_ok"].V != 3 || snap.Subjects["A"].State != "RUNNING" || !snap.Now.Equal(t0) {
		t.Errorf("the new session must replace the old one: %+v now=%v", snap.Subjects["A"], snap.Now)
	}
	if s.Now("m") != t0 {
		t.Errorf("Now = %v, want %v", s.Now("m"), t0)
	}
}

func TestStateKeepsIgnoringSmallOutOfOrderReadings(t *testing.T) {
	s := NewState()
	wall := time.Now()
	s.Apply("m", []Reading{num("A", "count_ok", t0.Add(10*time.Minute), 10)}, wall)
	s.Apply("m", []Reading{num("A", "count_ok", t0.Add(7*time.Minute), 7)}, wall) // muộn 3 phút: chỉ là bản tin đến trễ
	if s.Snapshot("m", wall, nil).Subjects["A"].Signals["count_ok"].V != 10 {
		t.Error("a late reading within the tolerance must not overwrite a newer value")
	}
}

func TestApplyRemembersWhenAValueLastChanged(t *testing.T) {
	s := NewState()
	wall := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	put := func(ts time.Time, v float64) {
		s.Apply("m", []Reading{{Model: "m", Subject: "P", Signal: "count_in", TS: ts, Num: v}}, wall)
	}
	base := time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC)
	put(base, 5)
	if v, _ := s.Value("m", Ref{"P", "count_in"}); !v.Changed.IsZero() {
		t.Fatalf("mẫu đầu tiên chưa biết đổi lúc nào: %+v", v)
	}
	put(base.Add(10*time.Second), 5) // không đổi
	put(base.Add(20*time.Second), 6) // đổi
	put(base.Add(30*time.Second), 6) // không đổi
	v, ok := s.Value("m", Ref{"P", "count_in"})
	if !ok || v.V != 6 || !v.Changed.Equal(base.Add(20*time.Second)) {
		t.Fatalf("value = %+v, ok = %v; Changed phải là lúc đổi gần nhất", v, ok)
	}
	if _, ok := s.Value("m", Ref{"P", "nope"}); ok {
		t.Fatal("tín hiệu chưa có")
	}
	if !s.Now("m").Equal(base.Add(30 * time.Second)) {
		t.Fatalf("Now = %v", s.Now("m"))
	}
}

func fleetReading(id string, x, y float64, state, lane string) Reading {
	return Reading{Model: "m", Subject: "TUG_A", Signal: "fleet", TS: t0, Fleet: &Vehicle{ID: id, X: x, Y: y, State: state, Lane: lane}}
}

func TestStateMatchesVehiclesToLanes(t *testing.T) {
	s := NewState()
	s.SetMap("m", matchMap())
	wall := time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC)
	s.Apply("m", []Reading{
		fleetReading("on", 10, -1, "MOVING", ""),
		fleetReading("lost", 10, 9, "MOVING", ""),
		fleetReading("told", 30, 5, "MOVING", "BC"), // xe tự báo làn: tin theo, chỉ tính S
	}, wall)
	got := map[string]Vehicle{}
	for _, v := range s.Snapshot("m", wall, nil).Fleet["TUG_A"] {
		got[v.ID] = v
	}
	if v := got["on"]; v.Lane != "AB" || v.Off || !near(v.S, 10) {
		t.Errorf("on = %+v", v)
	}
	if v := got["lost"]; v.Lane != "" || !v.Off {
		t.Errorf("lost phải ngoài đường: %+v", v)
	}
	if v := got["told"]; v.Lane != "BC" || v.Off || !near(v.S, 10) {
		t.Errorf("told = %+v (làn tự báo giữ nguyên, S = 10 dọc BC)", v)
	}
}

func TestStateKeepsPreviousLaneBetweenMessages(t *testing.T) {
	s := NewState()
	s.SetMap("m", matchMap())
	wall := time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC)
	s.Apply("m", []Reading{fleetReading("v", 5, 0.1, "MOVING", "BA")}, wall) // tự báo BA
	s.Apply("m", []Reading{fleetReading("v", 6, 0.1, "MOVING", "")}, wall)   // lần sau không báo: giữ BA
	if v := s.Snapshot("m", wall, nil).Fleet["TUG_A"][0]; v.Lane != "BA" {
		t.Errorf("phải giữ làn cũ khi hai làn ngang nhau: %+v", v)
	}
}

func TestStateWithoutMapLeavesVehiclesAlone(t *testing.T) {
	s := NewState()
	wall := time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC)
	s.Apply("m", []Reading{fleetReading("v", 5, 0.1, "MOVING", "")}, wall)
	if v := s.Snapshot("m", wall, nil).Fleet["TUG_A"][0]; v.Lane != "" || v.Off {
		t.Errorf("chưa có bản đồ thì không kết luận gì: %+v", v)
	}
}
