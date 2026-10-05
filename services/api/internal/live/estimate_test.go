package live

import (
	"math"
	"strings"
	"testing"
	"time"
)

// Sơ đồ thử: hai kho cùng cấp RAW cho một máy M (rẽ nhánh vào), kho A còn cấp cho máy M1; nhà cung cấp SRC cấp cho cả hai kho.
//
//	SRC ─┬→ KHO_A ─┬→ M1
//	     └→ KHO_B ─┘→ M
//	              KHO_A ───→ M
func diamond() []Subject {
	node := func(key, name, arche string, params map[string]any) Subject {
		return Subject{Subject: key, Kind: "node", Name: name, Archetype: arche, Signals: SignalsFor(arche, params)}
	}
	edge := func(key, src, dst string) Subject {
		return Subject{Subject: key, Kind: "edge", Name: src + " → " + dst, Material: "RAW", Src: src, Dst: dst, Signals: EdgeSignals("")}
	}
	stock := map[string]any{"stock": []any{map[string]any{"material": "RAW"}}}
	khoA, khoB := node("KHO_A", "Kho A", "STORAGE", stock), node("KHO_B", "Kho B", "STORAGE", stock)
	khoA.Initial, khoB.Initial = map[string]float64{"RAW": 100}, map[string]float64{"RAW": 50}
	m, m1 := node("M", "Máy M", "PROCESS", nil), node("M1", "Máy M1", "PROCESS", nil)
	m.InQty, m1.InQty = map[string]float64{"RAW": 2}, map[string]float64{"RAW": 1}
	return []Subject{
		node("SRC", "Nhà cung cấp", "SOURCE", nil), khoA, khoB, m, m1,
		edge("SRC>KHO_A", "SRC", "KHO_A"), edge("SRC>KHO_B", "SRC", "KHO_B"),
		edge("KHO_A>M", "KHO_A", "M"), edge("KHO_B>M", "KHO_B", "M"), edge("KHO_A>M1", "KHO_A", "M1"),
	}
}

func planOf(t *testing.T, subs []Subject, bound ...Binding) map[string]PlannedEdge {
	t.Helper()
	p := PlanEdges(subs, bound)
	out := map[string]PlannedEdge{}
	for _, it := range p.Items {
		if it.Signal != "moved" {
			t.Fatalf("chỉ lập kế hoạch cho moved, gặp %s/%s", it.Subject, it.Signal)
		}
		out[it.Subject] = it
	}
	return out
}

func termOf(d Derive, subject, signal string) (Term, bool) {
	for _, t := range d.Terms {
		if t.Subject == subject && t.Signal == signal {
			return t, true
		}
	}
	return Term{}, false
}

func TestTwoSuppliersOfOneMachineShareItsIntakeEqually(t *testing.T) {
	// Chỉ biết số lượt M đã nhận (mỗi lượt 2 RAW); hai kho cùng cấp nên mỗi đường nhận một nửa.
	got := planOf(t, diamond(), src("M", "count_in"))
	for _, k := range []string{"KHO_A>M", "KHO_B>M"} {
		it, ok := got[k]
		if !ok {
			t.Fatalf("thiếu kế hoạch cho %s: %+v", k, got)
		}
		tm, ok := termOf(it.Derive, "M", "count_in")
		if !ok || tm.Sign != 1 || tm.factor() != 1 { // 2 đơn vị mỗi lượt × 1/2 (Factor để trống nghĩa là 1)
			t.Fatalf("%s: %+v, muốn count_in × 1 (= 2 × ½)", k, it.Derive)
		}
		if !it.Estimate || !strings.Contains(it.Note, "chia đều") || !strings.Contains(it.Note, "2 đường nối") {
			t.Errorf("%s: estimate=%v note=%q", k, it.Estimate, it.Note)
		}
	}
}

func TestTheLastEdgeIsWhatIsLeftAndIsNotAnEstimate(t *testing.T) {
	got := planOf(t, diamond(), src("M", "count_in"), src("KHO_A>M", "moved"))
	it := got["KHO_B>M"]
	if tm, ok := termOf(it.Derive, "M", "count_in"); !ok || tm.Factor != 2 {
		t.Fatalf("derive = %+v, muốn count_in × 2 trừ moved của KHO_A>M", it.Derive)
	}
	if tm, ok := termOf(it.Derive, "KHO_A>M", "moved"); !ok || tm.Sign != -1 {
		t.Fatalf("derive = %+v, muốn trừ moved của KHO_A>M", it.Derive)
	}
	if it.Estimate {
		t.Errorf("phần dư của tổng đo được không phải ước lượng: %+v", it)
	}
}

func TestStorageBalanceGivesTheSupplyEdgeFromWhatLeftTheStorage(t *testing.T) {
	// Biết M1 nhận bao nhiêu (đường KHO_A>M1 suy ra chắc chắn) và tồn kho A: hàng vào kho = hàng ra + tồn tăng thêm.
	got := planOf(t, diamond(), src("M1", "count_in"), src("M", "count_in"), src("KHO_A", "level:RAW"), src("KHO_B", "level:RAW"))
	it := got["SRC>KHO_A"]
	for _, e := range []string{"KHO_A>M", "KHO_A>M1"} {
		if tm, ok := termOf(it.Derive, e, "moved"); !ok || tm.Sign != 1 {
			t.Fatalf("SRC>KHO_A thiếu số hạng +moved của %s: %+v", e, it.Derive)
		}
	}
	if tm, ok := termOf(it.Derive, "KHO_A", "level:RAW"); !ok || tm.Sign != 1 {
		t.Fatalf("thiếu số hạng tồn kho: %+v", it.Derive)
	}
	if it.Derive.Const != -100 {
		t.Errorf("const = %v, muốn −tồn đầu kỳ (−100)", it.Derive.Const)
	}
	if !it.Estimate || !strings.Contains(it.Note, "cân bằng kho") {
		t.Errorf("estimate=%v note=%q", it.Estimate, it.Note)
	}
}

func TestStorageBalanceAlsoSolvesAnOutgoingEdge(t *testing.T) {
	// KHO_A cấp M1 và M; M1 và M đều có số lượt nhận nhưng đường vào M là nhóm hai nguồn. Ở đây biết đường vào kho (SRC>KHO_A)
	// và đường KHO_A>M1: đường KHO_A>M = vào − ra khác − tồn tăng thêm.
	got := planOf(t, diamond(), src("M1", "count_in"), src("SRC>KHO_A", "moved"), src("KHO_A", "level:RAW"))
	it, ok := got["KHO_A>M"]
	if !ok {
		t.Fatalf("thiếu KHO_A>M: %+v", got)
	}
	if tm, ok := termOf(it.Derive, "SRC>KHO_A", "moved"); !ok || tm.Sign != 1 {
		t.Fatalf("derive = %+v", it.Derive)
	}
	if tm, ok := termOf(it.Derive, "KHO_A>M1", "moved"); !ok || tm.Sign != -1 {
		t.Fatalf("derive = %+v", it.Derive)
	}
	if tm, ok := termOf(it.Derive, "KHO_A", "level:RAW"); !ok || tm.Sign != -1 {
		t.Fatalf("derive = %+v", it.Derive)
	}
	if it.Derive.Const != 100 {
		t.Errorf("const = %v, muốn +tồn đầu kỳ (100)", it.Derive.Const)
	}
}

func TestBalanceBeatsTheSourceCounterWhichCountsGoodsStillAtTheDock(t *testing.T) {
	// SRC>KHO_A và SRC>KHO_B đều có thể tính từ `arrived`, nhưng số đã nhập về gồm cả hàng còn nằm ở cửa nhận; cân bằng kho đúng hơn.
	got := planOf(t, diamond(), src("SRC", "arrived"), src("M1", "count_in"), src("M", "count_in"), src("KHO_A", "level:RAW"), src("KHO_B", "level:RAW"))
	for _, k := range []string{"SRC>KHO_A", "SRC>KHO_B"} {
		if _, bad := termOf(got[k].Derive, "SRC", "arrived"); bad {
			t.Errorf("%s dùng arrived dù có cân bằng kho: %+v", k, got[k].Derive)
		}
		if _, ok := termOf(got[k].Derive, k[strings.Index(k, ">")+1:], "level:RAW"); !ok {
			t.Errorf("%s không dùng tồn kho: %+v", k, got[k].Derive)
		}
	}
}

func TestSourceCounterIsUsedWhenNothingBetterExists(t *testing.T) {
	// Không có tồn kho nào được ghép: đường ra của nguồn suy từ arrived (chia đều cho hai kho).
	got := planOf(t, diamond(), src("SRC", "arrived"))
	for _, k := range []string{"SRC>KHO_A", "SRC>KHO_B"} {
		tm, ok := termOf(got[k].Derive, "SRC", "arrived")
		if !ok || tm.Factor != 0.5 || !got[k].Estimate {
			t.Errorf("%s: %+v (estimate=%v), muốn arrived × ½", k, got[k].Derive, got[k].Estimate)
		}
	}
}

func TestEdgesWithNoCounterOnEitherSideAreReportedNotInvented(t *testing.T) {
	subs := []Subject{
		{Subject: "A", Kind: "node", Archetype: "STORAGE", Name: "Kho A", Signals: SignalsFor("STORAGE", nil)},
		{Subject: "B", Kind: "node", Archetype: "STORAGE", Name: "Kho B", Signals: SignalsFor("STORAGE", nil)},
		{Subject: "A>B", Kind: "edge", Material: "RAW", Src: "A", Dst: "B", Signals: EdgeSignals("")},
	}
	p := PlanEdges(subs, nil)
	if len(p.Items) != 0 || len(p.Skipped) != 1 || p.Skipped[0].Subject != "A>B" || p.Skipped[0].Reason == "" {
		t.Fatalf("plan = %+v", p)
	}
}

func TestEdgesThatAlreadyHaveDataAreLeftAlone(t *testing.T) {
	got := planOf(t, diamond(), src("M", "count_in"), src("KHO_A>M", "moved"), src("KHO_B>M", "moved"))
	if _, ok := got["KHO_A>M"]; ok {
		t.Errorf("KHO_A>M đã có dữ liệu: %+v", got["KHO_A>M"])
	}
	if _, ok := got["KHO_B>M"]; ok {
		t.Errorf("KHO_B>M đã có dữ liệu: %+v", got["KHO_B>M"])
	}
}

func TestEveryPlannedFormulaIsValidAndComputable(t *testing.T) {
	subs := diamond()
	bound := []Binding{src("M", "count_in"), src("M1", "count_in"), src("KHO_A", "level:RAW"), src("KHO_B", "level:RAW")}
	plan := PlanEdges(subs, bound)
	if len(plan.Items) != 5 || len(plan.Skipped) != 0 {
		t.Fatalf("muốn đủ 5 đường nối, plan = %+v", plan)
	}
	final := append([]Binding{}, bound...)
	for _, it := range plan.Items {
		d := it.Derive
		final = append(final, Binding{Subject: it.Subject, Signal: it.Signal, Mode: ModeDerived, Derive: &d, Enabled: true})
	}
	catalog := map[Ref]bool{}
	for _, s := range subs {
		for _, d := range s.Signals {
			catalog[Ref{s.Subject, d.Name}] = true
		}
	}
	for _, it := range plan.Items {
		if err := ValidateDerive(Ref{it.Subject, it.Signal}, it.Derive, final, func(r Ref) bool { return catalog[r] }, RelatedSubjects(subs, it.Subject)); err != nil {
			t.Errorf("%s: %v", it.Subject, err)
		}
	}

	// Tính thật theo thứ tự Plan: M nhận 40 lượt × 2 = 80 RAW chia đều 40/40; M1 nhận 30; kho A: tồn 100 → 90 (ra 70 + 30 −… xem dưới).
	vals := map[Ref]float64{{"M", "count_in"}: 40, {"M1", "count_in"}: 30, {"KHO_A", "level:RAW"}: 90, {"KHO_B", "level:RAW"}: 60}
	now := time.Unix(0, 0)
	for _, b := range Plan(final) {
		r, ok := Eval(*b.Derive, Ref{b.Subject, b.Signal}, func(ref Ref) (SigVal, bool) { v, ok := vals[ref]; return SigVal{V: v, TS: now}, ok }, now)
		if !ok {
			t.Fatalf("không tính được %s/%s", b.Subject, b.Signal)
		}
		vals[Ref{b.Subject, b.Signal}] = r.Num
	}
	want := map[string]float64{
		"KHO_A>M1":  30,                   // sole in-edge của M1
		"KHO_A>M":   40,                   // chia đều 80 RAW cho hai kho
		"KHO_B>M":   40,                   //
		"SRC>KHO_A": 30 + 40 + (90 - 100), // ra 70, tồn giảm 10 → vào 60
		"SRC>KHO_B": 40 + (60 - 50),       // ra 40, tồn tăng 10 → vào 50
	}
	for k, w := range want {
		if got := vals[Ref{k, "moved"}]; math.Abs(got-w) > 1e-9 {
			t.Errorf("%s moved = %v, muốn %v", k, got, w)
		}
	}
}

func TestRejectedProductsLeaveThroughTheNgCounter(t *testing.T) {
	subs := []Subject{
		{Subject: "QC", Kind: "node", Archetype: "PROCESS", Name: "AOI", Signals: SignalsFor("PROCESS", nil), OutQty: map[string]float64{"OK": 1}, OutNGQty: map[string]float64{"NG": 1}},
		{Subject: "BIN", Kind: "node", Archetype: "SINK", Name: "Thùng phế", Signals: SignalsFor("SINK", nil)},
		{Subject: "QC>BIN", Kind: "edge", Material: "NG", Src: "QC", Dst: "BIN", Signals: EdgeSignals("")},
	}
	it := planOf(t, subs, src("QC", "count_ng"))["QC>BIN"]
	if tm, ok := termOf(it.Derive, "QC", "count_ng"); !ok || tm.Sign != 1 {
		t.Fatalf("derive = %+v, muốn count_ng", it.Derive)
	}
}
