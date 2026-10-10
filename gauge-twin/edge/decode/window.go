package decode

import (
	"math"
	"sort"
	"time"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

// Aggregator turns the readings of one gauge into one measurement per window
// and remembers what it needs across windows (previous value, last report).
type Aggregator struct {
	Gauge *Gauge
	opt   Options

	readings []Reading

	hasPrev    bool
	prevValue  float64 // last value this gauge reported or accepted
	prevTsMs   int64
	lastSentMs int64
	hasSent    bool
	lastSent   float64
}

func NewAggregator(g *Gauge, opt Options) *Aggregator {
	return &Aggregator{Gauge: g, opt: opt}
}

// Add records the reading of one frame for the current window.
func (a *Aggregator) Add(r Reading) { a.readings = append(a.readings, r) }

// Result is the outcome of closing a window.
type Result struct {
	Measurement *gaugev1.Measurement
	// Due tells whether the measurement has to be sent now: dials every
	// window, digit displays on change (beyond the deadband) or after their
	// report interval.
	Due bool
}

func median(sorted []float64) float64 {
	n := len(sorted)
	if n%2 == 1 {
		return sorted[n/2]
	}
	return (sorted[n/2-1] + sorted[n/2]) / 2
}

// mode returns the most frequent value and how often it occurs; ties go to
// the value seen last, the most recent state of the display.
func mode(values []float64) (float64, int) {
	counts := map[float64]int{}
	best, bestCount := 0.0, 0
	for _, v := range values {
		counts[v]++
		if counts[v] >= bestCount {
			best, bestCount = v, counts[v]
		}
	}
	return best, bestCount
}

// heldConfidence is the model confidence assigned to a rolling counter value
// that is carried over because every frame of the window was mid-change.
const heldConfidence = 0.8

// Close ends the window that finishes at endMs and returns its measurement.
// stale marks a window closed by the watchdog because the pipeline produced
// nothing.
func (a *Aggregator) Close(endMs int64, stale bool) Result {
	g := a.Gauge
	readings := a.readings
	a.readings = a.readings[:0]

	m := &gaugev1.Measurement{GaugeId: g.ID, Unit: g.Unit}
	flags := map[gaugev1.Flag]bool{}
	reasons := map[gaugev1.Flag]int{}
	var values []float64
	var conf, sharp, glare float64
	skipped := 0 // rolling counter frames in transition
	for _, r := range readings {
		sharp += r.Sharpness
		glare += r.Glare
		if r.Drift {
			flags[gaugev1.Flag_FLAG_ROI_DRIFT] = true
		}
		switch {
		case !r.Valid && r.Reason == gaugev1.Flag_FLAG_UNSPECIFIED:
			skipped++
		case !r.Valid:
			m.NRejected++
			reasons[r.Reason]++
		case g.Type == TypeRolling && g.Rules.Monotonic && a.hasPrev && !a.acceptMonotonic(r, flags):
			m.NRejected++
		default:
			values = append(values, r.Value)
			conf += r.Confidence
			if g.Type == TypeRolling {
				a.hasPrev, a.prevValue, a.prevTsMs = true, r.Value, r.TsMs
			}
		}
	}
	m.NFrames = uint32(len(values))

	var value, consistency float64
	switch {
	case len(values) == 0 && skipped > 0 && a.hasPrev && !stale:
		// Every usable frame was mid-change: the last accepted value stands.
		value, conf = a.prevValue, heldConfidence
		m.VMin, m.VMax = value, value
		consistency = float64(skipped) / float64(len(readings))
	case len(values) == 0:
		if stale || len(readings) == 0 {
			flags[gaugev1.Flag_FLAG_STALE] = true
		}
		// The most frequent rejection reason explains the unreadable window.
		best, bestCount := gaugev1.Flag_FLAG_UNSPECIFIED, 0
		for reason, count := range reasons {
			if count > bestCount || (count == bestCount && reason < best) {
				best, bestCount = reason, count
			}
		}
		if bestCount > 0 {
			flags[best] = true
		}
		m.Flags = sortedFlags(flags)
		// An unreadable gauge is always reported, so the server sees the gap.
		return Result{Measurement: m, Due: true}
	case g.Type == TypeDial:
		sorted := append([]float64(nil), values...)
		sort.Float64s(sorted)
		value = median(sorted)
		m.VMin, m.VMax = sorted[0], sorted[len(sorted)-1]
		tolerance := a.opt.DialTolerance * math.Abs(g.calib.MaxVal-g.calib.MinVal)
		agree := 0
		for _, v := range values {
			if math.Abs(v-value) <= tolerance {
				agree++
			}
		}
		consistency = float64(agree) / float64(len(values))
		conf /= float64(len(values))
	case g.Type == TypeRolling:
		value = values[len(values)-1]
		m.VMin, m.VMax = values[0], value
		consistency = float64(len(values)+skipped) / float64(len(readings))
		conf /= float64(len(values))
	default:
		var count int
		value, count = mode(values)
		m.VMin, m.VMax = values[0], values[0]
		for _, v := range values {
			m.VMin, m.VMax = math.Min(m.VMin, v), math.Max(m.VMax, v)
		}
		consistency = float64(count) / float64(len(values))
		conf /= float64(len(values))
	}

	// Physical checks: the value is still reported, flagged.
	if (g.Rules.Min != nil && value < *g.Rules.Min) || (g.Rules.Max != nil && value > *g.Rules.Max) {
		flags[gaugev1.Flag_FLAG_OUT_OF_RANGE] = true
	}
	// A needle well outside its own scale: a gauge off its stops or a misread.
	if g.Type == TypeDial && g.calib.Overtravel(value) > a.opt.DialOvertravel {
		flags[gaugev1.Flag_FLAG_OUT_OF_RANGE] = true
	}
	if g.Type != TypeRolling {
		if g.Rules.MaxRatePerS != nil && a.hasPrev && endMs > a.prevTsMs {
			rate := math.Abs(value-a.prevValue) / (float64(endMs-a.prevTsMs) / 1000)
			if rate > *g.Rules.MaxRatePerS {
				flags[gaugev1.Flag_FLAG_RATE_LIMIT] = true
			}
		}
		a.hasPrev, a.prevValue, a.prevTsMs = true, value, endMs
	}

	meanSharp, meanGlare := sharp/float64(len(readings)), glare/float64(len(readings))
	if meanSharp < a.opt.BlurBelow {
		flags[gaugev1.Flag_FLAG_BLUR] = true
	}
	glareLimit := a.opt.GlareAbove
	if g.lit {
		glareLimit = a.opt.GlareAboveLit
	}
	if meanGlare > glareLimit {
		flags[gaugev1.Flag_FLAG_GLARE] = true
	}

	// Quality: model confidence, agreement between frames and a penalty per
	// flag. Sharpness and glare count through their flags only: the Laplacian
	// variance of a sharp display or of a small dial is low by nature, and an
	// image blurred enough to matter already lowers the model confidence.
	quality := conf * consistency * math.Pow(a.opt.FlagPenalty, float64(len(flags)))
	m.Quality = float32(clamp01(quality))
	m.Value = &value
	m.Flags = sortedFlags(flags)
	return Result{Measurement: m, Due: a.due(value, endMs)}
}

// acceptMonotonic applies the hour-meter rules to one frame: the counter may
// not go down, nor advance faster than real time (when that check is on).
func (a *Aggregator) acceptMonotonic(r Reading, flags map[gaugev1.Flag]bool) bool {
	if r.Value < a.prevValue {
		flags[gaugev1.Flag_FLAG_NON_MONOTONIC] = true
		return false
	}
	if a.opt.HourMeterSlack > 0 && r.TsMs > a.prevTsMs {
		elapsedHours := float64(r.TsMs-a.prevTsMs) / float64(time.Hour/time.Millisecond)
		// One count of the last digit is always allowed: the display is quantised.
		step := math.Pow10(-a.Gauge.decimals)
		if r.Value-a.prevValue > elapsedHours*a.opt.HourMeterSlack+step {
			flags[gaugev1.Flag_FLAG_RATE_LIMIT] = true
			return false
		}
	}
	return true
}

// due implements the "Gửi" row of the SPEC 4.2 table.
func (a *Aggregator) due(value float64, endMs int64) bool {
	g := a.Gauge
	send := true
	switch g.Type {
	case TypeDial:
		// Every window.
	case TypeRolling:
		interval := g.Rules.ReportInterval.Milliseconds()
		send = !a.hasSent || value != a.lastSent || (interval > 0 && endMs-a.lastSentMs >= interval)
	default:
		if g.Rules.Deadband != nil {
			// With a deadband: on a change beyond it, or once a minute.
			send = !a.hasSent || math.Abs(value-a.lastSent) > *g.Rules.Deadband || endMs-a.lastSentMs >= 60_000
		}
	}
	if send {
		a.hasSent, a.lastSent, a.lastSentMs = true, value, endMs
	}
	return send
}

func clamp01(v float64) float64 { return math.Min(1, math.Max(0, v)) }

func sortedFlags(set map[gaugev1.Flag]bool) []gaugev1.Flag {
	flags := make([]gaugev1.Flag, 0, len(set))
	for f := range set {
		flags = append(flags, f)
	}
	sort.Slice(flags, func(i, j int) bool { return flags[i] < flags[j] })
	return flags
}
