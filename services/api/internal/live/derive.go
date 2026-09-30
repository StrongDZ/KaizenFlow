package live

import (
	"fmt"
)

// Cách lấy giá trị của một ghép nối: từ trường của một nguồn, hoặc tự tính từ tín hiệu khác trong sơ đồ.
const (
	ModeSource  = "source"
	ModeDerived = "derived"
)

// Kiểu công thức tự tính. Chỉ có hai kiểu, chọn từ menu (không có ô gõ công thức): mọi trường hợp cần thiết đều rơi vào đây.
const (
	KindSum      = "sum"      // const + Σ dấu × (đối tượng, tín hiệu)
	KindActivity = "activity" // trạng thái: RUNNING nếu tín hiệu theo dõi tăng trong idle_after_s giây ảo gần nhất, ngược lại IDLE
)

// Ref trỏ tới một tín hiệu của một node hoặc edge.
type Ref struct {
	Subject string `json:"subject"`
	Signal  string `json:"signal"`
}

func (r Ref) String() string { return r.Subject + "/" + r.Signal }

// Term là một số hạng của công thức cộng trừ. Sign là 1 hoặc -1.
type Term struct {
	Subject string `json:"subject"`
	Signal  string `json:"signal"`
	Sign    int    `json:"sign"`
}

// Derive là công thức tính một tín hiệu từ các tín hiệu khác.
type Derive struct {
	Kind       string  `json:"kind"`
	Const      float64 `json:"const,omitempty"`
	Terms      []Term  `json:"terms,omitempty"`
	Watch      *Ref    `json:"watch,omitempty"`
	IdleAfterS float64 `json:"idle_after_s,omitempty"`
}

// Inputs trả các tín hiệu mà công thức đọc.
func (d Derive) Inputs() []Ref {
	switch d.Kind {
	case KindSum:
		out := make([]Ref, len(d.Terms))
		for i, t := range d.Terms {
			out[i] = Ref{t.Subject, t.Signal}
		}
		return out
	case KindActivity:
		if d.Watch != nil {
			return []Ref{*d.Watch}
		}
	}
	return nil
}

// numeric: tín hiệu dạng số (không phải trạng thái chữ, không phải vị trí xe).
func numeric(signal string) bool { return !IsTextSignal(signal) && signal != SignalFleet }

// ValidateDerive kiểm tra một công thức tự tính trước khi lưu. `final` là mọi ghép nối của mô hình sau khi lưu (có cả ghép nối đích);
// known cho biết một tín hiệu có nằm trong danh mục tín hiệu của sơ đồ không. Thông điệp bằng tiếng Việt, nói rõ sửa gì.
func ValidateDerive(target Ref, d Derive, final []Binding, known func(Ref) bool) error {
	switch d.Kind {
	case KindSum:
		if !numeric(target.Signal) {
			return fmt.Errorf("%s là tín hiệu dạng chữ hoặc vị trí xe nên không tính bằng phép cộng trừ. Dùng kiểu \"Trạng thái từ hoạt động\" cho trạng thái máy", target)
		}
		if len(d.Terms) == 0 {
			return fmt.Errorf("Công thức cần ít nhất một số hạng (một tín hiệu để cộng hoặc trừ)")
		}
		for _, t := range d.Terms {
			if t.Sign != 1 && t.Sign != -1 {
				return fmt.Errorf("Mỗi số hạng phải là cộng hoặc trừ")
			}
			if !numeric(t.Signal) {
				return fmt.Errorf("%s/%s không phải tín hiệu số nên không đưa vào phép cộng trừ được", t.Subject, t.Signal)
			}
		}
	case KindActivity:
		if target.Signal != "state" {
			return fmt.Errorf("Kiểu \"Trạng thái từ hoạt động\" chỉ dành cho tín hiệu trạng thái máy, không dùng cho %s", target)
		}
		if d.Watch == nil {
			return fmt.Errorf("Chọn tín hiệu để theo dõi hoạt động của máy")
		}
		if !numeric(d.Watch.Signal) {
			return fmt.Errorf("Tín hiệu theo dõi %s phải là tín hiệu số (bộ đếm)", d.Watch)
		}
		if d.IdleAfterS <= 0 {
			return fmt.Errorf("Cần số giây không thấy hoạt động thì coi là nghỉ (lớn hơn 0)")
		}
	default:
		return fmt.Errorf("Kiểu công thức '%s' không có. Chọn cộng trừ hoặc trạng thái từ hoạt động", d.Kind)
	}
	bound := map[Ref]bool{}
	deps := map[Ref][]Ref{}
	for _, b := range final {
		if !b.Enabled {
			continue
		}
		bound[Ref{b.Subject, b.Signal}] = true
		if b.Mode == ModeDerived && b.Derive != nil {
			deps[Ref{b.Subject, b.Signal}] = b.Derive.Inputs()
		}
	}
	deps[target] = d.Inputs()
	for _, in := range d.Inputs() {
		switch {
		case in == target:
			return fmt.Errorf("%s không thể tự tính từ chính nó", target)
		case !known(in):
			return fmt.Errorf("%s không có trong sơ đồ", in)
		case !bound[in]:
			return fmt.Errorf("%s chưa có nguồn hay công thức nên chưa dùng làm đầu vào được. Ghép nó trước", in)
		}
	}
	if path := cyclePath(target, deps); path != nil {
		return fmt.Errorf("Công thức tạo vòng phụ thuộc: %s", joinRefs(path))
	}
	return nil
}

// cyclePath trả đường đi quay về chính `target` qua các công thức, hoặc nil nếu không có vòng.
func cyclePath(target Ref, deps map[Ref][]Ref) []Ref {
	visiting := map[Ref]bool{}
	var walk func(cur Ref, path []Ref) []Ref
	walk = func(cur Ref, path []Ref) []Ref {
		for _, in := range deps[cur] {
			if in == target {
				return append(append([]Ref{}, path...), in)
			}
			if visiting[in] {
				continue
			}
			visiting[in] = true
			if p := walk(in, append(path, in)); p != nil {
				return p
			}
		}
		return nil
	}
	return walk(target, []Ref{target})
}

func joinRefs(rs []Ref) string {
	s := ""
	for i, r := range rs {
		if i > 0 {
			s += " → "
		}
		s += r.String()
	}
	return s
}
