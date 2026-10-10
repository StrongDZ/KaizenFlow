// Package decode turns raw model output (FrameResult) into gauge readings:
// quad homography, dial calibration, digit slots and window aggregation. It
// is shared by edge-agent and the commissioning preview of config-api, so a
// preview reads exactly as the edge will.
package decode

import (
	"fmt"
	"math"
	"strings"
	"time"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

// Gauge types of config.proto.
const (
	TypeDial    = "analog_dial"
	TypeSeg7    = "seg7"
	TypeTimer   = "timer_mmss"
	TypeRolling = "rolling_counter"
)

// Digit classifier classes.
const (
	classBlank      = 10
	classTransition = 11
	numClasses      = 12
)

const defaultRectSize = 256

// Rules are the optional physical constraints of a gauge.
type Rules struct {
	Min, Max, MaxRatePerS, Deadband *float64
	Monotonic                       bool
	ReportInterval                  time.Duration
}

// Gauge is the decoding setup of one gauge, built from its config.
type Gauge struct {
	ID, Type, Unit string
	Rules          Rules

	// Dial.
	toRect Homography
	calib  DialCalib

	// Digit displays.
	digits   int
	decimals int // digits after the decimal point
	// lit is an LED display: its segments are bright by design, so saturated
	// pixels are not glare until far more of them are.
	lit bool
}

// NewGauge validates a gauge config and prepares its decoder.
func NewGauge(cfg *gaugev1.Gauge) (*Gauge, error) {
	g := &Gauge{ID: cfg.GetGaugeId(), Type: cfg.GetType(), Unit: cfg.GetUnit()}
	if r := cfg.GetRules(); r != nil {
		g.Rules = Rules{Min: r.Min, Max: r.Max, MaxRatePerS: r.MaxRatePerS, Deadband: r.Deadband,
			Monotonic: r.GetMonotonic(), ReportInterval: time.Duration(r.GetReportIntervalS()) * time.Second}
	}
	calib := cfg.GetCalib()
	switch g.Type {
	case TypeDial:
		quad, err := gaugeQuad(cfg)
		if err != nil {
			return nil, fmt.Errorf("gauge %s: %w", g.ID, err)
		}
		size := float64(defaultRectSize)
		if cfg.RectSize != nil {
			size = float64(cfg.GetRectSize())
		}
		if g.toRect, err = QuadToSquare(quad, size); err != nil {
			return nil, fmt.Errorf("gauge %s: %w", g.ID, err)
		}
		if len(calib.GetCenter()) != 2 || len(calib.GetMinPt()) != 2 || len(calib.GetMaxPt()) != 2 ||
			calib.MinVal == nil || calib.MaxVal == nil || calib.GetMaxVal() == calib.GetMinVal() {
			return nil, fmt.Errorf("gauge %s: incomplete dial calib", g.ID)
		}
		g.calib = DialCalib{
			Center: Point{calib.GetCenter()[0], calib.GetCenter()[1]},
			MinPt:  Point{calib.GetMinPt()[0], calib.GetMinPt()[1]},
			MaxPt:  Point{calib.GetMaxPt()[0], calib.GetMaxPt()[1]},
			MinVal: calib.GetMinVal(), MaxVal: calib.GetMaxVal(),
			Clockwise: calib.GetSweep() != "ccw",
		}
	case TypeSeg7:
		g.digits = int(calib.GetDigits())
		g.lit = strings.HasSuffix(calib.GetColor(), "_led")
		g.decimals = g.digits - int(calib.GetDecimalPos())
		if g.digits < 1 || calib.DecimalPos == nil || g.decimals < 0 {
			return nil, fmt.Errorf("gauge %s: seg7 needs digits and decimal_pos", g.ID)
		}
	case TypeTimer:
		g.digits = int(calib.GetDigits())
		if g.digits != 4 || calib.GetColonAfter() != 2 {
			return nil, fmt.Errorf("gauge %s: timer_mmss needs 4 digits with the colon after 2", g.ID)
		}
	case TypeRolling:
		g.digits = int(calib.GetDigits())
		g.decimals = int(calib.GetDecimalDigits())
		if g.digits < 1 || g.decimals >= g.digits {
			return nil, fmt.Errorf("gauge %s: rolling_counter needs digits > decimal_digits", g.ID)
		}
	default:
		return nil, fmt.Errorf("gauge %s: unknown type %q", g.ID, g.Type)
	}
	return g, nil
}

// FullScale is the range of a dial (|MaxVal - MinVal|); 0 for digit displays.
func (g *Gauge) FullScale() float64 {
	if g.Type != TypeDial {
		return 0
	}
	return math.Abs(g.calib.MaxVal - g.calib.MinVal)
}

// Resolution is the smallest step a digit display can show: one unit of its
// last digit (1 s for a timer); 0 for dials.
func (g *Gauge) Resolution() float64 {
	switch g.Type {
	case TypeSeg7, TypeRolling:
		return math.Pow(10, -float64(g.decimals))
	case TypeTimer:
		return 1
	}
	return 0
}

// gaugeQuad returns the quad of the config, or the roi corners when no quad
// is given (frontal view).
func gaugeQuad(cfg *gaugev1.Gauge) ([4]Point, error) {
	var quad [4]Point
	switch {
	case len(cfg.GetQuad()) == 4:
		for i, p := range cfg.GetQuad() {
			quad[i] = Point{p.GetX(), p.GetY()}
		}
	case len(cfg.GetQuad()) == 0 && len(cfg.GetRoi()) == 4:
		x, y := float64(cfg.GetRoi()[0]), float64(cfg.GetRoi()[1])
		w, h := float64(cfg.GetRoi()[2]), float64(cfg.GetRoi()[3])
		quad = [4]Point{{x, y}, {x + w, y}, {x + w, y + h}, {x, y + h}}
	default:
		return quad, fmt.Errorf("quad must have 0 or 4 points and roi 4 numbers")
	}
	return quad, nil
}

// Reading is what one frame says about one gauge.
type Reading struct {
	TsMs  int64
	Value float64
	// Valid is false when the frame gave no usable value; Reason then holds
	// the flag explaining why (0 when the frame is merely skipped, as for a
	// rolling counter in transition).
	Valid      bool
	Reason     gaugev1.Flag
	Confidence float64 // model confidence in [0, 1]
	Sharpness  float64
	Glare      float64
	Drift      bool
}

// Options are the tunable thresholds of the decoder; they are calibrated
// against simulation data in GD5.
type Options struct {
	MinConfidence float64 // frames below this model confidence are rejected
	BlurBelow     float64 // sharpness below this flags FLAG_BLUR
	GlareAbove    float64 // glare ratio above this flags FLAG_GLARE
	// GlareAboveLit is GlareAbove for an LED display, whose lit segments
	// saturate the camera as a matter of course.
	GlareAboveLit float64
	FlagPenalty   float64 // quality multiplier per flag on a measurement
	// DialTolerance is the share of the range within which dial frames count
	// as agreeing with the window median.
	DialTolerance float64
	// DialOvertravel is the share of the range a needle may read beyond the
	// ends of the scale (a needle at rest under zero) before the measurement
	// is flagged FLAG_OUT_OF_RANGE.
	DialOvertravel float64
	// HourMeterSlack is how much faster than real time a monotonic counter may
	// advance before it is flagged; 0 disables the check (simulated meters are
	// fast-forwarded).
	HourMeterSlack float64
}

// DefaultOptions are starting values pending calibration.
func DefaultOptions() Options {
	return Options{
		MinConfidence: 0.5, BlurBelow: 20, GlareAbove: 0.10, GlareAboveLit: 0.35,
		FlagPenalty: 0.5, DialTolerance: 0.02, DialOvertravel: 0.05, HourMeterSlack: 0,
	}
}

// Read decodes one RoiResult.
func (g *Gauge) Read(tsMs int64, roi *gaugev1.RoiResult, opt Options) Reading {
	r := Reading{TsMs: tsMs, Sharpness: float64(roi.GetSharpness()), Glare: float64(roi.GetGlareRatio()), Drift: roi.GetRoiDrift()}
	if g.Type == TypeDial {
		g.readDial(roi, opt, &r)
	} else {
		g.readDigits(roi, opt, &r)
	}
	if !r.Valid && r.Reason == gaugev1.Flag_FLAG_UNSPECIFIED && g.Type != TypeRolling {
		r.Reason = gaugev1.Flag_FLAG_FORMAT_INVALID
	}
	// A frame the model could not read is most often blurred or washed out;
	// report that cause when the image statistics confirm it.
	if !r.Valid && r.Reason == gaugev1.Flag_FLAG_OCCLUDED {
		switch {
		case r.Glare > opt.GlareAbove:
			r.Reason = gaugev1.Flag_FLAG_GLARE
		case r.Sharpness < opt.BlurBelow:
			r.Reason = gaugev1.Flag_FLAG_BLUR
		}
	}
	return r
}
