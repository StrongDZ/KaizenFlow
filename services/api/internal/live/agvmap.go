package live

import (
	"encoding/json"
	"fmt"
	"math"
)

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
}

type AgvMap struct {
	UnitM    float64    `json:"unit_m"`
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
	return &m, nil
}

// LaneLengthM là độ dài làn theo mét (khoảng cách hai điểm nhân đơn vị bản đồ; unit_m mặc định 1).
func (m *AgvMap) LaneLengthM(l MapLane) float64 {
	var a, b *MapPoint
	for i := range m.Points {
		switch m.Points[i].ID {
		case l.From:
			a = &m.Points[i]
		case l.To:
			b = &m.Points[i]
		}
	}
	if a == nil || b == nil {
		return 0
	}
	unit := m.UnitM
	if unit <= 0 {
		unit = 1
	}
	return math.Hypot(a.X-b.X, a.Y-b.Y) * unit
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
