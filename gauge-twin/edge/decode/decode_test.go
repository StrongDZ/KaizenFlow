package decode

import (
	"math"
	"testing"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

func f64(v float64) *float64 { return &v }
func u32(v uint32) *uint32   { return &v }

// dialConfig is a 0..150 bar dial seen frontally in the frame at (100, 50),
// 256 px wide, so frame = rect + (100, 50).
func dialConfig() *gaugev1.Gauge {
	return &gaugev1.Gauge{
		GaugeId: "MAIN_PRESSURE", Type: TypeDial, Unit: "bar",
		Roi: []int32{100, 50, 256, 256},
		Calib: &gaugev1.Calib{
			Center: []float64{128, 128}, MinPt: []float64{52, 204}, MaxPt: []float64{204, 204},
			MinVal: f64(0), MaxVal: f64(150), Sweep: strp("cw"), Scale: strp("linear"),
		},
		Rules: &gaugev1.Rules{Max: f64(130), MaxRatePerS: f64(30)},
	}
}

func strp(s string) *string { return &s }

// dialRoi places the needle for a value on the dial of dialConfig. The scale
// spans 270 degrees clockwise from the lower left (135 degrees).
func dialRoi(value float64, conf float32) *gaugev1.RoiResult {
	angle := (135 + value/150*270) * math.Pi / 180
	tip := &gaugev1.Keypoint{X: float32(100 + 128 + 100*math.Cos(angle)), Y: float32(50 + 128 + 100*math.Sin(angle))}
	center := &gaugev1.Keypoint{X: 228, Y: 178}
	return &gaugev1.RoiResult{
		GaugeId:   "MAIN_PRESSURE",
		Keypoints: []*gaugev1.Keypoint{center, {}, {}, {}, tip},
		KpConf:    []float32{conf, conf, conf, conf, conf},
		Sharpness: 200,
	}
}

func mustGauge(t *testing.T, cfg *gaugev1.Gauge) *Gauge {
	t.Helper()
	g, err := NewGauge(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func TestHomographyMapsQuadCornersAndInterior(t *testing.T) {
	quad := [4]Point{{818, 350}, {1066, 356}, {1062, 598}, {822, 592}}
	h, err := QuadToSquare(quad, 256)
	if err != nil {
		t.Fatal(err)
	}
	want := [4]Point{{0, 0}, {256, 0}, {256, 256}, {0, 256}}
	for i, corner := range quad {
		got := h.Apply(corner)
		if math.Abs(got.X-want[i].X) > 1e-6 || math.Abs(got.Y-want[i].Y) > 1e-6 {
			t.Errorf("corner %d: got %+v, want %+v", i, got, want[i])
		}
	}
	// A homography keeps lines straight, so the intersection of the quad's
	// diagonals maps to the centre of the square.
	a, b, c, d := quad[0], quad[2], quad[1], quad[3]
	denom := (a.X-b.X)*(c.Y-d.Y) - (a.Y-b.Y)*(c.X-d.X)
	u := ((a.X-c.X)*(c.Y-d.Y) - (a.Y-c.Y)*(c.X-d.X)) / denom
	mid := h.Apply(Point{a.X + u*(b.X-a.X), a.Y + u*(b.Y-a.Y)})
	if math.Abs(mid.X-128) > 1e-6 || math.Abs(mid.Y-128) > 1e-6 {
		t.Errorf("centre: %+v", mid)
	}
	if _, err := QuadToSquare([4]Point{{0, 0}, {1, 1}, {2, 2}, {3, 3}}, 256); err == nil {
		t.Error("collinear quad accepted")
	}
}

func TestDialReadingFollowsNeedleAngle(t *testing.T) {
	g := mustGauge(t, dialConfig())
	for _, value := range []float64{0, 12.5, 75, 110, 150} {
		r := g.Read(1000, dialRoi(value, 0.9), DefaultOptions())
		if !r.Valid || math.Abs(r.Value-value) > 0.05 {
			t.Errorf("value %v: got %+v", value, r)
		}
		if math.Abs(r.Confidence-0.9) > 1e-6 {
			t.Errorf("confidence: %v", r.Confidence)
		}
	}
}

func TestDialCounterClockwiseAndDeadZone(t *testing.T) {
	cfg := dialConfig()
	cfg.Calib.Sweep = strp("ccw")
	cfg.Calib.MinPt, cfg.Calib.MaxPt = cfg.Calib.MaxPt, cfg.Calib.MinPt
	g := mustGauge(t, cfg)
	// Counter-clockwise from the lower right (45 degrees): 25% of the scale
	// is 67.5 degrees further, at -22.5 degrees.
	angle := (45 - 0.25*270) * math.Pi / 180
	roi := dialRoi(0, 0.9)
	roi.Keypoints[4] = &gaugev1.Keypoint{X: float32(228 + 100*math.Cos(angle)), Y: float32(178 + 100*math.Sin(angle))}
	if r := g.Read(0, roi, DefaultOptions()); math.Abs(r.Value-37.5) > 0.05 {
		t.Errorf("ccw: %+v", r)
	}

	// A needle in the dead zone reads beyond the nearer end of the scale:
	// the scale starts at 135 degrees and spans 270, so 9 degrees are 5 bar.
	cw := mustGauge(t, dialConfig())
	for angleDeg, want := range map[float64]float64{126: -5, 100: -35 * 150.0 / 270, 54: 155, 80: 150 + 35*150.0/270} {
		a := angleDeg * math.Pi / 180
		roi := dialRoi(0, 0.9)
		roi.Keypoints[4] = &gaugev1.Keypoint{X: float32(228 + 100*math.Cos(a)), Y: float32(178 + 100*math.Sin(a))}
		if r := cw.Read(0, roi, DefaultOptions()); math.Abs(r.Value-want) > 1e-3 {
			t.Errorf("dead zone at %v degrees: got %v, want %v", angleDeg, r.Value, want)
		}
	}
}

func TestOvertravelIsTheShareOfTheRangeOutsideTheScale(t *testing.T) {
	c := DialCalib{MinVal: 0, MaxVal: 150}
	for value, want := range map[float64]float64{-7.5: 0.05, 0: 0, 75: 0, 150: 0, 165: 0.1} {
		if got := c.Overtravel(value); math.Abs(got-want) > 1e-9 {
			t.Errorf("overtravel of %v: got %v, want %v", value, got, want)
		}
	}
}

func TestDialThroughPerspectiveQuad(t *testing.T) {
	cfg := dialConfig()
	cfg.Roi = []int32{812, 344, 260, 260}
	cfg.Quad = []*gaugev1.Point{{X: 818, Y: 350}, {X: 1066, Y: 356}, {X: 1062, Y: 598}, {X: 822, Y: 592}}
	cfg.RectSize = u32(256)
	g := mustGauge(t, cfg)
	// Build frame keypoints by mapping rectified positions back through the quad.
	toRect, _ := QuadToSquare([4]Point{{818, 350}, {1066, 356}, {1062, 598}, {822, 592}}, 256)
	toFrame := invert(toRect)
	angle := (135 + 0.6*270) * math.Pi / 180
	center := toFrame.Apply(Point{128, 128})
	tip := toFrame.Apply(Point{128 + 100*math.Cos(angle), 128 + 100*math.Sin(angle)})
	roi := dialRoi(0, 0.9)
	roi.Keypoints[0] = &gaugev1.Keypoint{X: float32(center.X), Y: float32(center.Y)}
	roi.Keypoints[4] = &gaugev1.Keypoint{X: float32(tip.X), Y: float32(tip.Y)}

	r := g.Read(0, roi, DefaultOptions())
	if !r.Valid || math.Abs(r.Value-90) > 0.1 {
		t.Errorf("got %+v, want 90", r)
	}
}

// invert returns the inverse of a homography (adjugate; scale is irrelevant).
func invert(h Homography) Homography {
	return Homography{
		h[4]*h[8] - h[5]*h[7], h[2]*h[7] - h[1]*h[8], h[1]*h[5] - h[2]*h[4],
		h[5]*h[6] - h[3]*h[8], h[0]*h[8] - h[2]*h[6], h[2]*h[3] - h[0]*h[5],
		h[3]*h[7] - h[4]*h[6], h[1]*h[6] - h[0]*h[7], h[0]*h[4] - h[1]*h[3],
	}
}

func TestDialLowConfidenceIsRejectedWithACause(t *testing.T) {
	g := mustGauge(t, dialConfig())
	opt := DefaultOptions()

	hidden := dialRoi(50, 0.9)
	hidden.KpConf[4] = 0.1
	if r := g.Read(0, hidden, opt); r.Valid || r.Reason != gaugev1.Flag_FLAG_OCCLUDED {
		t.Errorf("hidden tip: %+v", r)
	}
	blurred := dialRoi(50, 0.2)
	blurred.Sharpness = 5
	if r := g.Read(0, blurred, opt); r.Valid || r.Reason != gaugev1.Flag_FLAG_BLUR {
		t.Errorf("blurred: %+v", r)
	}
	glared := dialRoi(50, 0.2)
	glared.GlareRatio = 0.4
	if r := g.Read(0, glared, opt); r.Valid || r.Reason != gaugev1.Flag_FLAG_GLARE {
		t.Errorf("glare: %+v", r)
	}
	broken := dialRoi(50, 0.9)
	broken.Keypoints = broken.Keypoints[:3]
	if r := g.Read(0, broken, opt); r.Valid || r.Reason != gaugev1.Flag_FLAG_FORMAT_INVALID {
		t.Errorf("missing keypoints: %+v", r)
	}
}

// slots builds classifier output for a string of classes: digits, '_' for
// blank and 'T' for transition, each with the given probability.
func slots(text string, prob float32) []*gaugev1.SlotProbs {
	out := make([]*gaugev1.SlotProbs, len(text))
	for i, char := range text {
		class := int(char - '0')
		switch char {
		case '_':
			class = classBlank
		case 'T':
			class = classTransition
		}
		probs := make([]float32, numClasses)
		for c := range probs {
			probs[c] = (1 - prob) / float32(numClasses-1)
		}
		probs[class] = prob
		out[i] = &gaugev1.SlotProbs{Probs: probs}
	}
	return out
}

func digitGauge(t *testing.T, kind string, calib *gaugev1.Calib, rules *gaugev1.Rules) *Gauge {
	t.Helper()
	return mustGauge(t, &gaugev1.Gauge{GaugeId: "G", Type: kind, Roi: []int32{0, 0, 100, 50}, Calib: calib, Rules: rules})
}

func TestSeg7InsertsTheDecimalPointAndAllowsLeadingBlanks(t *testing.T) {
	g := digitGauge(t, TypeSeg7, &gaugev1.Calib{Digits: u32(4), DecimalPos: u32(3)}, nil)
	opt := DefaultOptions()
	cases := map[string]float64{"2205": 220.5, "_225": 22.5, "__03": 0.3, "0000": 0}
	for text, want := range cases {
		r := g.Read(0, &gaugev1.RoiResult{SlotProbs: slots(text, 0.99)}, opt)
		if !r.Valid || math.Abs(r.Value-want) > 1e-9 {
			t.Errorf("%q: got %+v, want %v", text, r, want)
		}
	}
	for _, text := range []string{"2_05", "____", "22T5", "225"} {
		r := g.Read(0, &gaugev1.RoiResult{SlotProbs: slots(text, 0.99)}, opt)
		if r.Valid || r.Reason != gaugev1.Flag_FLAG_FORMAT_INVALID {
			t.Errorf("%q should be a format error, got %+v", text, r)
		}
	}
	// Confidence is the product over the slots.
	r := g.Read(0, &gaugev1.RoiResult{SlotProbs: slots("2205", 0.9)}, opt)
	if math.Abs(r.Confidence-math.Pow(0.9, 4)) > 1e-5 {
		t.Errorf("confidence: %v", r.Confidence)
	}
	// Rejection looks at the weakest slot, so long displays are not penalised.
	if r := g.Read(0, &gaugev1.RoiResult{SlotProbs: slots("2205", 0.6)}, opt); !r.Valid {
		t.Errorf("every slot is above the threshold: %+v", r)
	}
	weak := slots("2205", 0.99)
	weak[2] = slots("0", 0.4)[0]
	if r := g.Read(0, &gaugev1.RoiResult{SlotProbs: weak, Sharpness: 200}, opt); r.Valid || r.Reason != gaugev1.Flag_FLAG_OCCLUDED {
		t.Errorf("one unsure slot must reject the frame: %+v", r)
	}
}

func TestTimerReportsSecondsAndRejectsImpossibleTimes(t *testing.T) {
	g := digitGauge(t, TypeTimer, &gaugev1.Calib{Digits: u32(4), ColonAfter: u32(2)}, nil)
	opt := DefaultOptions()
	if r := g.Read(0, &gaugev1.RoiResult{SlotProbs: slots("0325", 0.99)}, opt); !r.Valid || r.Value != 205 {
		t.Errorf("03:25: %+v", r)
	}
	for _, text := range []string{"0375", "_325"} {
		if r := g.Read(0, &gaugev1.RoiResult{SlotProbs: slots(text, 0.99)}, opt); r.Valid {
			t.Errorf("%q accepted: %+v", text, r)
		}
	}
}

func TestRollingCounterSkipsFramesInTransition(t *testing.T) {
	g := digitGauge(t, TypeRolling, &gaugev1.Calib{Digits: u32(6), DecimalDigits: u32(1)}, &gaugev1.Rules{Monotonic: boolp(true)})
	opt := DefaultOptions()
	if r := g.Read(0, &gaugev1.RoiResult{SlotProbs: slots("001234", 0.99)}, opt); !r.Valid || math.Abs(r.Value-123.4) > 1e-9 {
		t.Errorf("steady: %+v", r)
	}
	r := g.Read(0, &gaugev1.RoiResult{SlotProbs: slots("00123T", 0.99)}, opt)
	if r.Valid || r.Reason != gaugev1.Flag_FLAG_UNSPECIFIED {
		t.Errorf("transition must be skipped without a rejection reason: %+v", r)
	}
}

func boolp(v bool) *bool { return &v }

func TestNewGaugeRejectsIncompleteConfigs(t *testing.T) {
	bad := []*gaugev1.Gauge{
		{GaugeId: "a", Type: "sundial"},
		{GaugeId: "b", Type: TypeDial, Roi: []int32{0, 0, 10, 10}, Calib: &gaugev1.Calib{}},
		{GaugeId: "c", Type: TypeDial, Roi: []int32{0, 0, 10}, Calib: dialConfig().Calib},
		{GaugeId: "d", Type: TypeSeg7, Calib: &gaugev1.Calib{Digits: u32(4)}},
		{GaugeId: "e", Type: TypeTimer, Calib: &gaugev1.Calib{Digits: u32(4)}},
		{GaugeId: "f", Type: TypeRolling, Calib: &gaugev1.Calib{Digits: u32(1), DecimalDigits: u32(1)}},
	}
	for _, cfg := range bad {
		if _, err := NewGauge(cfg); err == nil {
			t.Errorf("%s accepted", cfg.GetGaugeId())
		}
	}
}

func TestFullScaleAndResolutionDescribeWhatAGaugeCanShow(t *testing.T) {
	if got := mustGauge(t, dialConfig()).FullScale(); got != 150 {
		t.Errorf("dial full scale: %v", got)
	}
	seg7 := mustGauge(t, &gaugev1.Gauge{GaugeId: "V", Type: TypeSeg7, Roi: []int32{0, 0, 96, 48},
		Calib: &gaugev1.Calib{Digits: u32(4), DecimalPos: u32(3)}})
	if got := seg7.Resolution(); math.Abs(got-0.1) > 1e-12 || seg7.FullScale() != 0 {
		t.Errorf("seg7 with one decimal: resolution %v, full scale %v", got, seg7.FullScale())
	}
	timer := mustGauge(t, &gaugev1.Gauge{GaugeId: "T", Type: TypeTimer, Roi: []int32{0, 0, 96, 48},
		Calib: &gaugev1.Calib{Digits: u32(4), ColonAfter: u32(2)}})
	if timer.Resolution() != 1 || mustGauge(t, dialConfig()).Resolution() != 0 {
		t.Errorf("timer resolution %v", timer.Resolution())
	}
}
