package live

import (
	"math"
	"testing"
)

func TestCalibrateSuggestsANormalTravelAndFlagsBigDifferences(t *testing.T) {
	durs := []float64{100, 110, 120, 130, 140, 100, 110, 120, 130, 140} // trung bình 120
	c, ok := Calibrate("KHO_A>STAMP_1", durs, map[string]any{"dist": "norm", "mean": 90.0, "sd": 15.0})
	if !ok {
		t.Fatal("10 trips are enough")
	}
	if c.N != 10 || math.Abs(c.Mean-120) > 1e-9 || c.CurrentMean != 90 || math.Abs(c.DeltaPct-33.3333) > 0.01 || !c.Significant {
		t.Errorf("calibration = %+v", c)
	}
	if c.P50 != 120 || c.P90 < 138 || c.P90 > 140 {
		t.Errorf("percentiles = %v %v", c.P50, c.P90)
	}
	if c.Suggested["dist"] != "norm" || c.Suggested["mean"] != 120.0 {
		t.Errorf("suggested = %+v", c.Suggested)
	}
	if sd, _ := c.Suggested["sd"].(float64); sd < 14 || sd > 15.5 {
		t.Errorf("sd = %v", sd)
	}
}

func TestCalibrateNeedsEnoughTripsAndIgnoresJunk(t *testing.T) {
	if _, ok := Calibrate("e", []float64{1, 2, 3}, nil); ok {
		t.Error("too few trips")
	}
	durs := []float64{100, 100, 100, 100, 100, 100, 100, 100, -5, math.NaN(), 0}
	c, ok := Calibrate("e", durs, 100.0)
	if !ok || c.N != 8 {
		t.Fatalf("junk must be dropped: %+v %v", c, ok)
	}
	if c.Significant || c.DeltaPct != 0 {
		t.Errorf("identical to the model → not significant: %+v", c)
	}
}

func TestCalibrateUsesLognormalForSkewedTravelAndHandlesUnknownCurrent(t *testing.T) {
	durs := []float64{10, 10, 10, 12, 10, 11, 10, 300, 10, 12}
	c, ok := Calibrate("e", durs, nil)
	if !ok || c.Suggested["dist"] != "lognorm" {
		t.Fatalf("a heavy tail should suggest lognorm: %+v", c)
	}
	if cv, _ := c.Suggested["cv"].(float64); cv <= 0 {
		t.Errorf("cv = %v", cv)
	}
	if c.CurrentMean != 0 || c.Significant {
		t.Errorf("no current travel means nothing to compare: %+v", c)
	}
}
