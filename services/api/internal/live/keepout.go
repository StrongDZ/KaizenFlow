package live

import (
	"math"
	"sort"
)

const geomEps = 1e-9

func cross(ax, ay, bx, by float64) float64 { return ax*by - ay*bx }

// onSegment: p nằm trên đoạn pq (kể cả hai đầu), sai số tương đối nhỏ.
func onSegment(p, a, b Pt) bool {
	ab := math.Hypot(b.X-a.X, b.Y-a.Y)
	if ab == 0 {
		return math.Hypot(p.X-a.X, p.Y-a.Y) <= 1e-9
	}
	if math.Abs(cross(b.X-a.X, b.Y-a.Y, p.X-a.X, p.Y-a.Y))/ab > 1e-9 {
		return false
	}
	d := ((p.X-a.X)*(b.X-a.X) + (p.Y-a.Y)*(b.Y-a.Y)) / (ab * ab)
	return d >= -geomEps && d <= 1+geomEps
}

// pointInPolygon: p nằm hẳn bên trong đa giác (điểm trên cạnh hay đỉnh tính là ở ngoài, để trạm đặt sát mép vùng cấm vẫn hợp lệ).
func pointInPolygon(p Pt, poly []Pt) bool {
	n := len(poly)
	for i := 0; i < n; i++ {
		if onSegment(p, poly[i], poly[(i+1)%n]) {
			return false
		}
	}
	in := false
	for i, j := 0, n-1; i < n; j, i = i, i+1 {
		a, b := poly[i], poly[j]
		if (a.Y > p.Y) != (b.Y > p.Y) && p.X < (b.X-a.X)*(p.Y-a.Y)/(b.Y-a.Y)+a.X {
			in = !in
		}
	}
	return in
}

// segmentEntersPolygon: đoạn ab có đoạn con nào nằm hẳn trong đa giác. Chạm mép, đi dọc mép, sượt qua đỉnh thì không tính.
// Chia đoạn ở mọi chỗ cắt cạnh rồi thử điểm giữa của từng khúc: khúc nằm trong là đi vào vùng.
func segmentEntersPolygon(a, b Pt, poly []Pt) bool {
	if a == b {
		return pointInPolygon(a, poly)
	}
	rx, ry := b.X-a.X, b.Y-a.Y
	ts := []float64{0, 1}
	n := len(poly)
	for i := 0; i < n; i++ {
		p, q := poly[i], poly[(i+1)%n]
		sx, sy := q.X-p.X, q.Y-p.Y
		denom := cross(rx, ry, sx, sy)
		if math.Abs(denom) > geomEps {
			t := cross(p.X-a.X, p.Y-a.Y, sx, sy) / denom
			u := cross(p.X-a.X, p.Y-a.Y, rx, ry) / denom
			if t >= 0 && t <= 1 && u >= 0 && u <= 1 {
				ts = append(ts, t)
			}
			continue
		}
		if math.Abs(cross(p.X-a.X, p.Y-a.Y, rx, ry)) <= geomEps { // song song và cùng đường thẳng: lấy hai đầu cạnh nằm trên đoạn
			rr := rx*rx + ry*ry
			for _, e := range []Pt{p, q} {
				if t := ((e.X-a.X)*rx + (e.Y-a.Y)*ry) / rr; t > 0 && t < 1 {
					ts = append(ts, t)
				}
			}
		}
	}
	sort.Float64s(ts)
	for i := 1; i < len(ts); i++ {
		if ts[i]-ts[i-1] <= geomEps {
			continue
		}
		mid := (ts[i] + ts[i-1]) / 2
		if pointInPolygon(Pt{a.X + rx*mid, a.Y + ry*mid}, poly) {
			return true
		}
	}
	return false
}

// polygonArea trả diện tích có dấu (công thức dây giày).
func polygonArea(poly []Pt) float64 {
	var s float64
	for i := range poly {
		j := (i + 1) % len(poly)
		s += poly[i].X*poly[j].Y - poly[j].X*poly[i].Y
	}
	return s / 2
}
