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
	for i := 0; i < 300; i++ {
		s.Apply("m", []Reading{num("K", "level:X", t0.Add(time.Duration(i)*time.Minute), 1000-float64(i))}, wall)
	}
	if n := s.historyLen("m", "K", "level:X"); n > 130 {
		t.Errorf("history not pruned: %d", n)
	}
}

func TestSnapshotMarksBoundSources(t *testing.T) {
	s := NewState()
	wall := time.Now()
	s.NoteSource(Message{Source: "plc/prs-02/status", TS: t0, Desc: "Máy dập 2", Payload: map[string]any{"st": "RUN"}}, wall)
	s.NoteSource(Message{Source: "plc/prs-03/status", TS: t0, Payload: map[string]any{"st": "RUN"}}, wall)
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

func TestStateClearForgetsModel(t *testing.T) {
	s := NewState()
	s.Apply("m", []Reading{num("A", "count_ok", t0, 1)}, time.Now())
	s.Clear("m")
	if snap := s.Snapshot("m", time.Now(), nil); len(snap.Subjects) != 0 {
		t.Errorf("not cleared: %+v", snap)
	}
}
