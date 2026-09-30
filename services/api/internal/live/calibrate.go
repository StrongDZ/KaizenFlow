package live

import (
	"math"
	"sort"
)

// MinTrips: cần ít nhất chừng này chuyến đo được mới đề xuất hiệu chỉnh.
const MinTrips = 8

// Calibration là kết quả so thời gian chuyến đo được của một edge với `travel` mô hình đang giả định.
type Calibration struct {
	Edge        string         `json:"edge"`
	N           int            `json:"n"`
	Mean        float64        `json:"mean_s"`
	SD          float64        `json:"sd_s"`
	P50         float64        `json:"p50_s"`
	P90         float64        `json:"p90_s"`
	CurrentMean float64        `json:"current_mean_s"`
	DeltaPct    float64        `json:"delta_pct"`
	Significant bool           `json:"significant"`
	Suggested   map[string]any `json:"suggested"`
}

func round(v float64, digits int) float64 {
	p := math.Pow(10, float64(digits))
	return math.Round(v*p) / p
}

func percentile(sorted []float64, p float64) float64 {
	if len(sorted) == 1 {
		return sorted[0]
	}
	pos := p * float64(len(sorted)-1)
	lo := int(math.Floor(pos))
	hi := int(math.Ceil(pos))
	return sorted[lo] + (sorted[hi]-sorted[lo])*(pos-float64(lo))
}

// Calibrate khớp thời gian chuyến đo được (giây) thành phân phối `travel` đề xuất. Bỏ mẫu không hợp lệ (≤ 0, NaN, vô cực).
// Chênh lệch trên 10% so với mô hình hiện tại mới được đánh dấu đáng kể. Phân phối lệch nặng (cv ≥ 0,5) đề xuất lognorm.
func Calibrate(edge string, durations []float64, current any) (Calibration, bool) {
	xs := make([]float64, 0, len(durations))
	for _, d := range durations {
		if d > 0 && !math.IsNaN(d) && !math.IsInf(d, 0) {
			xs = append(xs, d)
		}
	}
	if len(xs) < MinTrips {
		return Calibration{}, false
	}
	sort.Float64s(xs)
	sum := 0.0
	for _, x := range xs {
		sum += x
	}
	mean := sum / float64(len(xs))
	sq := 0.0
	for _, x := range xs {
		sq += (x - mean) * (x - mean)
	}
	sd := math.Sqrt(sq / float64(len(xs)-1))
	c := Calibration{Edge: edge, N: len(xs), Mean: mean, SD: sd, P50: percentile(xs, 0.5), P90: percentile(xs, 0.9)}
	if cur, ok := DistMean(current); ok && cur > 0 {
		c.CurrentMean = cur
		c.DeltaPct = (mean - cur) / cur * 100
		c.Significant = math.Abs(c.DeltaPct) > 10
	}
	if cv := sd / mean; cv < 0.5 {
		c.Suggested = map[string]any{"dist": "norm", "mean": round(mean, 1), "sd": round(sd, 1)}
	} else {
		c.Suggested = map[string]any{"dist": "lognorm", "mean": round(mean, 1), "cv": round(cv, 2)}
	}
	return c, true
}
