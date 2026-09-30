package live

import (
	"strings"
	"testing"
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
