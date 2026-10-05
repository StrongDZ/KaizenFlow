package live

import (
	"fmt"
	"time"
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

// Term là một số hạng của công thức cộng trừ. Sign là 1 hoặc -1; Factor là hệ số nhân (bỏ trống hoặc 0 nghĩa là 1), dùng để đổi
// giữa số lượt của máy (count_in, count_ok) và số đơn vị đã chuyển (moved) khi công thức mỗi lượt dùng nhiều hơn một đơn vị.
type Term struct {
	Subject string  `json:"subject"`
	Signal  string  `json:"signal"`
	Sign    int     `json:"sign"`
	Factor  float64 `json:"factor,omitempty"`
}

func (t Term) factor() float64 {
	if t.Factor == 0 {
		return 1
	}
	return t.Factor
}

// Derive là công thức tính một tín hiệu từ các tín hiệu khác.
type Derive struct {
	Kind       string  `json:"kind"`
	Const      float64 `json:"const,omitempty"`
	Terms      []Term  `json:"terms,omitempty"`
	Watch      *Ref    `json:"watch,omitempty"`
	IdleAfterS float64 `json:"idle_after_s,omitempty"`
	// Estimate đánh dấu công thức chỉ cho số ước lượng (chia đều, cân bằng kho) chứ không phải số đo; giao diện hiện nhãn "ước lượng".
	Estimate bool `json:"estimate,omitempty"`
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

// RelatedSubjects là những đối tượng mà tín hiệu tự tính của `subject` được phép lấy đầu vào từ đó: chính nó và những gì nối trực tiếp với nó.
// Node: các đường nối vào hoặc ra nó. Đường nối: hai node ở hai đầu, và mọi đường nối khác chạm một trong hai đầu đó (để trừ đi phần
// đã đi theo đường khác). Đối tượng không có trong sơ đồ chỉ có chính nó.
func RelatedSubjects(subjects []Subject, subject string) map[string]bool {
	out := map[string]bool{subject: true}
	var self *Subject
	for i := range subjects {
		if subjects[i].Subject == subject {
			self = &subjects[i]
			break
		}
	}
	if self == nil {
		return out
	}
	touches := func(e Subject, node string) bool { return e.Kind == "edge" && (e.Src == node || e.Dst == node) }
	if self.Kind == "edge" {
		out[self.Src], out[self.Dst] = true, true
		for _, s := range subjects {
			if touches(s, self.Src) || touches(s, self.Dst) {
				out[s.Subject] = true
			}
		}
		return out
	}
	for _, s := range subjects {
		if touches(s, subject) {
			out[s.Subject] = true
		}
	}
	return out
}

// ValidateDerive kiểm tra một công thức tự tính trước khi lưu. `final` là mọi ghép nối của mô hình sau khi lưu (có cả ghép nối đích);
// known cho biết một tín hiệu có nằm trong danh mục tín hiệu của sơ đồ không; related (từ RelatedSubjects) là các đối tượng được phép
// làm đầu vào, nil là không kiểm. Thông điệp bằng tiếng Việt, nói rõ sửa gì.
func ValidateDerive(target Ref, d Derive, final []Binding, known func(Ref) bool, related map[string]bool) error {
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
			if t.Factor < 0 {
				return fmt.Errorf("Hệ số nhân của %s/%s không được âm (dùng dấu trừ để trừ)", t.Subject, t.Signal)
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
		case related != nil && !related[in.Subject]:
			return fmt.Errorf("%s không nối trực tiếp với %s trong sơ đồ nên không dùng làm đầu vào được. Công thức chỉ lấy tín hiệu của chính nó và của các node, đường nối liền kề", in.Subject, target.Subject)
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

// Plan trả các ghép nối tự tính đang bật của một mô hình theo thứ tự tính được: đầu vào tính trước đầu ra.
// Nếu lỡ có vòng (ValidateDerive đã chặn), các ghép nối trong vòng vẫn được giữ ở cuối để không mất cái nào.
func Plan(bindings []Binding) []Binding {
	var derived []Binding
	byRef := map[Ref]int{}
	for _, b := range bindings {
		if b.Enabled && b.Mode == ModeDerived && b.Derive != nil {
			byRef[Ref{b.Subject, b.Signal}] = len(derived)
			derived = append(derived, b)
		}
	}
	waiting := make([]int, len(derived)) // số đầu vào còn chờ (chỉ tính đầu vào cũng là tự tính)
	users := make([][]int, len(derived))
	for i, b := range derived {
		for _, in := range b.Derive.Inputs() {
			if j, ok := byRef[in]; ok && j != i {
				waiting[i]++
				users[j] = append(users[j], i)
			}
		}
	}
	var out []Binding
	done := make([]bool, len(derived))
	var queue []int
	for i := range derived {
		if waiting[i] == 0 {
			queue = append(queue, i)
		}
	}
	for len(queue) > 0 {
		i := queue[0]
		queue = queue[1:]
		done[i] = true
		out = append(out, derived[i])
		for _, u := range users[i] {
			if waiting[u]--; waiting[u] == 0 {
				queue = append(queue, u)
			}
		}
	}
	for i := range derived {
		if !done[i] {
			out = append(out, derived[i])
		}
	}
	return out
}

// Eval tính một công thức từ giá trị hiện tại của các đầu vào. ok=false khi thiếu đầu vào (không phát số sai).
// sum: giờ của kết quả là giờ mới nhất của các đầu vào. activity: RUNNING nếu tín hiệu theo dõi đổi giá trị trong idle_after_s giây
// ảo gần nhất tính tới `now`, ngược lại IDLE; giờ của kết quả là `now`.
func Eval(d Derive, target Ref, read func(Ref) (SigVal, bool), now time.Time) (Reading, bool) {
	switch d.Kind {
	case KindSum:
		total := d.Const
		var ts time.Time
		for _, t := range d.Terms {
			v, ok := read(Ref{t.Subject, t.Signal})
			if !ok {
				return Reading{}, false
			}
			total += float64(t.Sign) * t.factor() * v.V
			if v.TS.After(ts) {
				ts = v.TS
			}
		}
		return Reading{Subject: target.Subject, Signal: target.Signal, TS: ts, Num: total}, true
	case KindActivity:
		if d.Watch == nil {
			return Reading{}, false
		}
		v, ok := read(*d.Watch)
		if !ok {
			return Reading{}, false
		}
		state := "IDLE"
		if !v.Changed.IsZero() && now.Sub(v.Changed) <= time.Duration(d.IdleAfterS*float64(time.Second)) {
			state = "RUNNING"
		}
		return Reading{Subject: target.Subject, Signal: target.Signal, TS: now, IsText: true, Text: state}, true
	}
	return Reading{}, false
}
