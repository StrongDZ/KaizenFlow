package live

import (
	"math"
	"testing"
	"time"
)

var d0 = time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC)

func band(min int, p10, p50, p90 float64) BandPt {
	return BandPt{T: d0.Add(time.Duration(min) * time.Minute), P10: p10, P50: p50, P90: p90}
}

func TestBandAtInterpolatesAndRefusesOutsideTheForecast(t *testing.T) {
	bs := []BandPt{band(0, 90, 100, 110), band(10, 70, 80, 90)}
	b, ok := BandAt(bs, d0.Add(5*time.Minute))
	if !ok || math.Abs(b.P10-80) > 1e-9 || math.Abs(b.P50-90) > 1e-9 || math.Abs(b.P90-100) > 1e-9 {
		t.Errorf("midpoint = %+v %v", b, ok)
	}
	if _, ok := BandAt(bs, d0.Add(-time.Second)); ok {
		t.Error("before the first point there is no forecast")
	}
	if _, ok := BandAt(bs, d0.Add(11*time.Minute)); ok {
		t.Error("after the last point there is no forecast")
	}
	if b, ok := BandAt(bs, d0.Add(10*time.Minute)); !ok || b.P50 != 80 {
		t.Errorf("the last point itself is inside: %+v %v", b, ok)
	}
	if _, ok := BandAt(nil, d0); ok {
		t.Error("no bands, no answer")
	}
}

func TestJudgeUsesAMarginSoTinyExcursionsAreNotDrift(t *testing.T) {
	bs := []BandPt{band(0, 90, 100, 110), band(60, 90, 100, 110)}
	at := d0.Add(30 * time.Minute)
	cases := []struct {
		v    float64
		want Verdict
	}{
		{100, VInside}, {90, VInside}, {110, VInside},
		{88.5, VInside}, // dưới P10 nhưng trong biên độ (max(5% × 100, 2) = 5)
		{84, VBelow}, {116, VAbove},
	}
	for _, c := range cases {
		if got, _ := Judge(bs, at, c.v); got != c.want {
			t.Errorf("Judge(%v) = %v, want %v", c.v, got, c.want)
		}
	}
	if v, _ := Judge(bs, d0.Add(2*time.Hour), 5); v != VUnknown {
		t.Errorf("outside the forecast window must be unknown, got %v", v)
	}
	small := []BandPt{band(0, 0, 1, 2), band(60, 0, 1, 2)}
	if v, _ := Judge(small, at, 3.9); v != VInside {
		t.Errorf("margin has a floor of 2 units, got %v", v)
	}
	if v, _ := Judge(small, at, 4.5); v != VAbove {
		t.Errorf("clearly above even with the floor, got %v", v)
	}
}

func TestDetectorNeedsConsecutiveDistinctSamplesAndFiresOncePerStreak(t *testing.T) {
	d := NewDetector(3, 5*time.Minute)
	at := func(m int) time.Time { return d0.Add(time.Duration(m) * time.Minute) }
	if d.Observe("k", VBelow, at(0)) || d.Observe("k", VBelow, at(6)) {
		t.Fatal("must not fire before the third out-of-band sample")
	}
	if d.Observe("k", VBelow, at(7)) {
		t.Fatal("a sample less than the gap after the previous one is the same observation")
	}
	if !d.Observe("k", VBelow, at(12)) {
		t.Fatal("third sample spaced by the gap should fire")
	}
	if d.Observe("k", VBelow, at(20)) || d.Observe("k", VBelow, at(30)) {
		t.Fatal("the streak already fired; do not fire again until it ends")
	}
	d.Observe("k", VInside, at(40))
	d.Observe("k", VAbove, at(50))
	d.Observe("k", VAbove, at(56))
	if !d.Observe("k", VAbove, at(62)) {
		t.Fatal("a new streak fires again after coming back inside")
	}
}

func TestDetectorResetsOnDirectionChangeUnknownAndKeepsKeysApart(t *testing.T) {
	d := NewDetector(2, time.Minute)
	at := func(m int) time.Time { return d0.Add(time.Duration(m) * time.Minute) }
	d.Observe("a", VBelow, at(0))
	if d.Observe("a", VAbove, at(2)) {
		t.Fatal("direction change restarts the count")
	}
	d.Observe("b", VBelow, at(0))
	if !d.Observe("a", VAbove, at(4)) {
		t.Fatal("two above samples in a row fire")
	}
	if d.Observe("b", VUnknown, at(5)) {
		t.Fatal("unknown never fires")
	}
	if d.Observe("b", VBelow, at(6)) {
		t.Fatal("unknown broke b's streak")
	}
}
