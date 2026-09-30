package livesvc

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/kaizenflow/api/internal/live"
	"github.com/kaizenflow/api/internal/store"
)

type fakeStore struct {
	mu       sync.Mutex
	bindings []live.Binding
	sigs     []store.LiveSignal
	evs      []store.LiveEvent
}

func (f *fakeStore) AllBindings(context.Context) ([]live.Binding, error) { return f.bindings, nil }
func (f *fakeStore) InsertLive(_ context.Context, s []store.LiveSignal, e []store.LiveEvent) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sigs = append(f.sigs, s...)
	f.evs = append(f.evs, e...)
	return nil
}

type fakeHub struct {
	mu   sync.Mutex
	msgs []any
}

func (h *fakeHub) Broadcast(v any) { h.mu.Lock(); h.msgs = append(h.msgs, v); h.mu.Unlock() }

var t0 = time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC)

func newSvc(t *testing.T, bs ...live.Binding) (*Service, *fakeStore, *fakeHub) {
	t.Helper()
	fs := &fakeStore{bindings: bs}
	hub := &fakeHub{}
	s := New(fs, hub)
	wall := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return wall }
	if err := s.ReloadBindings(context.Background()); err != nil {
		t.Fatal(err)
	}
	return s, fs, hub
}

func bind(model, subject, signal, source, path string) live.Binding {
	return live.Binding{ModelKey: model, Subject: subject, Signal: signal, Source: source, JSONPath: path, Enabled: true}
}

func TestIngestUpdatesStateAndCountsSources(t *testing.T) {
	s, _, _ := newSvc(t, bind("m", "STAMP_2", "count_ok", "plc/prs-02/status", "cnt.ok"))
	res := s.Ingest([]live.Message{
		{Source: "plc/prs-02/status", TS: t0, Desc: "Máy dập 2", Payload: map[string]any{"cnt": map[string]any{"ok": 7.0}}},
		{Source: "plc/prs-03/status", TS: t0, Payload: map[string]any{"st": "RUN"}},
	})
	if res.Accepted != 2 || res.Readings != 1 || res.Errors != 0 {
		t.Fatalf("result = %+v", res)
	}
	snap := s.Snapshot("m")
	if snap.Subjects["STAMP_2"].Signals["count_ok"].V != 7 || len(snap.Sources) != 2 {
		t.Errorf("snapshot = %+v", snap)
	}
	if snap.Sources[0].Bound == snap.Sources[1].Bound {
		t.Errorf("exactly one source should be bound: %+v", snap.Sources)
	}
}

func TestIngestRejectsMalformedMessagesWithoutFailingTheBatch(t *testing.T) {
	s, _, _ := newSvc(t, bind("m", "A", "count_ok", "s", "n"))
	res := s.Ingest([]live.Message{
		{Source: "", TS: t0, Payload: map[string]any{"n": 1.0}},
		{Source: "s", Payload: map[string]any{"n": 1.0}}, // thiếu ts
		{Source: "s", TS: t0, Payload: map[string]any{"n": 2.0}},
	})
	if res.Accepted != 1 || res.Rejected != 2 || res.Readings != 1 {
		t.Fatalf("result = %+v", res)
	}
}

func TestIngestReportsBindingErrorsPerModel(t *testing.T) {
	s, _, _ := newSvc(t, bind("m", "A", "count_ok", "s", "nope"), bind("m", "B", "count_ok", "s", "n"))
	res := s.Ingest([]live.Message{{Source: "s", TS: t0, Payload: map[string]any{"n": 1.0}}})
	if res.Readings != 1 || res.Errors != 1 {
		t.Fatalf("result = %+v", res)
	}
	errs := s.RecentErrors("m")
	if len(errs) != 1 || errs[0].Count != 1 {
		t.Errorf("errors = %+v", errs)
	}
	s.Ingest([]live.Message{{Source: "s", TS: t0.Add(time.Second), Payload: map[string]any{"n": 1.0}}})
	if errs = s.RecentErrors("m"); len(errs) != 1 || errs[0].Count != 2 {
		t.Errorf("repeated error not folded: %+v", errs)
	}
}

func TestBindingsOfOneModelDoNotFeedAnother(t *testing.T) {
	s, _, _ := newSvc(t, bind("m1", "A", "count_ok", "s", "n"), bind("m2", "A", "count_ok", "s", "n"))
	s.Ingest([]live.Message{{Source: "s", TS: t0, Payload: map[string]any{"n": 5.0}}})
	if s.Snapshot("m1").Subjects["A"].Signals["count_ok"].V != 5 || s.Snapshot("m2").Subjects["A"].Signals["count_ok"].V != 5 {
		t.Error("both models should receive their own reading")
	}
	s.Ingest([]live.Message{{Source: "other", TS: t0, Payload: map[string]any{"n": 9.0}}})
	if s.Snapshot("m1").Subjects["A"].Signals["count_ok"].V != 5 {
		t.Error("unrelated source changed the value")
	}
}

func TestFlushPersistsThrottledSignalsAndStateChanges(t *testing.T) {
	s, fs, _ := newSvc(t,
		bind("m", "K", "level:RAW-01", "wms", "qty"),
		bind("m", "P", "state", "plc", "st"),
		bind("m", "E", "trip_s", "trip", "dur"))
	feed := func(at time.Duration, qty float64, st string, dur float64) {
		s.Ingest([]live.Message{
			{Source: "wms", TS: t0.Add(at), Payload: map[string]any{"qty": qty}},
			{Source: "plc", TS: t0.Add(at), Payload: map[string]any{"st": st}},
			{Source: "trip", TS: t0.Add(at), Payload: map[string]any{"dur": dur}},
		})
	}
	feed(0, 100, "RUNNING", 90)
	feed(5*time.Second, 99, "RUNNING", 91) // level còn trong khoảng nghỉ 30 s → bỏ; trip_s luôn ghi
	feed(40*time.Second, 90, "DOWN", 92)   // qua 30 s → ghi; trạng thái đổi → sự kiện
	feed(45*time.Second, 89, "DOWN", 93)   // trạng thái không đổi → không thêm sự kiện
	if err := s.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	count := map[string]int{}
	for _, x := range fs.sigs {
		count[x.Name]++
	}
	if count["level:RAW-01"] != 2 || count["trip_s"] != 4 {
		t.Errorf("persisted = %v", count)
	}
	states := 0
	for _, e := range fs.evs {
		if e.Type == "STATE" {
			states++
		}
	}
	if states != 2 { // RUNNING (lần đầu) rồi DOWN
		t.Errorf("state events = %d, want 2: %+v", states, fs.evs)
	}
	// Flush lần hai không ghi lại gì
	n := len(fs.sigs)
	if err := s.Flush(context.Background()); err != nil || len(fs.sigs) != n {
		t.Errorf("second flush wrote again: %d → %d (%v)", n, len(fs.sigs), err)
	}
}

func TestBroadcastOnlyDirtyModelsAndOmitsSources(t *testing.T) {
	s, _, hub := newSvc(t, bind("m", "A", "count_ok", "s", "n"))
	s.BroadcastDirty()
	if len(hub.msgs) != 0 {
		t.Fatalf("nothing changed yet, got %d messages", len(hub.msgs))
	}
	s.Ingest([]live.Message{{Source: "s", TS: t0, Payload: map[string]any{"n": 1.0}}})
	s.BroadcastDirty()
	if len(hub.msgs) != 1 {
		t.Fatalf("messages = %d", len(hub.msgs))
	}
	m := hub.msgs[0].(LiveMsg)
	if m.Type != "live" || m.Model != "m" || m.Sources != 1 || m.Subjects["A"].Signals["count_ok"].V != 1 {
		t.Errorf("bad message %+v", m)
	}
	s.BroadcastDirty()
	if len(hub.msgs) != 1 {
		t.Error("model stayed dirty after broadcast")
	}
}

func TestClearForgetsModelAndSources(t *testing.T) {
	s, _, _ := newSvc(t, bind("m", "A", "count_ok", "s", "n"))
	s.Ingest([]live.Message{{Source: "s", TS: t0, Payload: map[string]any{"n": 1.0}}})
	s.Clear("m")
	snap := s.Snapshot("m")
	if len(snap.Subjects) != 0 || len(snap.Sources) != 0 {
		t.Errorf("not cleared: %+v", snap)
	}
}
