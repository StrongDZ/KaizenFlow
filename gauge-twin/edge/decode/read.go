package decode

import (
	"math"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

// Keypoint order of the dial model.
const (
	kpCenter = 0
	kpTip    = 4
	kpCount  = 5
)

// readDial: pivot and tip go through the quad homography into the rectified
// square, where the angle is interpolated between calib min_pt and max_pt.
func (g *Gauge) readDial(roi *gaugev1.RoiResult, opt Options, r *Reading) {
	kps, conf := roi.GetKeypoints(), roi.GetKpConf()
	if len(kps) != kpCount || len(conf) != kpCount {
		r.Reason = gaugev1.Flag_FLAG_FORMAT_INVALID
		return
	}
	// Only the pivot and the tip enter the reading.
	r.Confidence = (float64(conf[kpCenter]) + float64(conf[kpTip])) / 2
	if float64(conf[kpCenter]) < opt.MinConfidence || float64(conf[kpTip]) < opt.MinConfidence {
		r.Reason = gaugev1.Flag_FLAG_OCCLUDED
		return
	}
	center := g.toRect.Apply(Point{float64(kps[kpCenter].GetX()), float64(kps[kpCenter].GetY())})
	tip := g.toRect.Apply(Point{float64(kps[kpTip].GetX()), float64(kps[kpTip].GetY())})
	r.Value = g.calib.Value(center, tip)
	r.Valid = true
}

// readDigits handles seg7, timer_mmss and rolling_counter displays.
func (g *Gauge) readDigits(roi *gaugev1.RoiResult, opt Options, r *Reading) {
	slots := roi.GetSlotProbs()
	if len(slots) != g.digits {
		r.Reason = gaugev1.Flag_FLAG_FORMAT_INVALID
		return
	}
	classes := make([]int, g.digits)
	r.Confidence = 1
	weakest := 1.0
	for i, slot := range slots {
		probs := slot.GetProbs()
		if len(probs) != numClasses {
			r.Reason = gaugev1.Flag_FLAG_FORMAT_INVALID
			r.Confidence = 0
			return
		}
		best := 0
		for c, p := range probs {
			if p > probs[best] {
				best = c
			}
		}
		classes[i] = best
		// Product of the slot probabilities: every digit has to be right.
		r.Confidence *= float64(probs[best])
		weakest = math.Min(weakest, float64(probs[best]))
	}
	// Frames are rejected on their weakest slot, not on the product, which
	// would penalise displays simply for having more digits.
	if weakest < opt.MinConfidence {
		r.Reason = gaugev1.Flag_FLAG_OCCLUDED
		return
	}

	number, ok := 0.0, true
	switch g.Type {
	case TypeRolling:
		for _, c := range classes {
			if c == classTransition {
				// A wheel is mid-change: skip the frame, the last accepted value stands.
				return
			}
			if c == classBlank {
				ok = false
			}
			number = number*10 + float64(c)
		}
		number /= math.Pow10(g.decimals)
	case TypeTimer:
		for _, c := range classes {
			if c >= classBlank {
				ok = false
			}
		}
		minutes, seconds := classes[0]*10+classes[1], classes[2]*10+classes[3]
		if seconds >= 60 {
			ok = false
		}
		number = float64(minutes*60 + seconds)
	default: // seg7: leading blanks are allowed, anything else must be a digit
		leading, any := true, false
		for _, c := range classes {
			switch {
			case c == classBlank && leading:
				continue
			case c >= classBlank:
				ok = false
			default:
				leading, any = false, true
				number = number*10 + float64(c)
			}
		}
		if !any {
			ok = false
		}
		number /= math.Pow10(g.decimals)
	}
	if !ok {
		r.Reason = gaugev1.Flag_FLAG_FORMAT_INVALID
		return
	}
	r.Value = number
	r.Valid = true
}
