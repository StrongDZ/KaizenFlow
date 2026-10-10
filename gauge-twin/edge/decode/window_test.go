package decode

import (
	"math"
	"reflect"
	"testing"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

func valid(ts int64, value float64) Reading {
	return Reading{TsMs: ts, Value: value, Valid: true, Confidence: 0.9, Sharpness: 200}
}

func rejected(reason gaugev1.Flag) Reading {
	return Reading{Reason: reason, Sharpness: 200}
}

func flagsOf(m *gaugev1.Measurement) []gaugev1.Flag { return m.GetFlags() }

func TestDialWindowReportsMedianMinMaxEveryWindow(t *testing.T) {
	a := NewAggregator(mustGauge(t, dialConfig()), DefaultOptions())
	for i, v := range []float64{50, 52, 51, 90, 50.5} {
		a.Add(valid(int64(i*200), v))
	}
	a.Add(rejected(gaugev1.Flag_FLAG_OCCLUDED))

	res := a.Close(1000, false)
	m := res.Measurement

	if !res.Due || m.GetValue() != 51 || m.GetVMin() != 50 || m.GetVMax() != 90 {
		t.Errorf("measurement: %v due=%v", m, res.Due)
	}
	if m.GetNFrames() != 5 || m.GetNRejected() != 1 || len(flagsOf(m)) != 0 {
		t.Errorf("counts/flags: %v", m)
	}
	// 4 of 5 frames agree with the median (90 is an outlier): 0.9 * 1 * 1 * 0.8.
	if math.Abs(float64(m.GetQuality())-0.72) > 1e-3 {
		t.Errorf("quality: %v", m.GetQuality())
	}
	// Dials are due on every window, even without change.
	a.Add(valid(1200, 51))
	if res := a.Close(2000, false); !res.Due {
		t.Error("dial not due on the second window")
	}
}

func TestDialFlagsOutOfRangeAndRateLimitButKeepsTheValue(t *testing.T) {
	a := NewAggregator(mustGauge(t, dialConfig()), DefaultOptions())
	a.Add(valid(0, 60))
	a.Close(1000, false)
	a.Add(valid(1500, 140)) // above rules.max = 130 and 80 bar/s > 30 bar/s

	m := a.Close(2000, false).Measurement

	want := []gaugev1.Flag{gaugev1.Flag_FLAG_OUT_OF_RANGE, gaugev1.Flag_FLAG_RATE_LIMIT}
	if m.GetValue() != 140 || !reflect.DeepEqual(flagsOf(m), want) {
		t.Errorf("got %v", m)
	}
	// Two flags: quality 0.9 * 0.5 * 0.5.
	if math.Abs(float64(m.GetQuality())-0.225) > 1e-3 {
		t.Errorf("quality: %v", m.GetQuality())
	}
}

func TestDialRestingJustUnderZeroIsReportedAndFarOutsideIsFlagged(t *testing.T) {
	cfg := dialConfig()
	cfg.Rules = nil
	a := NewAggregator(mustGauge(t, cfg), DefaultOptions())

	// 2% under the scale: a needle on its stop. Reported as it is, no flag.
	a.Add(valid(0, -3))
	if m := a.Close(1000, false).Measurement; m.GetValue() != -3 || len(flagsOf(m)) != 0 {
		t.Errorf("at rest: got %v", m)
	}
	// 20% beyond full scale: flagged, value kept.
	a.Add(valid(1500, 180))
	m := a.Close(2000, false).Measurement
	if m.GetValue() != 180 || !reflect.DeepEqual(flagsOf(m), []gaugev1.Flag{gaugev1.Flag_FLAG_OUT_OF_RANGE}) {
		t.Errorf("beyond the scale: got %v", m)
	}
}

func TestQualityDropsWithBlurAndGlareFlagsOnly(t *testing.T) {
	quality := func(sharpness, glare float64) (float32, []gaugev1.Flag) {
		a := NewAggregator(mustGauge(t, dialConfig()), DefaultOptions())
		r := valid(0, 50)
		r.Sharpness, r.Glare = sharpness, glare
		a.Add(r)
		m := a.Close(1000, false).Measurement
		return m.GetQuality(), flagsOf(m)
	}
	// A soft image the model reads with confidence is a good reading: 0.9.
	if q, flags := quality(30, 0.05); math.Abs(float64(q)-0.9) > 1e-3 || len(flags) != 0 {
		t.Errorf("soft image: %v %v", q, flags)
	}
	// Glare above GlareAbove: flagged, 0.9 * 0.5.
	if q, flags := quality(200, 0.25); math.Abs(float64(q)-0.45) > 1e-3 || !reflect.DeepEqual(flags, []gaugev1.Flag{gaugev1.Flag_FLAG_GLARE}) {
		t.Errorf("glare: %v %v", q, flags)
	}
	// Blurred and glaring: two flags, 0.9 * 0.25.
	if q, flags := quality(10, 0.25); math.Abs(float64(q)-0.225) > 1e-3 || len(flags) != 2 {
		t.Errorf("blur and glare: %v %v", q, flags)
	}
}

func TestLitSegmentsOfAnLEDDisplayAreNotGlare(t *testing.T) {
	for color, want := range map[string]bool{"red_led": false, "lcd": true} {
		g := digitGauge(t, TypeSeg7, &gaugev1.Calib{Digits: u32(4), DecimalPos: u32(3), Color: &color}, nil)
		a := NewAggregator(g, DefaultOptions())
		r := valid(0, 12.5)
		r.Glare = 0.2
		a.Add(r)
		flagged := len(flagsOf(a.Close(1000, false).Measurement)) > 0
		if flagged != want {
			t.Errorf("%s with 20%% saturated pixels: flagged %v, want %v", color, flagged, want)
		}
	}
}

func TestUnreadableWindowHasNoValueAndExplainsWhy(t *testing.T) {
	a := NewAggregator(mustGauge(t, dialConfig()), DefaultOptions())
	a.Add(rejected(gaugev1.Flag_FLAG_BLUR))
	a.Add(rejected(gaugev1.Flag_FLAG_BLUR))
	a.Add(rejected(gaugev1.Flag_FLAG_OCCLUDED))

	res := a.Close(1000, false)
	m := res.Measurement

	if m.Value != nil || !res.Due || m.GetQuality() != 0 || m.GetNRejected() != 3 {
		t.Errorf("got %v due=%v", m, res.Due)
	}
	if !reflect.DeepEqual(flagsOf(m), []gaugev1.Flag{gaugev1.Flag_FLAG_BLUR}) {
		t.Errorf("flags: %v", flagsOf(m))
	}

	// No frames at all, or a watchdog close: stale.
	if m := a.Close(2000, false).Measurement; m.Value != nil || !reflect.DeepEqual(flagsOf(m), []gaugev1.Flag{gaugev1.Flag_FLAG_STALE}) {
		t.Errorf("empty window: %v", m)
	}
	a.Add(valid(2100, 50))
	if m := a.Close(3000, true).Measurement; m.Value == nil {
		t.Errorf("a stale close with usable frames still reports them: %v", m)
	}
}

func TestRoiDriftIsFlagged(t *testing.T) {
	a := NewAggregator(mustGauge(t, dialConfig()), DefaultOptions())
	r := valid(0, 50)
	r.Drift = true
	a.Add(r)
	if m := a.Close(1000, false).Measurement; !reflect.DeepEqual(flagsOf(m), []gaugev1.Flag{gaugev1.Flag_FLAG_ROI_DRIFT}) {
		t.Errorf("flags: %v", flagsOf(m))
	}
}

func TestSeg7WindowReportsTheMostFrequentValue(t *testing.T) {
	g := digitGauge(t, TypeSeg7, &gaugev1.Calib{Digits: u32(4), DecimalPos: u32(3)}, &gaugev1.Rules{Min: f64(0), Max: f64(500)})
	a := NewAggregator(g, DefaultOptions())
	for i, v := range []float64{220.5, 220.5, 220.4, 220.5} {
		a.Add(valid(int64(i*250), v))
	}

	res := a.Close(1000, false)
	m := res.Measurement

	if !res.Due || m.GetValue() != 220.5 || m.GetVMin() != 220.4 || m.GetVMax() != 220.5 {
		t.Errorf("got %v", m)
	}
	// Three of four frames agree: 0.9 * 0.75.
	if math.Abs(float64(m.GetQuality())-0.675) > 1e-3 {
		t.Errorf("quality: %v", m.GetQuality())
	}
}

func TestSeg7WithDeadbandIsOnlyDueOnChangeOrAfterAMinute(t *testing.T) {
	g := digitGauge(t, TypeSeg7, &gaugev1.Calib{Digits: u32(4), DecimalPos: u32(3)}, &gaugev1.Rules{Deadband: f64(0.5)})
	a := NewAggregator(g, DefaultOptions())
	due := func(endMs int64, value float64) bool {
		a.Add(valid(endMs-500, value))
		return a.Close(endMs, false).Due
	}

	if !due(1000, 220.0) {
		t.Error("first value must be sent")
	}
	if due(2000, 220.3) {
		t.Error("change within the deadband was sent")
	}
	if !due(3000, 220.6) {
		t.Error("change beyond the deadband (relative to the last sent value) was not sent")
	}
	if due(4000, 220.6) || due(62_000, 220.6) {
		t.Error("unchanged value sent too early")
	}
	if !due(63_000, 220.6) {
		t.Error("unchanged value must be refreshed after a minute")
	}
}

func rollingAggregator(t *testing.T, opt Options) *Aggregator {
	rules := &gaugev1.Rules{Monotonic: boolp(true), ReportIntervalS: u32(300)}
	return NewAggregator(digitGauge(t, TypeRolling, &gaugev1.Calib{Digits: u32(6), DecimalDigits: u32(1)}, rules), opt)
}

func TestRollingCounterHoldsLastValueDuringTransitionAndReportsOnChange(t *testing.T) {
	a := rollingAggregator(t, DefaultOptions())
	transition := Reading{Sharpness: 200} // skipped frame: not valid, no reason

	a.Add(valid(100, 123.4))
	a.Add(valid(600, 123.4))
	first := a.Close(1000, false)
	if !first.Due || first.Measurement.GetValue() != 123.4 {
		t.Fatalf("first: %v", first.Measurement)
	}

	// A window with only transition frames keeps the value and is not due.
	a.Add(transition)
	a.Add(transition)
	held := a.Close(2000, false)
	if held.Due || held.Measurement.GetValue() != 123.4 || held.Measurement.GetNRejected() != 0 || held.Measurement.GetNFrames() != 0 {
		t.Errorf("held: %v due=%v", held.Measurement, held.Due)
	}

	a.Add(transition)
	a.Add(valid(2800, 123.5))
	changed := a.Close(3000, false)
	if !changed.Due || changed.Measurement.GetValue() != 123.5 {
		t.Errorf("changed: %v", changed.Measurement)
	}

	// Unchanged: due again only after report_interval_s.
	a.Add(valid(3500, 123.5))
	if a.Close(4000, false).Due {
		t.Error("unchanged counter sent before its report interval")
	}
	a.Add(valid(303_500, 123.5))
	if !a.Close(304_000, false).Due {
		t.Error("counter not refreshed after its report interval")
	}
}

func TestRollingCounterRejectsDecreasesAndImpossibleJumps(t *testing.T) {
	a := rollingAggregator(t, DefaultOptions())
	a.Add(valid(0, 500.0))
	a.Close(1000, false)

	a.Add(valid(1500, 499.9)) // a misread digit
	m := a.Close(2000, false).Measurement
	if m.Value != nil || m.GetNRejected() != 1 || !reflect.DeepEqual(flagsOf(m), []gaugev1.Flag{gaugev1.Flag_FLAG_NON_MONOTONIC}) {
		t.Errorf("decrease: %v", m)
	}
	a.Add(valid(2500, 500.1))
	if m := a.Close(3000, false).Measurement; m.GetValue() != 500.1 {
		t.Errorf("recovery: %v", m)
	}

	// With the real-time check on, an hour meter cannot gain 5 h in a second.
	opt := DefaultOptions()
	opt.HourMeterSlack = 1
	strict := rollingAggregator(t, opt)
	strict.Add(valid(0, 500.0))
	strict.Close(1000, false)
	strict.Add(valid(1500, 505.0))
	m = strict.Close(2000, false).Measurement
	if m.Value != nil || !reflect.DeepEqual(flagsOf(m), []gaugev1.Flag{gaugev1.Flag_FLAG_RATE_LIMIT}) {
		t.Errorf("jump: %v", m)
	}
	strict.Add(valid(2500, 500.1)) // one count of the last digit is fine
	if m := strict.Close(3000, false).Measurement; m.GetValue() != 500.1 {
		t.Errorf("single step: %v", m)
	}
}

func TestAggregatorStartsEachWindowEmpty(t *testing.T) {
	a := NewAggregator(mustGauge(t, dialConfig()), DefaultOptions())
	a.Add(valid(0, 10))
	a.Close(1000, false)
	a.Add(valid(1100, 20))
	if m := a.Close(2000, false).Measurement; m.GetNFrames() != 1 || m.GetValue() != 20 {
		t.Errorf("window leaked readings: %v", m)
	}
}
