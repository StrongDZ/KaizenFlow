package live

import (
	"math"
	"time"
)

// BandPt là một điểm của dải dự báo P10–P50–P90 tại một thời điểm.
type BandPt struct {
	T             time.Time
	P10, P50, P90 float64
}

// Verdict là kết luận so một giá trị thật với dải dự báo cùng thời điểm.
type Verdict int

const (
	VUnknown Verdict = iota // ngoài khoảng dự báo, không so được
	VInside
	VAbove
	VBelow
)

func (v Verdict) String() string {
	return [...]string{"unknown", "inside", "above", "below"}[v]
}

// BandAt nội suy dải dự báo tại t. Ngoài khoảng dự báo thì false. bands phải sắp theo thời gian.
func BandAt(bands []BandPt, t time.Time) (BandPt, bool) {
	n := len(bands)
	if n == 0 || t.Before(bands[0].T) || t.After(bands[n-1].T) {
		return BandPt{}, false
	}
	for i := 1; i < n; i++ {
		if t.After(bands[i].T) {
			continue
		}
		a, b := bands[i-1], bands[i]
		span := b.T.Sub(a.T).Seconds()
		if span <= 0 {
			return b, true
		}
		f := t.Sub(a.T).Seconds() / span
		lerp := func(x, y float64) float64 { return x + (y-x)*f }
		return BandPt{T: t, P10: lerp(a.P10, b.P10), P50: lerp(a.P50, b.P50), P90: lerp(a.P90, b.P90)}, true
	}
	return bands[n-1], true
}

// Judge: giá trị ngoài [P10 − m, P90 + m] là lệch, với biên độ m = max(5% × |P50|, 2) để dao động nhỏ không tính là lệch.
func Judge(bands []BandPt, t time.Time, v float64) (Verdict, BandPt) {
	b, ok := BandAt(bands, t)
	if !ok {
		return VUnknown, BandPt{}
	}
	m := math.Max(0.05*math.Abs(b.P50), 2)
	switch {
	case v < b.P10-m:
		return VBelow, b
	case v > b.P90+m:
		return VAbove, b
	}
	return VInside, b
}

type streak struct {
	n     int
	dir   Verdict
	lastT time.Time
	fired bool
}

// Detector đếm số lần kiểm liên tiếp cùng lệch về một phía; đủ K thì báo một lần cho mỗi chuỗi lệch.
// Hai lần kiểm cách nhau chưa tới `gap` (giờ nhà máy) coi là cùng một quan sát: dữ liệu dày không làm báo động sớm hơn.
type Detector struct {
	k   int
	gap time.Duration
	m   map[string]*streak
}

func NewDetector(k int, gap time.Duration) *Detector {
	return &Detector{k: k, gap: gap, m: map[string]*streak{}}
}

// Observe ghi nhận một kết luận cho `key`; trả true đúng lúc chuỗi lệch đạt K lần.
func (d *Detector) Observe(key string, v Verdict, t time.Time) bool {
	s := d.m[key]
	if s == nil {
		s = &streak{}
		d.m[key] = s
	}
	if v == VInside || v == VUnknown {
		*s = streak{}
		return false
	}
	if s.n > 0 && s.dir != v {
		*s = streak{}
	}
	if s.n > 0 && t.Sub(s.lastT) < d.gap {
		return false
	}
	s.n++
	s.dir, s.lastT = v, t
	if s.n >= d.k && !s.fired {
		s.fired = true
		return true
	}
	return false
}
