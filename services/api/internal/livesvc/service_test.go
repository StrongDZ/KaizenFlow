package livesvc

import (
	"context"
	"errors"
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
	srcs     []store.DataSource // mỗi phần tử là một lần ghi (không gộp)
	srcErr   error
}

func (f *fakeStore) UpsertSources(_ context.Context, list []store.DataSource) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.srcErr != nil {
		return f.srcErr
	}
	f.srcs = append(f.srcs, list...)
	return nil
}

// sourceWrites: các lần ghi của một nguồn. Danh mục nguồn là toàn cục nên không lọc theo mô hình.
func (f *fakeStore) sourceWrites(source string) []store.DataSource {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []store.DataSource
	for _, d := range f.srcs {
		if d.Source == source {
			out = append(out, d)
		}
	}
	return out
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

var errBoom = errors.New("boom")

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
	wall := s.now()
	feed := func(at time.Duration, qty float64, st string, dur float64) {
		wall = wall.Add(2 * time.Second) // mỗi lần phát cách nhau 2 giây thực
		s.now = func() time.Time { return wall }
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

// Ở tốc độ ×600 mỗi lần phát cách nhau hàng phút giờ ảo: nếu chỉ dựa vào khoảng nghỉ giờ ảo thì mọi tín hiệu đều được ghi ở
// mọi lần phát. Phải có thêm giới hạn theo giờ thực để bảng signal không phình ra hàng triệu dòng mỗi giờ.
func TestFlushAlsoThrottlesByWallClockSoFastFeedsDoNotFloodTheDatabase(t *testing.T) {
	s, fs, _ := newSvc(t, bind("m", "K", "level:RAW-01", "wms", "qty"))
	wall := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return wall }
	for i := 0; i < 20; i++ {
		// giờ ảo nhảy 10 phút mỗi lần, giờ thực chỉ 0,1 giây
		s.Ingest([]live.Message{{Source: "wms", TS: t0.Add(time.Duration(i) * 10 * time.Minute), Payload: map[string]any{"qty": float64(100 - i)}}})
		wall = wall.Add(100 * time.Millisecond)
	}
	if err := s.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := len(fs.sigs); n > 3 {
		t.Errorf("20 messages in 2 wall-clock seconds wrote %d rows; want at most one per wall second", n)
	}
	if len(fs.sigs) == 0 {
		t.Error("the first sample must be written")
	}
}

// Đặt lại demo: dòng của phiên cũ còn nằm trong hàng đợi ghi DB không được ghi sau khi đã xoá.
func TestClearDropsPendingRowsOfThatModelOnly(t *testing.T) {
	s, fs, _ := newSvc(t, bind("m", "K", "level:RAW-01", "wms", "qty"), bind("other", "K", "level:RAW-01", "wms", "qty"))
	s.Ingest([]live.Message{{Source: "wms", TS: t0, Payload: map[string]any{"qty": 5.0}}})
	s.Clear("m")
	if err := s.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, r := range fs.sigs {
		if r.Model == "m" {
			t.Errorf("a row of the cleared model was still written: %+v", r)
		}
	}
	if len(fs.sigs) != 1 || fs.sigs[0].Model != "other" {
		t.Errorf("the other model's row must survive: %+v", fs.sigs)
	}
}

// Một nguồn là một thiết bị/topic ngoài đời nên ghi vào danh mục MỘT lần, không nhân theo mô hình.
func TestIngestRegistersEachSourceOnceGlobally(t *testing.T) {
	s, fs, _ := newSvc(t)
	s.IngestFor("m", []live.Message{
		{Source: "plc/prs-02/status", TS: t0, Desc: "Máy dập 2", Payload: map[string]any{"st": "RUN"}},
		{Source: "plc/prs-02/status", TS: t0.Add(time.Second), Payload: map[string]any{"st": "IDLE"}},
	})
	if err := s.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	w := fs.sourceWrites("plc/prs-02/status")
	if len(w) != 1 {
		t.Fatalf("writes = %+v", fs.srcs)
	}
	if w[0].Count != 2 || w[0].Desc != "Máy dập 2" || w[0].Origin != "feed" || string(w[0].Sample) != `{"st":"IDLE"}` {
		t.Fatalf("write = %+v (sample %s)", w[0], w[0].Sample)
	}
	// Lô của mô hình khác, cùng tên nguồn: vẫn là một nguồn, cộng dồn chứ không thêm hàng mới.
	s.IngestFor("khac", []live.Message{{Source: "plc/prs-02/status", TS: t0.Add(2 * time.Second), Payload: map[string]any{"st": "RUN"}}})
	s.srcFlushed = map[string]time.Time{}
	if err := s.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if w := fs.sourceWrites("plc/prs-02/status"); len(w) != 2 || w[1].ModelKey != "" {
		t.Fatalf("nguồn không được gắn vào mô hình nào: %+v", w)
	}
}

// Danh mục nguồn là danh sách "thiết bị nào đang gửi dữ liệu", nên ghi cả nguồn chưa ghép nối —
// đó chính là cái người dùng cần thấy để ghép tiếp. (Trước đây nguồn chưa ghép bị bỏ qua.)
func TestIngestRegistersSourcesEvenBeforeTheyAreBound(t *testing.T) {
	s, fs, _ := newSvc(t, bind("m1", "A", "count_ok", "dev/+/n", "n"), bind("m2", "B", "count_ok", "dev/x/n", "n"))
	s.Ingest([]live.Message{
		{Source: "dev/x/n", TS: t0, Payload: map[string]any{"n": 1.0}},
		{Source: "other/y", TS: t0, Payload: map[string]any{"n": 1.0}},
	})
	if err := s.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(fs.sourceWrites("dev/x/n")) != 1 {
		t.Fatalf("nguồn đã ghép phải có trong danh mục: %+v", fs.srcs)
	}
	if len(fs.sourceWrites("other/y")) != 1 {
		t.Fatalf("nguồn chưa ghép cũng phải vào danh mục để còn ghép được: %+v", fs.srcs)
	}
}

// Hai mô hình có thể dùng chung tên nguồn (mô hình sao chép giữ nguyên ghép nối). Feed của mô hình A gửi kèm model=A
// thì bản tin chỉ được áp cho A: nếu rò sang B, hai mô hình chạy song song sẽ ghi đè trạng thái của nhau.
func TestIngestForOnlyFeedsTheNamedModel(t *testing.T) {
	s, _, _ := newSvc(t,
		bind("a", "M", "count_ok", "plc/m/status", "n"),
		bind("b", "M", "count_ok", "plc/m/status", "n"))
	res := s.IngestFor("a", []live.Message{{Source: "plc/m/status", TS: t0, Payload: map[string]any{"n": 5.0}}})
	if res.Readings != 1 {
		t.Fatalf("result = %+v", res)
	}
	if got := s.Snapshot("a").Subjects["M"].Signals["count_ok"].V; got != 5 {
		t.Errorf("a = %v, muốn 5", got)
	}
	if _, leaked := s.Snapshot("b").Subjects["M"]; leaked {
		t.Errorf("bản tin của feed A rò sang mô hình B: %+v", s.Snapshot("b").Subjects["M"])
	}
}

func TestIngestForTwoModelsRunsIndependentVirtualClocks(t *testing.T) {
	s, _, _ := newSvc(t,
		bind("a", "M", "count_ok", "plc/m/status", "n"),
		bind("b", "M", "count_ok", "plc/m/status", "n"))
	later := t0.Add(5 * time.Hour)
	s.IngestFor("a", []live.Message{{Source: "plc/m/status", TS: later, Payload: map[string]any{"n": 50.0}}})
	s.IngestFor("b", []live.Message{{Source: "plc/m/status", TS: t0, Payload: map[string]any{"n": 3.0}}})
	if got := s.Snapshot("a").Subjects["M"].Signals["count_ok"].V; got != 50 {
		t.Errorf("a = %v, muốn 50: giờ ảo chậm hơn của B không được làm A bỏ mẫu", got)
	}
	if got := s.Snapshot("b").Subjects["M"].Signals["count_ok"].V; got != 3 {
		t.Errorf("b = %v, muốn 3", got)
	}
	if !s.Snapshot("a").Now.Equal(later) || !s.Snapshot("b").Now.Equal(t0) {
		t.Errorf("giờ ảo: a=%v b=%v", s.Snapshot("a").Now, s.Snapshot("b").Now)
	}
}

func TestIngestWithoutModelStillFeedsEveryModelWithAMatchingBinding(t *testing.T) {
	s, _, _ := newSvc(t,
		bind("a", "M", "count_ok", "plc/m/status", "n"),
		bind("b", "M", "count_ok", "plc/m/status", "n"))
	s.Ingest([]live.Message{{Source: "plc/m/status", TS: t0, Payload: map[string]any{"n": 7.0}}})
	for _, m := range []string{"a", "b"} {
		if got := s.Snapshot(m).Subjects["M"].Signals["count_ok"].V; got != 7 {
			t.Errorf("%s = %v, muốn 7 (nguồn thật dùng chung)", m, got)
		}
	}
}

func TestSourceWritesAreThrottledAndOnlyCarryTheNewCount(t *testing.T) {
	s, fs, _ := newSvc(t)
	wall := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return wall }
	ctx := context.Background()
	s.IngestFor("m", []live.Message{{Source: "s", TS: t0, Payload: 1.0}})
	_ = s.Flush(ctx)
	s.IngestFor("m", []live.Message{{Source: "s", TS: t0, Payload: 2.0}, {Source: "s", TS: t0, Payload: 3.0}})
	wall = wall.Add(3 * time.Second) // chưa đủ 10 giây
	_ = s.Flush(ctx)
	if n := len(fs.sourceWrites("s")); n != 1 {
		t.Fatalf("ghi quá dày: %d lần", n)
	}
	wall = wall.Add(8 * time.Second) // đã quá 10 giây kể từ lần ghi trước
	_ = s.Flush(ctx)
	w := fs.sourceWrites("s")
	if len(w) != 2 || w[1].Count != 2 {
		t.Fatalf("lần ghi thứ hai chỉ mang phần mới (2): %+v", w)
	}
	wall = wall.Add(time.Minute)
	_ = s.Flush(ctx)
	if n := len(fs.sourceWrites("s")); n != 2 {
		t.Fatalf("không có bản tin mới thì không ghi: %d lần", n)
	}
}

func TestFailedSourceWriteKeepsTheCount(t *testing.T) {
	s, fs, _ := newSvc(t)
	ctx := context.Background()
	s.IngestFor("m", []live.Message{{Source: "s", TS: t0, Payload: 1.0}})
	fs.srcErr = errBoom
	if err := s.Flush(ctx); err == nil {
		t.Fatal("phải báo lỗi ghi")
	}
	fs.srcErr = nil
	if err := s.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	w := fs.sourceWrites("s")
	if len(w) != 1 || w[0].Count != 1 {
		t.Fatalf("lỗi ghi không được làm mất số đếm: %+v", w)
	}
}

func derivedBind(model, subject, signal string, d live.Derive) live.Binding {
	return live.Binding{ModelKey: model, Subject: subject, Signal: signal, Mode: live.ModeDerived, Derive: &d, Enabled: true}
}

func sumOf(terms ...live.Term) live.Derive { return live.Derive{Kind: live.KindSum, Terms: terms} }

func plusT(subject, signal string) live.Term {
	return live.Term{Subject: subject, Signal: signal, Sign: 1}
}
func minusT(subject, signal string) live.Term {
	return live.Term{Subject: subject, Signal: signal, Sign: -1}
}

func TestIngestComputesDerivedSumAndStoresItLikeRealData(t *testing.T) {
	d := live.Derive{Kind: live.KindSum, Const: 100, Terms: []live.Term{plusT("IN", "moved"), minusT("OUT", "moved")}}
	s, fs, _ := newSvc(t,
		bind("m", "IN", "moved", "belt/in", "moved"), bind("m", "OUT", "moved", "belt/out", "moved"),
		derivedBind("m", "KHO", "level:RAW-01", d))
	res := s.Ingest([]live.Message{
		{Source: "belt/in", TS: t0, Payload: map[string]any{"moved": 30.0}},
		{Source: "belt/out", TS: t0, Payload: map[string]any{"moved": 12.0}},
	})
	if res.Derived != 1 {
		t.Fatalf("result = %+v", res)
	}
	got := s.Snapshot("m").Subjects["KHO"].Signals["level:RAW-01"]
	if got.V != 118 || !got.TS.Equal(t0) {
		t.Fatalf("level = %+v, muốn 100 + 30 - 12 = 118", got)
	}
	if err := s.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, sg := range fs.sigs {
		if sg.Subject == "KHO" && sg.Name == "level:RAW-01" && sg.Value == 118 && sg.Model == "m" {
			found = true
		}
	}
	if !found {
		t.Fatalf("giá trị tự tính phải được lưu như dữ liệu thật: %+v", fs.sigs)
	}
	// dự báo từ live đọc tồn qua State.Levels nên phải thấy giá trị tự tính
	if lv := s.State().Levels("m"); lv["KHO"]["RAW-01"] != 118 {
		t.Fatalf("Levels = %+v", lv)
	}
}

func TestDerivedChainsFollowDependencyOrder(t *testing.T) {
	s, _, _ := newSvc(t,
		bind("m", "A", "count_ok", "dev/a", "n"),
		// ghi ngược thứ tự phụ thuộc để chắc chắn Plan sắp lại
		derivedBind("m", "E2", "moved", sumOf(plusT("E1", "moved"))),
		derivedBind("m", "E1", "moved", sumOf(plusT("A", "count_ok"))))
	s.Ingest([]live.Message{{Source: "dev/a", TS: t0, Payload: map[string]any{"n": 7.0}}})
	if got := s.Snapshot("m").Subjects["E2"].Signals["moved"].V; got != 7 {
		t.Fatalf("E2 = %v, muốn 7 (qua E1)", got)
	}
}

func TestDerivedValueDoesNotLookFreshWhenItsInputsStopped(t *testing.T) {
	s, _, _ := newSvc(t,
		bind("m", "A", "count_ok", "dev/a", "n"), bind("m", "B", "count_ok", "dev/b", "n"),
		derivedBind("m", "E", "moved", sumOf(plusT("A", "count_ok"))))
	wall := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return wall }
	s.Ingest([]live.Message{{Source: "dev/a", TS: t0, Payload: map[string]any{"n": 1.0}}})
	wall = wall.Add(30 * time.Second)
	// chỉ nguồn B (không phải đầu vào của E) tiếp tục phát
	s.Ingest([]live.Message{{Source: "dev/b", TS: t0.Add(30 * time.Second), Payload: map[string]any{"n": 1.0}}})
	age := s.Snapshot("m").Subjects["E"].AgeMS
	if age < 29_000 {
		t.Fatalf("age_ms = %d: E không được tính lại khi đầu vào của nó không đổi, nên tuổi phải tăng theo giờ thật", age)
	}
}

func TestDerivedActivityTurnsIdleWhenTheCounterStopsWhileTimeAdvances(t *testing.T) {
	act := live.Derive{Kind: live.KindActivity, Watch: &live.Ref{Subject: "P", Signal: "count_in"}, IdleAfterS: 60}
	s, fs, _ := newSvc(t,
		bind("m", "P", "count_in", "dev/p", "n"), bind("m", "Q", "count_in", "dev/q", "n"),
		derivedBind("m", "P", "state", act))
	state := func() string { return s.Snapshot("m").Subjects["P"].State }
	s.Ingest([]live.Message{
		{Source: "dev/p", TS: t0, Payload: map[string]any{"n": 1.0}},
		{Source: "dev/q", TS: t0, Payload: map[string]any{"n": 1.0}},
	})
	if state() != "IDLE" {
		t.Fatalf("mẫu đầu tiên chưa biết máy chạy: %q", state())
	}
	s.Ingest([]live.Message{{Source: "dev/p", TS: t0.Add(10 * time.Second), Payload: map[string]any{"n": 2.0}}})
	if state() != "RUNNING" {
		t.Fatalf("bộ đếm vừa tăng: %q", state())
	}
	// bộ đếm của P đứng yên, giờ vẫn trôi nhờ nguồn Q: đến lúc phải chuyển IDLE
	s.Ingest([]live.Message{{Source: "dev/q", TS: t0.Add(200 * time.Second), Payload: map[string]any{"n": 2.0}}})
	if state() != "IDLE" {
		t.Fatalf("đứng yên hơn 60 giây: %q", state())
	}
	if err := s.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	var seq []string
	for _, e := range fs.evs {
		if e.Subject == "P" && e.Type == "STATE" {
			seq = append(seq, e.Payload["state"].(string))
		}
	}
	if len(seq) != 3 || seq[0] != "IDLE" || seq[1] != "RUNNING" || seq[2] != "IDLE" {
		t.Fatalf("chuỗi sự kiện trạng thái = %v", seq)
	}
}

func TestSourceBindingsStillWorkAlongsideDerivedOnes(t *testing.T) {
	s, _, _ := newSvc(t, bind("m", "A", "count_ok", "dev/a", "n"), derivedBind("m", "E", "moved", sumOf(plusT("A", "count_ok"))))
	res := s.Ingest([]live.Message{{Source: "dev/a", TS: t0, Payload: map[string]any{"n": 3.0}}})
	if res.Readings != 1 || res.Errors != 0 || res.Derived != 1 {
		t.Fatalf("result = %+v", res)
	}
}
