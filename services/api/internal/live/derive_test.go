package live

import (
	"strings"
	"testing"
	"time"
)

func src(subject, signal string) Binding {
	return Binding{Subject: subject, Signal: signal, Source: "s/" + subject, JSONPath: "v", Enabled: true}
}

func derived(subject, signal string, d Derive) Binding {
	return Binding{Subject: subject, Signal: signal, Mode: ModeDerived, Derive: &d, Enabled: true}
}

func allKnown(Ref) bool { return true }

func sum(terms ...Term) Derive          { return Derive{Kind: KindSum, Terms: terms} }
func plus(subject, signal string) Term  { return Term{Subject: subject, Signal: signal, Sign: 1} }
func minus(subject, signal string) Term { return Term{Subject: subject, Signal: signal, Sign: -1} }

func wantErr(t *testing.T, err error, contains string) {
	t.Helper()
	if err == nil {
		t.Fatalf("muốn lỗi chứa %q, được nil", contains)
	}
	if !strings.Contains(err.Error(), contains) {
		t.Fatalf("lỗi %q không chứa %q", err, contains)
	}
}

func TestValidateDeriveAcceptsSumOverBoundInputs(t *testing.T) {
	d := sum(plus("A", "count_ok"), minus("B", "count_in"))
	final := []Binding{src("A", "count_ok"), src("B", "count_in"), derived("E", "in_transit", d)}
	if err := ValidateDerive(Ref{"E", "in_transit"}, d, final, allKnown); err != nil {
		t.Fatal(err)
	}
}

func TestValidateDeriveInputsThatAreThemselvesDerivedCountAsBound(t *testing.T) {
	inner := sum(plus("A", "count_ok"))
	outer := sum(plus("E1", "moved"))
	final := []Binding{src("A", "count_ok"), derived("E1", "moved", inner), derived("E2", "moved", outer)}
	if err := ValidateDerive(Ref{"E2", "moved"}, outer, final, allKnown); err != nil {
		t.Fatal(err)
	}
}

func TestValidateDeriveRejectsUnknownSelfAndUnboundInputs(t *testing.T) {
	d := sum(plus("A", "count_ok"))
	final := []Binding{src("A", "count_ok"), derived("E", "moved", d)}
	known := func(r Ref) bool { return r.Subject != "A" }
	wantErr(t, ValidateDerive(Ref{"E", "moved"}, d, final, known), "không có")

	self := sum(plus("E", "moved"))
	wantErr(t, ValidateDerive(Ref{"E", "moved"}, self, []Binding{derived("E", "moved", self)}, allKnown), "chính nó")

	unbound := sum(plus("Z", "count_ok"))
	wantErr(t, ValidateDerive(Ref{"E", "moved"}, unbound, []Binding{derived("E", "moved", unbound)}, allKnown), "chưa có nguồn")
}

func TestValidateDeriveIgnoresDisabledBindingsAsInputs(t *testing.T) {
	off := src("A", "count_ok")
	off.Enabled = false
	d := sum(plus("A", "count_ok"))
	wantErr(t, ValidateDerive(Ref{"E", "moved"}, d, []Binding{off, derived("E", "moved", d)}, allKnown), "chưa có nguồn")
}

func TestValidateDeriveRejectsCycles(t *testing.T) {
	a := sum(plus("B", "moved"))
	b := sum(plus("A", "moved"))
	final := []Binding{derived("A", "moved", a), derived("B", "moved", b)}
	wantErr(t, ValidateDerive(Ref{"A", "moved"}, a, final, allKnown), "vòng")
	// vòng dài ba bước
	c1, c2, c3 := sum(plus("Y", "moved")), sum(plus("Z", "moved")), sum(plus("X", "moved"))
	final = []Binding{derived("X", "moved", c1), derived("Y", "moved", c2), derived("Z", "moved", c3)}
	wantErr(t, ValidateDerive(Ref{"X", "moved"}, c1, final, allKnown), "vòng")
}

func TestValidateDeriveShapeRules(t *testing.T) {
	ok := []Binding{src("A", "count_ok")}
	wantErr(t, ValidateDerive(Ref{"E", "moved"}, Derive{Kind: KindSum}, ok, allKnown), "số hạng")
	bad := Derive{Kind: KindSum, Terms: []Term{{Subject: "A", Signal: "count_ok", Sign: 2}}}
	wantErr(t, ValidateDerive(Ref{"E", "moved"}, bad, ok, allKnown), "cộng hoặc trừ")
	wantErr(t, ValidateDerive(Ref{"E", "moved"}, Derive{Kind: "abc"}, ok, allKnown), "Kiểu công thức")
	// sum không dành cho trạng thái, activity chỉ dành cho trạng thái
	wantErr(t, ValidateDerive(Ref{"P", "state"}, sum(plus("A", "count_ok")), ok, allKnown), "chữ")
	act := Derive{Kind: KindActivity, Watch: &Ref{"A", "count_ok"}, IdleAfterS: 60}
	wantErr(t, ValidateDerive(Ref{"E", "moved"}, act, ok, allKnown), "trạng thái")
	if err := ValidateDerive(Ref{"P", "state"}, act, ok, allKnown); err != nil {
		t.Fatal(err)
	}
	wantErr(t, ValidateDerive(Ref{"P", "state"}, Derive{Kind: KindActivity, IdleAfterS: 60}, ok, allKnown), "theo dõi")
	wantErr(t, ValidateDerive(Ref{"P", "state"}, Derive{Kind: KindActivity, Watch: &Ref{"A", "count_ok"}}, ok, allKnown), "giây")
	// không theo dõi tín hiệu dạng chữ hay vị trí xe
	textWatch := Derive{Kind: KindActivity, Watch: &Ref{"A", "state"}, IdleAfterS: 60}
	wantErr(t, ValidateDerive(Ref{"P", "state"}, textWatch, []Binding{src("A", "state")}, allKnown), "số")
}

func TestDeriveInputs(t *testing.T) {
	if got := sum(plus("A", "x"), minus("B", "y")).Inputs(); len(got) != 2 || got[1] != (Ref{"B", "y"}) {
		t.Fatalf("sum inputs = %v", got)
	}
	if got := (Derive{Kind: KindActivity, Watch: &Ref{"A", "x"}}).Inputs(); len(got) != 1 || got[0] != (Ref{"A", "x"}) {
		t.Fatalf("activity inputs = %v", got)
	}
}

func TestPlanOrdersDerivedByDependencyAndDropsOthers(t *testing.T) {
	e1 := derived("E1", "moved", sum(plus("A", "count_ok")))
	e2 := derived("E2", "moved", sum(plus("E1", "moved")))
	e3 := derived("E3", "moved", sum(plus("E2", "moved"), plus("E1", "moved")))
	off := derived("E4", "moved", sum(plus("A", "count_ok")))
	off.Enabled = false
	plan := Plan([]Binding{e3, src("A", "count_ok"), e2, off, e1})
	var got []string
	for _, b := range plan {
		got = append(got, b.Subject)
	}
	if strings.Join(got, ",") != "E1,E2,E3" {
		t.Fatalf("plan = %v, muốn E1,E2,E3 (nguồn và ghép nối tắt bị bỏ)", got)
	}
}

func TestPlanKeepsBindingsEvenWhenCyclicSoNothingIsLost(t *testing.T) {
	a := derived("A", "moved", sum(plus("B", "moved")))
	b := derived("B", "moved", sum(plus("A", "moved")))
	if plan := Plan([]Binding{a, b}); len(plan) != 2 {
		t.Fatalf("plan = %v", plan)
	}
}

func reader(vals map[Ref]SigVal) func(Ref) (SigVal, bool) {
	return func(r Ref) (SigVal, bool) { v, ok := vals[r]; return v, ok }
}

func TestEvalSumAddsSignedTermsAndConstAtTheLatestInputTime(t *testing.T) {
	t1 := t0.Add(10 * time.Second)
	vals := map[Ref]SigVal{
		{"A", "moved"}: {V: 30, TS: t0},
		{"B", "moved"}: {V: 12, TS: t1},
	}
	d := Derive{Kind: KindSum, Const: 40, Terms: []Term{plus("A", "moved"), minus("B", "moved")}}
	r, ok := Eval(d, Ref{"S", "level:RAW-01"}, reader(vals), t1)
	if !ok || r.Num != 58 || !r.TS.Equal(t1) || r.Subject != "S" || r.Signal != "level:RAW-01" || r.IsText {
		t.Fatalf("reading = %+v, ok = %v", r, ok)
	}
	delete(vals, Ref{"B", "moved"})
	if _, ok := Eval(d, Ref{"S", "level:RAW-01"}, reader(vals), t1); ok {
		t.Fatal("thiếu một đầu vào thì không được phát giá trị (tránh số sai)")
	}
}

func TestEvalActivityIsRunningOnlyWhileTheWatchedCounterKeepsChanging(t *testing.T) {
	d := Derive{Kind: KindActivity, Watch: &Ref{"P", "count_in"}, IdleAfterS: 60}
	at := func(changed time.Time) map[Ref]SigVal {
		return map[Ref]SigVal{{"P", "count_in"}: {V: 5, TS: t0.Add(5 * time.Minute), Changed: changed}}
	}
	now := t0.Add(5 * time.Minute)
	r, ok := Eval(d, Ref{"P", "state"}, reader(at(now.Add(-30*time.Second))), now)
	if !ok || !r.IsText || r.Text != "RUNNING" || !r.TS.Equal(now) {
		t.Fatalf("còn hoạt động: %+v, %v", r, ok)
	}
	r, _ = Eval(d, Ref{"P", "state"}, reader(at(now.Add(-2*time.Minute))), now)
	if r.Text != "IDLE" {
		t.Fatalf("đứng yên quá 60 giây phải là IDLE: %+v", r)
	}
	r, _ = Eval(d, Ref{"P", "state"}, reader(at(time.Time{})), now)
	if r.Text != "IDLE" {
		t.Fatalf("chưa từng thấy đổi giá trị thì chưa biết máy chạy: %+v", r)
	}
	if _, ok := Eval(d, Ref{"P", "state"}, reader(map[Ref]SigVal{}), now); ok {
		t.Fatal("chưa có tín hiệu theo dõi thì không phát trạng thái")
	}
}
