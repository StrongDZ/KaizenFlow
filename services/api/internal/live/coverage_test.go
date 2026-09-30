package live

import (
	"strings"
	"testing"
)

// Đồ thị thử: SRC --RAW-01--> KHO --RAW-01--> P --PART--> OUT, thêm một edge chạy bằng xe để thử đội xe và hiệu chỉnh.
func testSubjects(withPool bool) []Subject {
	node := func(key, name, arche string, params map[string]any) Subject {
		return Subject{Subject: key, Kind: "node", Name: name, Archetype: arche, Signals: SignalsFor(arche, params)}
	}
	edge := func(key, src, dst, mat, mode string) Subject {
		return Subject{Subject: key, Kind: "edge", Name: src + " → " + dst, Material: mat, Mode: mode, Src: src, Dst: dst, Signals: EdgeSignals(mode)}
	}
	kho := node("KHO", "Kho A", "STORAGE", map[string]any{"stock": []any{map[string]any{"material": "RAW-01"}}})
	kho.Initial = map[string]float64{"RAW-01": 40}
	p := node("P", "Máy dập", "PROCESS", nil)
	p.InQty, p.OutQty, p.CycleS = map[string]float64{"RAW-01": 2}, map[string]float64{"PART": 1}, 30
	out := []Subject{
		node("SRC", "Nhà cung cấp", "SOURCE", nil), kho, p, node("OUT", "Cửa xuất", "SINK", nil),
		edge("SRC>KHO", "SRC", "KHO", "RAW-01", ""), edge("KHO>P", "KHO", "P", "RAW-01", ""), edge("P>OUT", "P", "OUT", "PART", ""),
	}
	if withPool {
		tug := node("TUG", "Xe kéo", "RESOURCE_POOL", map[string]any{"kind": "TUGGER"})
		e4 := edge("KHO>P#2", "KHO", "P", "RAW-02", "POOL")
		e4.Pool, e4.Lot = "TUG", 2
		out = append(out, tug, e4)
	}
	return out
}

func find(list []Suggestion, n int) Derive {
	if len(list) <= n {
		return Derive{}
	}
	return list[n].Derive
}

func TestSuggestMovedIntoAProcessUsesItsCycleCountTimesQty(t *testing.T) {
	subs := testSubjects(false)
	bound := []Binding{src("P", "count_in")}
	got := SuggestDerive(subs, bound, Ref{"KHO>P", "moved"})
	if len(got) != 1 || len(got[0].Derive.Terms) != 1 {
		t.Fatalf("suggestions = %+v", got)
	}
	if tm := got[0].Derive.Terms[0]; tm.Subject != "P" || tm.Signal != "count_in" || tm.Sign != 1 || tm.Factor != 2 {
		t.Fatalf("term = %+v, muốn count_in × 2", tm)
	}
	if !strings.Contains(got[0].Note, "Máy dập") {
		t.Fatalf("note = %q", got[0].Note)
	}
	if got := SuggestDerive(subs, nil, Ref{"KHO>P", "moved"}); len(got) != 0 {
		t.Fatalf("đầu vào chưa ghép thì không gợi ý: %+v", got)
	}
}

func TestSuggestMovedOutOfAProcessAndOutOfASource(t *testing.T) {
	subs := testSubjects(false)
	got := SuggestDerive(subs, []Binding{src("P", "count_ok")}, Ref{"P>OUT", "moved"})
	if tm := find(got, 0).Terms[0]; tm.Subject != "P" || tm.Signal != "count_ok" || tm.Factor != 0 {
		t.Fatalf("P>OUT moved = %+v (factor 0 nghĩa là 1)", got)
	}
	got = SuggestDerive(subs, []Binding{src("SRC", "arrived")}, Ref{"SRC>KHO", "moved"})
	if tm := find(got, 0).Terms[0]; tm.Subject != "SRC" || tm.Signal != "arrived" {
		t.Fatalf("SRC>KHO moved = %+v", got)
	}
}

func TestSuggestInTransitIsWhatTheProducerMadeMinusWhatArrived(t *testing.T) {
	subs := testSubjects(false)
	bound := []Binding{src("SRC", "arrived"), src("SRC>KHO", "moved")}
	d := find(SuggestDerive(subs, bound, Ref{"SRC>KHO", "in_transit"}), 0)
	if len(d.Terms) != 2 || d.Terms[0].Signal != "arrived" || d.Terms[0].Sign != 1 || d.Terms[1].Subject != "SRC>KHO" || d.Terms[1].Signal != "moved" || d.Terms[1].Sign != -1 {
		t.Fatalf("derive = %+v", d)
	}
	if got := SuggestDerive(subs, []Binding{src("SRC", "arrived")}, Ref{"SRC>KHO", "in_transit"}); len(got) != 0 {
		t.Fatalf("thiếu moved của chính edge thì không gợi ý: %+v", got)
	}
}

func TestSuggestStorageLevelIsInitialPlusInMinusOut(t *testing.T) {
	subs := testSubjects(false)
	d := find(SuggestDerive(subs, []Binding{src("SRC>KHO", "moved"), src("KHO>P", "moved")}, Ref{"KHO", "level:RAW-01"}), 0)
	if d.Kind != KindSum || d.Const != 40 || len(d.Terms) != 2 || d.Terms[0].Subject != "SRC>KHO" || d.Terms[0].Sign != 1 || d.Terms[1].Subject != "KHO>P" || d.Terms[1].Sign != -1 {
		t.Fatalf("derive = %+v", d)
	}
	if got := SuggestDerive(subs, []Binding{src("SRC>KHO", "moved")}, Ref{"KHO", "level:RAW-01"}); len(got) != 0 {
		t.Fatalf("thiếu moved của một edge ra thì tồn sẽ sai, không gợi ý: %+v", got)
	}
}

func TestSuggestProcessCountersStateAndNodeTotals(t *testing.T) {
	subs := testSubjects(false)
	d := find(SuggestDerive(subs, []Binding{src("KHO>P", "moved")}, Ref{"P", "count_in"}), 0)
	if len(d.Terms) != 1 || d.Terms[0].Factor != 0.5 {
		t.Fatalf("count_in = %+v, muốn moved × 0,5 (mỗi lượt dùng 2)", d)
	}
	d = find(SuggestDerive(subs, []Binding{src("P>OUT", "moved")}, Ref{"P", "count_ok"}), 0)
	if len(d.Terms) != 1 || d.Terms[0].Subject != "P>OUT" {
		t.Fatalf("count_ok = %+v", d)
	}
	act := find(SuggestDerive(subs, []Binding{src("P", "count_in"), src("P", "count_ok")}, Ref{"P", "state"}), 0)
	if act.Kind != KindActivity || act.Watch == nil || act.Watch.Signal != "count_in" || act.IdleAfterS != 60 {
		t.Fatalf("state = %+v, muốn theo dõi count_in, nghỉ sau 2 × chu kỳ 30 = 60 giây", act)
	}
	act = find(SuggestDerive(subs, []Binding{src("P", "count_ok")}, Ref{"P", "state"}), 0)
	if act.Watch == nil || act.Watch.Signal != "count_ok" {
		t.Fatalf("state chỉ có count_ok: %+v", act)
	}
	if got := SuggestDerive(subs, nil, Ref{"P", "state"}); len(got) != 0 {
		t.Fatalf("không có bộ đếm nào: %+v", got)
	}
	if d := find(SuggestDerive(subs, []Binding{src("SRC>KHO", "moved")}, Ref{"SRC", "arrived"}), 0); len(d.Terms) != 1 || d.Terms[0].Subject != "SRC>KHO" {
		t.Fatalf("arrived = %+v", d)
	}
	if d := find(SuggestDerive(subs, []Binding{src("P>OUT", "moved")}, Ref{"OUT", "fulfilled"}), 0); len(d.Terms) != 1 || d.Terms[0].Subject != "P>OUT" {
		t.Fatalf("fulfilled = %+v", d)
	}
}

func TestSuggestPoolBusyFromItsEdgesInTransitAndNeverTripOrVibration(t *testing.T) {
	subs := testSubjects(true)
	d := find(SuggestDerive(subs, []Binding{src("KHO>P#2", "in_transit")}, Ref{"TUG", "busy"}), 0)
	if len(d.Terms) != 1 || d.Terms[0].Subject != "KHO>P#2" || d.Terms[0].Factor != 0.5 {
		t.Fatalf("busy = %+v, muốn in_transit × 0,5 (mỗi chuyến chở 2)", d)
	}
	all := []Binding{src("P", "count_in"), src("KHO>P#2", "in_transit"), src("KHO>P#2", "moved")}
	for _, target := range []Ref{{"KHO>P#2", "trip_s"}, {"P", "vibration"}, {"P", "count_ng"}} {
		if got := SuggestDerive(subs, all, target); len(got) != 0 {
			t.Fatalf("%v không được gợi ý tự tính: %+v", target, got)
		}
	}
}

func byRef(r CoverageReport) map[Ref]SignalCoverage {
	out := map[Ref]SignalCoverage{}
	for _, s := range r.Signals {
		out[Ref{s.Subject, s.Signal}] = s
	}
	return out
}

func TestCoverageClassifiesEverySignalOfTheCatalog(t *testing.T) {
	subs := testSubjects(false)
	bs := []Binding{
		src("SRC", "arrived"), src("SRC>KHO", "moved"),
		derived("KHO", "level:RAW-01", Derive{Kind: KindSum, Const: 40, Terms: []Term{plus("SRC>KHO", "moved"), minus("KHO>P", "moved")}}), // KHO>P chưa ghép → hỏng
	}
	off := src("P", "state")
	off.Enabled = false
	bs = append(bs, off)
	rep := AnalyzeCoverage(CoverageInput{Subjects: subs, Bindings: bs})
	got := byRef(rep)
	want := map[Ref]string{
		{"SRC", "arrived"}: "source", {"SRC>KHO", "moved"}: "source", {"KHO", "level:RAW-01"}: "broken",
		{"P", "state"}: "missing", {"KHO>P", "moved"}: "missing", {"P", "count_in"}: "missing",
	}
	for r, st := range want {
		if got[r].Status != st {
			t.Errorf("%v: %q, muốn %q (%+v)", r, got[r].Status, st, got[r])
		}
	}
	if !strings.Contains(got[Ref{"P", "state"}].Reason, "tắt") {
		t.Errorf("ghép nối đang tắt phải nói rõ: %q", got[Ref{"P", "state"}].Reason)
	}
	if !strings.Contains(got[Ref{"KHO", "level:RAW-01"}].Reason, "chưa có nguồn") {
		t.Errorf("lý do hỏng = %q", got[Ref{"KHO", "level:RAW-01"}].Reason)
	}
	sum := rep.Summary
	if sum.Signals != len(rep.Signals) || sum.Source != 2 || sum.Broken != 1 || sum.Derived != 0 || sum.Missing != sum.Signals-3 {
		t.Fatalf("summary = %+v", sum)
	}
}

func TestCoverageNeedsAndReadinessPerFeature(t *testing.T) {
	subs := testSubjects(false)
	rep := AnalyzeCoverage(CoverageInput{Subjects: subs})
	got := byRef(rep)
	if n := got[Ref{"P", "state"}].Need; len(n) != 1 || n[0] != "live" {
		t.Errorf("state cần cho live: %v", n)
	}
	if n := got[Ref{"KHO", "level:RAW-01"}].Need; len(n) != 2 || n[0] != "live" || n[1] != "forecast" {
		t.Errorf("tồn cần cho live và dự báo: %v", n)
	}
	if n := got[Ref{"P", "vibration"}].Need; len(n) != 0 {
		t.Errorf("độ rung là tuỳ chọn: %v", n)
	}
	feats := map[string]Readiness{}
	for _, r := range rep.Readiness {
		feats[r.Feature] = r
	}
	if feats["live"].OK || feats["forecast"].OK || len(feats["forecast"].Missing) != 1 || feats["forecast"].Missing[0] != (Ref{"KHO", "level:RAW-01"}) {
		t.Fatalf("readiness = %+v", rep.Readiness)
	}
	if _, has := feats["calibration"]; has {
		t.Fatalf("không có edge chạy bằng xe thì hiệu chỉnh AGV không áp dụng: %+v", rep.Readiness)
	}
	// ghép đủ những gì live và dự báo cần
	var full []Binding
	for _, s := range rep.Signals {
		if len(s.Need) > 0 {
			full = append(full, src(s.Subject, s.Signal))
		}
	}
	rep = AnalyzeCoverage(CoverageInput{Subjects: subs, Bindings: full})
	for _, r := range rep.Readiness {
		if !r.OK || len(r.Missing) != 0 {
			t.Fatalf("đủ rồi mà %s chưa ok: %+v", r.Feature, r)
		}
	}
	// có edge chạy bằng xe: hiệu chỉnh cần trip_s, bản đồ cần fleet
	rep = AnalyzeCoverage(CoverageInput{Subjects: testSubjects(true), Bindings: nil})
	feats = map[string]Readiness{}
	for _, r := range rep.Readiness {
		feats[r.Feature] = r
	}
	if feats["calibration"].OK || len(feats["calibration"].Missing) != 1 || feats["calibration"].Missing[0] != (Ref{"KHO>P#2", "trip_s"}) {
		t.Fatalf("calibration = %+v", feats["calibration"])
	}
	if feats["map"].OK || feats["map"].Missing[0] != (Ref{"TUG", "fleet"}) {
		t.Fatalf("map = %+v", feats["map"])
	}
}

func TestCoverageFlagsSourceBindingsThatCannotWorkAgainstTheKnownSample(t *testing.T) {
	subs := testSubjects(false)
	a := Binding{Subject: "SRC", Signal: "arrived", Source: "dock/src", JSONPath: "n", Enabled: true}
	b := Binding{Subject: "SRC>KHO", Signal: "moved", Source: "belt/a", JSONPath: "moved", Enabled: true}
	c := Binding{Subject: "P", Signal: "count_in", Source: "plc/p", JSONPath: "cnt.in", Enabled: true}
	d := Binding{Subject: "P", Signal: "state", Source: "plc/p", JSONPath: "st", Enabled: true, Transform: Transform{Enum: map[string]string{"RUN": "RUNNING"}}}
	samples := []SourceSample{
		{Source: "dock/src", Sample: map[string]any{"khac": 1.0}},                                  // thiếu trường n
		{Source: "belt/a", Sample: map[string]any{"moved": "nhieu"}},                               // không phải số
		{Source: "plc/p", Sample: map[string]any{"cnt": map[string]any{"in": 5.0}, "st": "FAULT"}}, // ổn, nhưng FAULT chưa có trong bảng đổi
	}
	rep := AnalyzeCoverage(CoverageInput{Subjects: subs, Bindings: []Binding{a, b, c, d}, Sources: samples})
	got := byRef(rep)
	if got[Ref{"SRC", "arrived"}].Status != "broken" || !strings.Contains(got[Ref{"SRC", "arrived"}].Reason, "'n'") {
		t.Errorf("thiếu trường: %+v", got[Ref{"SRC", "arrived"}])
	}
	if got[Ref{"SRC>KHO", "moved"}].Status != "broken" || !strings.Contains(got[Ref{"SRC>KHO", "moved"}].Reason, "số") {
		t.Errorf("không phải số: %+v", got[Ref{"SRC>KHO", "moved"}])
	}
	if got[Ref{"P", "count_in"}].Status != "source" {
		t.Errorf("ổn: %+v", got[Ref{"P", "count_in"}])
	}
	found := false
	for _, p := range rep.Problems {
		if p.Subject == "P" && p.Signal == "state" && p.Severity == "warning" && strings.Contains(p.Message, "FAULT") {
			found = true
		}
	}
	if !found {
		t.Errorf("FAULT chưa có trong bảng đổi trạng thái phải thành cảnh báo: %+v", rep.Problems)
	}
	// nguồn chưa từng thấy (bản đăng ký trống): vẫn là source, chỉ kèm cảnh báo, để không báo hỏng oan khi feed chưa chạy
	rep = AnalyzeCoverage(CoverageInput{Subjects: subs, Bindings: []Binding{a}})
	if byRef(rep)[Ref{"SRC", "arrived"}].Status != "source" {
		t.Errorf("nguồn chưa đăng ký không được coi là hỏng: %+v", byRef(rep)[Ref{"SRC", "arrived"}])
	}
	warned := false
	for _, p := range rep.Problems {
		if p.Subject == "SRC" && strings.Contains(p.Message, "chưa từng") {
			warned = true
		}
	}
	if !warned {
		t.Errorf("phải cảnh báo nguồn chưa từng thấy: %+v", rep.Problems)
	}
}

func TestCoverageAttachesSuggestionsToMissingSignals(t *testing.T) {
	subs := testSubjects(false)
	rep := AnalyzeCoverage(CoverageInput{Subjects: subs, Bindings: []Binding{src("P", "count_in")}})
	m := byRef(rep)[Ref{"KHO>P", "moved"}]
	if m.Status != "missing" || len(m.Suggestions) != 1 || m.Suggestions[0].Derive.Terms[0].Signal != "count_in" {
		t.Fatalf("moved = %+v", m)
	}
	if got := byRef(rep)[Ref{"P", "vibration"}]; len(got.Suggestions) != 0 {
		t.Fatalf("vibration = %+v", got)
	}
}
