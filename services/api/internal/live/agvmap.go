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

// MapBG là chỗ đặt ảnh mặt bằng làm nền: góc trên trái của ảnh nằm ở (X, Y) mét, mỗi pixel ảnh là MPerPx mét.
// Ảnh nằm ở bảng riêng (agv_map_image); Rev đổi mỗi lần tải ảnh mới để trình duyệt không dùng ảnh cũ trong bộ nhớ đệm.
// Calibrated: người dùng đã hiệu chuẩn tỉ lệ bằng hai điểm đã biết khoảng cách (chưa thì tỉ lệ chỉ là ước đoán).
// Rot: góc xoay ảnh (độ, chiều kim đồng hồ trên bản đồ) quanh tâm ảnh; (X, Y) vẫn là góc trên trái của ảnh khi chưa xoay.
type MapBG struct {
	X          float64 `json:"x"`
	Y          float64 `json:"y"`
	MPerPx     float64 `json:"m_per_px"`
	WPx        int     `json:"w_px"`
	HPx        int     `json:"h_px"`
	Rev        int64   `json:"rev,omitempty"`
	Calibrated bool    `json:"calibrated,omitempty"`
	Rot        float64 `json:"rot,omitempty"`
}

// MapKeepout là vùng xe không được vào (máy, kệ, tường...): đa giác khép kín từ 3 đỉnh.
type MapKeepout struct {
	ID   string `json:"id"`
	Poly []Pt   `json:"poly"`
}

// AgvMap: từ v2, toạ độ tính bằng mét. Bản v1 (không có `v`) tính bằng "đơn vị vẽ" × unit_m; Normalize đổi sang v2.
type AgvMap struct {
	Version  int          `json:"v"`
	UnitM    float64      `json:"unit_m,omitempty"`
	SpeedMPS float64      `json:"speed_mps"`
	BG       *MapBG       `json:"bg,omitempty"`
	Keepouts []MapKeepout `json:"keepouts,omitempty"`
	Points   []MapPoint   `json:"points"`
	Lanes    []MapLane    `json:"lanes"`
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
	if b := m.BG; b != nil {
		switch {
		case !(b.MPerPx > 0) || math.IsInf(b.MPerPx, 0):
			add("bg", "tỉ lệ ảnh nền (m_per_px) phải lớn hơn 0")
		case b.WPx <= 0 || b.HPx <= 0:
			add("bg", "kích thước ảnh nền (w_px, h_px) phải lớn hơn 0")
		case math.IsNaN(b.X) || math.IsInf(b.X, 0) || math.IsNaN(b.Y) || math.IsInf(b.Y, 0):
			add("bg", "vị trí ảnh nền không hợp lệ")
		case math.IsNaN(b.Rot) || math.IsInf(b.Rot, 0):
			add("bg", "góc xoay ảnh nền không hợp lệ")
		}
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
	m.validateKeepouts(add)
	return out
}

// validateKeepouts kiểm các vùng cấm (id, đa giác hợp lệ) rồi kiểm không điểm nào nằm trong vùng và không làn nào đi vào vùng.
// Vùng hỏng thì chỉ báo lỗi của chính nó, không dùng để kiểm điểm và làn.
func (m *AgvMap) validateKeepouts(add func(key, msg string)) {
	ids := map[string]bool{}
	var usable []MapKeepout
	for _, k := range m.Keepouts {
		bad := false
		switch {
		case k.ID == "":
			add("keepout", "vùng cấm thiếu id")
			bad = true
		case ids[k.ID]:
			add(k.ID, "id vùng cấm bị trùng")
			bad = true
		}
		ids[k.ID] = true
		finite := true
		for _, q := range k.Poly {
			if math.IsNaN(q.X) || math.IsInf(q.X, 0) || math.IsNaN(q.Y) || math.IsInf(q.Y, 0) {
				finite = false
			}
		}
		switch {
		case bad:
		case len(k.Poly) < 3:
			add(k.ID, "vùng cấm cần ít nhất 3 đỉnh")
		case !finite:
			add(k.ID, "đỉnh của vùng cấm có toạ độ không hợp lệ")
		case math.Abs(polygonArea(k.Poly)) <= geomEps:
			add(k.ID, "vùng cấm có diện tích bằng 0 (các đỉnh thẳng hàng)")
		default:
			usable = append(usable, k)
		}
	}
	for _, k := range usable {
		for _, p := range m.Points {
			if pointInPolygon(Pt{p.X, p.Y}, k.Poly) {
				add(p.ID, fmt.Sprintf("điểm nằm trong vùng cấm %s", k.ID))
			}
		}
		for _, l := range m.Lanes {
			poly := m.Polyline(l)
			for i := 1; i < len(poly); i++ {
				if segmentEntersPolygon(poly[i-1], poly[i], k.Poly) {
					add(l.ID, fmt.Sprintf("làn cắt vùng cấm %s", k.ID))
					break
				}
			}
		}
	}
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

// Kết quả của Route: một đường nối do xe chở có chạy được trên bản đồ hay không.
const (
	RouteOK        = "ok"
	RouteNoStation = "no_station" // một đầu của đường nối chưa có trạm trên bản đồ: xe chạy theo thời gian ước tính
	RouteNoPath    = "no_path"    // có trạm nhưng không có đường đi: xe chờ mãi
	RouteNoReturn  = "no_return"  // đi được mà không về được: xe kẹt sau chuyến đầu
)

// Route kiểm bản đồ có cho xe chạy đường nối srcKey → dstKey (đi và về) không. Một node nhiều trạm thì chỉ cần một cặp trạm đi-về được.
func (m *AgvMap) Route(srcKey, dstKey string) string {
	var src, dst []string
	for _, p := range m.Points {
		if p.Kind != "station" {
			continue
		}
		switch p.NodeKey {
		case srcKey:
			src = append(src, p.ID)
		case dstKey:
			dst = append(dst, p.ID)
		}
	}
	if len(src) == 0 || len(dst) == 0 {
		return RouteNoStation
	}
	out := map[string][]string{}
	for _, l := range m.Lanes {
		out[l.From] = append(out[l.From], l.To)
	}
	reach := func(from string) map[string]bool {
		seen := map[string]bool{from: true}
		stack := []string{from}
		for len(stack) > 0 {
			u := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			for _, v := range out[u] {
				if !seen[v] {
					seen[v] = true
					stack = append(stack, v)
				}
			}
		}
		return seen
	}
	forward, round := false, false
	for _, a := range src {
		fromA := reach(a)
		for _, b := range dst {
			if !fromA[b] {
				continue
			}
			forward = true
			if reach(b)[a] {
				round = true
			}
		}
	}
	switch {
	case !forward:
		return RouteNoPath
	case !round:
		return RouteNoReturn
	}
	return RouteOK
}
