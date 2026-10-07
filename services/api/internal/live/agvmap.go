package live

import (
	"encoding/json"
	"fmt"
	"math"
)

// Pt là một điểm trên mặt bằng (mét ở bản đồ v2).
type Pt struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type MapPoint struct {
	ID      string  `json:"id"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	Kind    string  `json:"kind"`
	NodeKey string  `json:"node_key,omitempty"`
}

// MapLane là một làn có hướng; đường hai chiều là hai làn ngược nhau.
type MapLane struct {
	ID       string `json:"id"`
	From     string `json:"from"`
	To       string `json:"to"`
	Capacity int    `json:"capacity"`
	// Path là các điểm uốn giữa hai đầu (không gồm hai đầu); rỗng là đoạn thẳng.
	Path []Pt `json:"path,omitempty"`
}

// AgvMap: từ v2, toạ độ tính bằng mét. Bản v1 (không có `v`) tính bằng "đơn vị vẽ" × unit_m; Normalize đổi sang v2.
type AgvMap struct {
	Version  int        `json:"v"`
	UnitM    float64    `json:"unit_m,omitempty"`
	SpeedMPS float64    `json:"speed_mps"`
	Points   []MapPoint `json:"points"`
	Lanes    []MapLane  `json:"lanes"`
}

type MapIssue struct{ Key, Message string }

func ParseMap(raw []byte) (*AgvMap, error) {
	var m AgvMap
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	m.Normalize()
	return &m, nil
}

// Normalize đưa bản đồ v1 về v2 (mét): nhân toạ độ điểm và điểm uốn với unit_m rồi bỏ unit_m. Chạy lại không đổi gì thêm.
func (m *AgvMap) Normalize() {
	if m.Version >= 2 {
		return
	}
	k := m.UnitM
	if k <= 0 {
		k = 1
	}
	for i := range m.Points {
		m.Points[i].X *= k
		m.Points[i].Y *= k
	}
	for i := range m.Lanes {
		for j := range m.Lanes[i].Path {
			m.Lanes[i].Path[j].X *= k
			m.Lanes[i].Path[j].Y *= k
		}
	}
	m.UnitM, m.Version = 0, 2
}

func (m *AgvMap) point(id string) *MapPoint {
	for i := range m.Points {
		if m.Points[i].ID == id {
			return &m.Points[i]
		}
	}
	return nil
}

// Polyline là đường đi của làn: điểm đầu, các điểm uốn, điểm cuối (toạ độ của bản đồ; nil nếu làn nối tới điểm không có).
func (m *AgvMap) Polyline(l MapLane) []Pt {
	a, b := m.point(l.From), m.point(l.To)
	if a == nil || b == nil {
		return nil
	}
	out := make([]Pt, 0, len(l.Path)+2)
	out = append(out, Pt{a.X, a.Y})
	out = append(out, l.Path...)
	return append(out, Pt{b.X, b.Y})
}

func polyLen(p []Pt) float64 {
	var n float64
	for i := 1; i < len(p); i++ {
		n += math.Hypot(p[i].X-p[i-1].X, p[i].Y-p[i-1].Y)
	}
	return n
}

// project chiếu (x, y) lên đường gấp khúc của làn: s là khoảng cách dọc làn từ điểm đầu, dist là khoảng cách tới làn (cùng đơn vị toạ độ).
func (m *AgvMap) project(l MapLane, x, y float64) (s, dist float64) {
	poly := m.Polyline(l)
	dist = math.Inf(1)
	var run float64
	for i := 1; i < len(poly); i++ {
		ax, ay, bx, by := poly[i-1].X, poly[i-1].Y, poly[i].X, poly[i].Y
		dx, dy := bx-ax, by-ay
		seg := math.Hypot(dx, dy)
		t := 0.0
		if seg > 0 {
			t = math.Max(0, math.Min(1, ((x-ax)*dx+(y-ay)*dy)/(seg*seg)))
		}
		if d := math.Hypot(x-(ax+t*dx), y-(ay+t*dy)); d < dist {
			dist, s = d, run+t*seg
		}
		run += seg
	}
	if len(poly) == 0 {
		return 0, math.Inf(1)
	}
	return s, dist
}

// LaneLengthM là độ dài làn theo mét: độ dài đường gấp khúc (nhân unit_m nếu bản đồ còn là v1 chưa Normalize).
func (m *AgvMap) LaneLengthM(l MapLane) float64 {
	unit := m.UnitM
	if unit <= 0 {
		unit = 1
	}
	return polyLen(m.Polyline(l)) * unit
}

// Validate kiểm bản đồ. nodeKeys khác nil thì trạm gắn node phải trỏ tới node có thật; nil nghĩa là không kiểm liên kết.
func (m *AgvMap) Validate(nodeKeys map[string]bool) []MapIssue {
	var out []MapIssue
	add := func(key, msg string) { out = append(out, MapIssue{key, msg}) }
	if m.SpeedMPS <= 0 {
		add("map", "tốc độ xe (speed_mps) phải lớn hơn 0")
	}
	points := map[string]bool{}
	for _, p := range m.Points {
		switch {
		case p.ID == "":
			add("point", "điểm thiếu id")
			continue
		case points[p.ID]:
			add(p.ID, "id điểm bị trùng")
		}
		points[p.ID] = true
		if p.Kind != "junction" && p.Kind != "station" && p.Kind != "charger" {
			add(p.ID, "loại điểm phải là junction, station hoặc charger")
		}
		if p.NodeKey != "" && nodeKeys != nil && !nodeKeys[p.NodeKey] {
			add(p.ID, fmt.Sprintf("node '%s' không có trong sơ đồ", p.NodeKey))
		}
	}
	lanes := map[string]bool{}
	for _, l := range m.Lanes {
		switch {
		case l.ID == "":
			add("lane", "làn thiếu id")
			continue
		case lanes[l.ID]:
			add(l.ID, "id làn bị trùng")
		}
		lanes[l.ID] = true
		if !points[l.From] || !points[l.To] {
			add(l.ID, "làn nối tới điểm không tồn tại")
		} else if l.From == l.To {
			add(l.ID, "làn không được nối một điểm với chính nó")
		}
		if l.Capacity < 1 {
			add(l.ID, "sức chứa làn phải từ 1 trở lên")
		}
		for _, q := range l.Path {
			if math.IsNaN(q.X) || math.IsInf(q.X, 0) || math.IsNaN(q.Y) || math.IsInf(q.Y, 0) {
				add(l.ID, "điểm uốn của làn có toạ độ không hợp lệ")
				break
			}
		}
	}
	return out
}

// Travel trả thời gian đi ngắn nhất (giây) từ node srcKey tới node dstKey theo bản đồ: từ mọi trạm gắn srcKey tới mọi trạm gắn dstKey,
// đi theo chiều của các làn, tốc độ speed_mps. ok=false khi node không có trạm trên bản đồ, không có đường, hoặc tốc độ không hợp lệ.
func (m *AgvMap) Travel(srcKey, dstKey string) (seconds float64, ok bool) {
	if m.SpeedMPS <= 0 || srcKey == "" || dstKey == "" {
		return 0, false
	}
	var starts []string
	goal := map[string]bool{}
	for _, p := range m.Points {
		if p.Kind != "station" {
			continue
		}
		if p.NodeKey == srcKey {
			starts = append(starts, p.ID)
		}
		if p.NodeKey == dstKey {
			goal[p.ID] = true
		}
	}
	if len(starts) == 0 || len(goal) == 0 {
		return 0, false
	}
	out := map[string][]MapLane{}
	for _, l := range m.Lanes {
		out[l.From] = append(out[l.From], l)
	}
	dist := map[string]float64{}
	done := map[string]bool{}
	for _, s := range starts {
		dist[s] = 0
	}
	for {
		cur, best := "", math.Inf(1)
		for id, d := range dist {
			if !done[id] && d < best {
				cur, best = id, d
			}
		}
		if cur == "" {
			return 0, false
		}
		if goal[cur] && best > 0 {
			return best / m.SpeedMPS, true
		}
		done[cur] = true
		for _, l := range out[cur] {
			nd := best + m.LaneLengthM(l)
			if d, seen := dist[l.To]; !seen || nd < d {
				dist[l.To] = nd
			}
		}
	}
}
