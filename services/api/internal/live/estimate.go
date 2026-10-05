package live

import (
	"fmt"
	"sort"
)

// PlannedEdge là công thức tự tính được lập cho `moved` của một đường nối chưa có dữ liệu.
type PlannedEdge struct {
	Subject  string `json:"subject"`
	Signal   string `json:"signal"`
	Derive   Derive `json:"derive"`
	Note     string `json:"note"`
	Estimate bool   `json:"estimate"`
}

// SkippedEdge là đường nối không suy được vì không đầu nào có bộ đếm hay tồn kho để dựa vào.
type SkippedEdge struct {
	Subject string `json:"subject"`
	Signal  string `json:"signal"`
	Reason  string `json:"reason"`
}

// EdgePlan là kế hoạch tự tính cho mọi đường nối chưa có dữ liệu. Các công thức tham chiếu lẫn nhau (đường này trừ đường kia) nên
// phải lưu cùng lúc; Plan() sắp thứ tự tính.
type EdgePlan struct {
	Items   []PlannedEdge `json:"items"`
	Skipped []SkippedEdge `json:"skipped"`
}

// Độ tin cậy của phương trình, thấp là tốt hơn:
//
//	1: bộ đếm của máy (số lượt × đơn vị) hoặc số đã giao của đích; vùng đệm của máy nhỏ nên sai lệch nhỏ.
//	2: cân bằng kho (hàng vào − hàng ra = tồn tăng thêm); đúng tới phần hàng đang trên đường.
//	3: số đã nhập về của nguồn; gồm cả hàng còn nằm ở cửa nhận chưa chuyển đi nên thường lớn hơn số đã giao.
const (
	prioCounter = 1
	prioBalance = 2
	prioSource  = 3
)

// equation: Σ hệ số × moved(đường) = Base, với hệ số +1 (đường vào kho, hay mọi đường của phương trình bộ đếm) hoặc −1 (đường ra khỏi kho).
type equation struct {
	prio     int
	node     string
	material string
	edges    []Subject
	coef     map[string]int
	base     []Term  // vế phải: từ bộ đếm hoặc tồn kho
	baseC    float64 // vế phải: phần hằng (−tồn đầu kỳ)
	approx   bool    // cân bằng kho
	what     string  // mô tả vế phải, dùng trong ghi chú
	storage  string  // tên kho (cân bằng kho)
}

type planner struct {
	subj    map[string]Subject
	in, out map[[2]string][]Subject // (node, vật tư) → các đường nối
	enabled map[Ref]bool
	record  map[Ref]bool // có bản ghi ghép nối (kể cả đang tắt)
	items   map[string]*PlannedEdge
	order   []string
	eqs     []equation
}

// PlanEdges lập công thức tự tính `moved` cho mọi đường nối chưa có ghép nối, kể cả đường rẽ nhánh. Mỗi phương trình nối các đường
// của một node với bộ đếm hoặc tồn kho của node đó; khi một phương trình chỉ còn một ẩn thì giải ra, rồi lặp (bóc dần), ưu tiên
// phương trình tin cậy hơn. Khi mọi phương trình còn ≥ 2 ẩn, chia đều số còn lại cho các đường chưa biết (ước lượng) rồi bóc tiếp.
// Công thức chỉ dùng bộ đếm, tồn kho của hai node đầu cuối và `moved` của các đường chạm hai node đó, nên hợp luật liền kề.
func PlanEdges(subjects []Subject, bindings []Binding) EdgePlan {
	p := &planner{
		subj: map[string]Subject{}, in: map[[2]string][]Subject{}, out: map[[2]string][]Subject{},
		enabled: map[Ref]bool{}, record: map[Ref]bool{}, items: map[string]*PlannedEdge{},
	}
	for _, b := range bindings {
		p.record[Ref{b.Subject, b.Signal}] = true
		if b.Enabled {
			p.enabled[Ref{b.Subject, b.Signal}] = true
		}
	}
	var edges []Subject
	for _, s := range subjects {
		p.subj[s.Subject] = s
		if s.Kind == "edge" {
			edges = append(edges, s)
			p.in[[2]string{s.Dst, s.Material}] = append(p.in[[2]string{s.Dst, s.Material}], s)
			p.out[[2]string{s.Src, s.Material}] = append(p.out[[2]string{s.Src, s.Material}], s)
		}
	}
	p.buildEquations(subjects)
	for p.solveOne() || p.splitOne() {
	}
	plan := EdgePlan{Items: []PlannedEdge{}, Skipped: []SkippedEdge{}}
	for _, k := range p.order {
		plan.Items = append(plan.Items, *p.items[k])
	}
	for _, e := range edges {
		if p.plannable(e) && p.items[e.Subject] == nil {
			plan.Skipped = append(plan.Skipped, SkippedEdge{e.Subject, "moved", "Không đầu nào của đường nối này có bộ đếm hoặc tồn kho được ghép để suy ra lượng hàng đi trên đó. Ghép dữ liệu cho một trong hai node, hoặc ghép thẳng đường nối."})
		}
	}
	return plan
}

func (p *planner) plannable(e Subject) bool { return !p.record[Ref{e.Subject, "moved"}] }

func (p *planner) known(e Subject) bool {
	return p.enabled[Ref{e.Subject, "moved"}] || p.items[e.Subject] != nil
}

func (p *planner) buildEquations(subjects []Subject) {
	for _, n := range subjects {
		if n.Kind != "node" {
			continue
		}
		mats := map[string]bool{}
		for k := range p.in {
			if k[0] == n.Subject {
				mats[k[1]] = true
			}
		}
		for k := range p.out {
			if k[0] == n.Subject {
				mats[k[1]] = true
			}
		}
		var list []string
		for m := range mats {
			list = append(list, m)
		}
		sort.Strings(list)
		for _, m := range list {
			p.nodeEquations(n, m)
		}
	}
}

func (p *planner) add(e equation) {
	e.coef = map[string]int{}
	for _, ed := range e.edges {
		e.coef[ed.Subject] = 1
	}
	p.eqs = append(p.eqs, e)
}

func (p *planner) nodeEquations(n Subject, m string) {
	in, out := p.in[[2]string{n.Subject, m}], p.out[[2]string{n.Subject, m}]
	// Chỉ dùng tín hiệu đã ghép và có trong danh mục của node (kho chỉ có level của vật tư nó chứa), nếu không ValidateDerive sẽ từ chối.
	has := func(sig string) bool {
		if !p.enabled[Ref{n.Subject, sig}] {
			return false
		}
		for _, d := range n.Signals {
			if d.Name == sig {
				return true
			}
		}
		return false
	}
	switch n.Archetype {
	case "PROCESS":
		if q := n.InQty[m]; len(in) > 0 && q > 0 && has("count_in") {
			p.add(equation{prio: prioCounter, node: n.Subject, material: m, edges: in,
				base: []Term{{Subject: n.Subject, Signal: "count_in", Sign: 1, Factor: fac(q)}},
				what: fmt.Sprintf("số lượt %s đã nhận (count_in) × %s %s mỗi lượt", n.Name, qtyText(q), m)})
		}
		if q := n.OutQty[m]; len(out) > 0 && q > 0 && has("count_ok") {
			p.add(equation{prio: prioCounter, node: n.Subject, material: m, edges: out,
				base: []Term{{Subject: n.Subject, Signal: "count_ok", Sign: 1, Factor: fac(q)}},
				what: fmt.Sprintf("số lượt %s làm ra sản phẩm đạt (count_ok) × %s %s mỗi lượt", n.Name, qtyText(q), m)})
		} else if q := n.OutNGQty[m]; len(out) > 0 && q > 0 && has("count_ng") {
			p.add(equation{prio: prioCounter, node: n.Subject, material: m, edges: out,
				base: []Term{{Subject: n.Subject, Signal: "count_ng", Sign: 1, Factor: fac(q)}},
				what: fmt.Sprintf("số lượt %s làm ra sản phẩm lỗi (count_ng) × %s %s mỗi lượt", n.Name, qtyText(q), m)})
		}
	case "SINK":
		if len(in) > 0 && has("fulfilled") {
			p.add(equation{prio: prioCounter, node: n.Subject, material: m, edges: in,
				base: []Term{{Subject: n.Subject, Signal: "fulfilled", Sign: 1}},
				what: fmt.Sprintf("số đã giao của %s (fulfilled)", n.Name)})
		}
	case "SOURCE":
		if len(out) > 0 && has("arrived") {
			p.add(equation{prio: prioSource, node: n.Subject, material: m, edges: out,
				base: []Term{{Subject: n.Subject, Signal: "arrived", Sign: 1}},
				what: fmt.Sprintf("số đã nhập về của %s (arrived)", n.Name)})
		}
	case "STORAGE":
		lvl := "level:" + m
		if len(in)+len(out) > 0 && has(lvl) {
			eq := equation{prio: prioBalance, node: n.Subject, material: m, approx: true, storage: n.Name,
				base: []Term{{Subject: n.Subject, Signal: lvl, Sign: 1}}, baseC: -n.Initial[m]}
			eq.edges = append(append([]Subject{}, in...), out...)
			p.eqs = append(p.eqs, eq)
			c := &p.eqs[len(p.eqs)-1]
			c.coef = map[string]int{}
			for _, e := range in {
				c.coef[e.Subject] = 1
			}
			for _, e := range out {
				c.coef[e.Subject] = -1
			}
		}
	}
}

// unknown: các đường của phương trình chưa có moved (kể cả đường không lập được vì đã có ghép nối đang tắt).
func (p *planner) unknown(eq equation) []Subject {
	var u []Subject
	for _, e := range eq.edges {
		if !p.known(e) {
			u = append(u, e)
		}
	}
	return u
}

// solveOne giải một phương trình chỉ còn đúng một ẩn, thử theo thứ tự tin cậy; true nếu đã giải được một đường.
func (p *planner) solveOne() bool {
	for prio := prioCounter; prio <= prioSource; prio++ {
		for i := range p.eqs {
			eq := p.eqs[i]
			if eq.prio != prio {
				continue
			}
			u := p.unknown(eq)
			if len(u) != 1 || !p.plannable(u[0]) {
				continue
			}
			p.emitSingle(eq, u[0])
			return true
		}
	}
	return false
}

// term trả số hạng +/−moved của một đường đã biết.
func movedTerm(e Subject, sign int, factor float64) Term {
	return Term{Subject: e.Subject, Signal: "moved", Sign: sign, Factor: fac(factor)}
}

func (p *planner) knownApprox(eq equation, skip string) bool {
	for _, e := range eq.edges {
		if e.Subject != skip && p.items[e.Subject] != nil && p.items[e.Subject].Estimate {
			return true
		}
	}
	return false
}

func (p *planner) emitSingle(eq equation, t Subject) {
	ct := eq.coef[t.Subject]
	d := Derive{Kind: KindSum, Const: float64(ct) * eq.baseC}
	for _, b := range eq.base {
		d.Terms = append(d.Terms, Term{Subject: b.Subject, Signal: b.Signal, Sign: ct * b.Sign, Factor: b.Factor})
	}
	others := 0
	for _, e := range eq.edges {
		if e.Subject != t.Subject {
			d.Terms = append(d.Terms, movedTerm(e, -ct*eq.coef[e.Subject], 1))
			others++
		}
	}
	est := eq.approx || p.knownApprox(eq, t.Subject)
	d.Estimate = est
	var note string
	switch {
	case eq.approx && ct > 0:
		note = fmt.Sprintf("Ước lượng theo cân bằng kho: hàng vào %s (%s) = hàng đã ra khỏi kho + tồn kho tăng thêm so với tồn đầu kỳ.", eq.storage, eq.material)
	case eq.approx:
		note = fmt.Sprintf("Ước lượng theo cân bằng kho: hàng ra khỏi %s (%s) = hàng đã vào kho − tồn kho tăng thêm so với tồn đầu kỳ − hàng đã ra theo các đường khác.", eq.storage, eq.material)
	default:
		note = "Bằng " + eq.what
		if others > 0 {
			note += fmt.Sprintf(" trừ số đã chuyển trên %d đường nối còn lại cùng vật tư", others)
		}
		note += "."
	}
	p.put(t, d, note, est)
}

// splitOne: khi không phương trình nào còn đúng một ẩn, chọn phương trình bộ đếm có ít ẩn nhất (ưu tiên độ tin cậy cao) và chia đều
// phần còn lại cho các đường chưa biết của nó.
func (p *planner) splitOne() bool {
	best, bestN := -1, 0
	for i := range p.eqs {
		eq := p.eqs[i]
		if eq.approx {
			continue
		}
		u := p.unknown(eq)
		canPlan := false
		for _, e := range u {
			canPlan = canPlan || p.plannable(e)
		}
		if len(u) < 2 || !canPlan {
			continue
		}
		if best < 0 || eq.prio < p.eqs[best].prio || (eq.prio == p.eqs[best].prio && len(u) < bestN) {
			best, bestN = i, len(u)
		}
	}
	if best < 0 {
		return false
	}
	eq := p.eqs[best]
	u := p.unknown(eq)
	share := 1 / float64(len(u))
	var known []Subject // chốt trước khi lập: các đường vừa chia không được tính là đã biết của nhau
	for _, e := range eq.edges {
		if p.known(e) {
			known = append(known, e)
		}
	}
	for _, t := range u {
		if !p.plannable(t) {
			continue
		}
		d := Derive{Kind: KindSum, Estimate: true}
		for _, b := range eq.base {
			f := share
			if b.Factor != 0 {
				f = share * b.Factor
			}
			d.Terms = append(d.Terms, Term{Subject: b.Subject, Signal: b.Signal, Sign: b.Sign, Factor: fac(f)})
		}
		for _, e := range known {
			d.Terms = append(d.Terms, movedTerm(e, -1, share))
		}
		note := fmt.Sprintf("Ước lượng: chia đều %s cho %d đường nối chưa có dữ liệu.", eq.what, len(u))
		p.put(t, d, note, true)
	}
	return true
}

func (p *planner) put(t Subject, d Derive, note string, est bool) {
	p.items[t.Subject] = &PlannedEdge{Subject: t.Subject, Signal: "moved", Derive: d, Note: note, Estimate: est}
	p.order = append(p.order, t.Subject)
}
