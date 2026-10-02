package live

import "math"

const (
	// MatchTolM: xe cách làn xa hơn mức này (mét) thì coi là ngoài đường.
	MatchTolM = 2.5
	// matchTieM: hai làn có khoảng cách chênh nhau dưới mức này thì coi là "ngang nhau" và phải xét thêm hướng/trạng thái.
	matchTieM = 0.35
)

// MatchIn là thông tin phụ giúp chọn làn khi xe nằm gần nhiều làn: làn của bản tin trước, hướng (độ), trạng thái.
type MatchIn struct {
	PrevLane string
	Heading  *float64
	State    string
}

// Match là kết quả khớp một vị trí vào làn: S là mét dọc làn từ điểm đầu, Dist là khoảng cách tới làn.
type Match struct {
	Lane string
	S    float64
	Dist float64
	Off  bool
}

type cand struct {
	lane MapLane
	s    float64
	dist float64
	frac float64
}

// angleAt là hướng (độ, atan2(dy, dx)) của làn tại khoảng cách s kể từ điểm đầu.
func angleAt(poly []Pt, s float64) float64 {
	var run float64
	for i := 1; i < len(poly); i++ {
		dx, dy := poly[i].X-poly[i-1].X, poly[i].Y-poly[i-1].Y
		seg := math.Hypot(dx, dy)
		if seg == 0 {
			continue
		}
		if s <= run+seg || i == len(poly)-1 {
			return math.Atan2(dy, dx) * 180 / math.Pi
		}
		run += seg
	}
	return 0
}

// Match khớp (x, y) (toạ độ bản đồ, mét) vào làn gần nhất trong dung sai. Bản đồ phải là v2.
// Nhiều làn gần ngang nhau (làn ngược chiều đi sát nhau, đầu và cuối làn nối tiếp tại ngã ba) thì chọn theo thứ tự:
// làn cũ của xe, làn cùng hướng với hướng xe, rồi theo trạng thái (đang chờ → cuối làn, còn lại → đầu làn).
func (m *AgvMap) Match(x, y float64, in MatchIn) Match {
	var cs []cand
	best := math.Inf(1)
	for _, l := range m.Lanes {
		s, d := m.project(l, x, y)
		if d > MatchTolM {
			continue
		}
		length := polyLen(m.Polyline(l))
		frac := 0.0
		if length > 0 {
			frac = s / length
		}
		cs = append(cs, cand{l, s, d, frac})
		best = math.Min(best, d)
	}
	if len(cs) == 0 {
		return Match{Off: true}
	}
	var tied []cand
	for _, c := range cs {
		if c.dist <= best+matchTieM {
			tied = append(tied, c)
		}
	}
	pick := tied[0]
	for _, c := range tied[1:] {
		if c.dist < pick.dist {
			pick = c
		}
	}
	if len(tied) > 1 {
		pick = tieBreak(m, tied, pick, in)
	}
	return Match{Lane: pick.lane.ID, S: pick.s, Dist: pick.dist}
}

func tieBreak(m *AgvMap, tied []cand, closest cand, in MatchIn) cand {
	for _, c := range tied {
		if in.PrevLane != "" && c.lane.ID == in.PrevLane {
			return c
		}
	}
	if in.Heading != nil {
		top, topCos := closest, -2.0
		for _, c := range tied {
			a := angleAt(m.Polyline(c.lane), c.s)
			if cos := math.Cos((a - *in.Heading) * math.Pi / 180); cos > topCos {
				top, topCos = c, cos
			}
		}
		if topCos > 0.2 {
			return top
		}
	}
	// Ngã ba: xe đang chờ đang ở cuối làn đến, xe đang chạy vừa rời đầu làn kế. Chỉ xét khi có ứng viên đúng ở đầu/cuối làn.
	var ends []cand
	for _, c := range tied {
		if in.State == "WAITING" && c.frac >= 0.98 || in.State != "WAITING" && c.frac <= 0.02 {
			ends = append(ends, c)
		}
	}
	if len(ends) > 0 {
		pick := ends[0]
		for _, c := range ends[1:] {
			if c.dist < pick.dist {
				pick = c
			}
		}
		return pick
	}
	return closest
}
