package live

import (
	"fmt"
	"strconv"
	"strings"
)

// Subject là một node hoặc edge của sơ đồ cùng các tín hiệu chuẩn của nó. Các trường không gửi ra web là dữ kiện để gợi ý công thức tự tính.
type Subject struct {
	Subject   string      `json:"subject"`
	Kind      string      `json:"kind"`
	Name      string      `json:"name"`
	NodeType  string      `json:"node_type,omitempty"`
	Archetype string      `json:"archetype,omitempty"`
	Material  string      `json:"material,omitempty"`
	Mode      string      `json:"mode,omitempty"`
	Src       string      `json:"src,omitempty"`
	Dst       string      `json:"dst,omitempty"`
	Signals   []SignalDef `json:"signals"`

	Initial  map[string]float64 `json:"-"` // Kho: tồn ban đầu theo vật tư
	InQty    map[string]float64 `json:"-"` // Trạm: số đơn vị mỗi lượt dùng theo vật tư đầu vào
	OutQty   map[string]float64 `json:"-"` // Trạm: số đơn vị mỗi lượt làm ra theo vật tư đầu ra đạt
	OutNGQty map[string]float64 `json:"-"` // Trạm: số đơn vị mỗi lượt làm ra theo vật tư đầu ra lỗi (cổng NG)
	CycleS   float64            `json:"-"` // Trạm: chu kỳ trung bình (giây)
	Pool     string             `json:"-"` // Edge chạy bằng xe: đội xe
	Lot      float64            `json:"-"` // Edge chạy bằng xe: số đơn vị mỗi chuyến
}

// Suggestion là một công thức tự tính được gợi ý, kèm một câu giải thích bằng tiếng Việt.
type Suggestion struct {
	Derive Derive `json:"derive"`
	Note   string `json:"note"`
}

// SourceSample là một nguồn đã đăng ký cùng bản tin mẫu của nó.
type SourceSample struct {
	Source string
	Sample any
}

type Problem struct {
	Subject  string `json:"subject"`
	Signal   string `json:"signal"`
	Severity string `json:"severity"` // warning
	Message  string `json:"message"`
}

// Trạng thái của một tín hiệu trong báo cáo độ phủ.
const (
	StatusSource  = "source"  // có ghép nối lấy từ nguồn
	StatusDerived = "derived" // có ghép nối tự tính hợp lệ
	StatusMissing = "missing" // chưa có gì (hoặc ghép nối đang tắt)
	StatusBroken  = "broken"  // có ghép nối nhưng chắc chắn không chạy được
)

type SignalCoverage struct {
	Subject     string       `json:"subject"`
	Signal      string       `json:"signal"`
	Label       string       `json:"label"`
	Status      string       `json:"status"`
	Need        []string     `json:"need"`
	Reason      string       `json:"reason,omitempty"`
	Suggestions []Suggestion `json:"suggestions,omitempty"`
}

type Summary struct {
	Signals int `json:"signals"`
	Source  int `json:"source"`
	Derived int `json:"derived"`
	Missing int `json:"missing"`
	Broken  int `json:"broken"`
}

type Readiness struct {
	Feature string `json:"feature"`
	OK      bool   `json:"ok"`
	Missing []Ref  `json:"missing"`
}

type CoverageReport struct {
	Summary   Summary          `json:"summary"`
	Readiness []Readiness      `json:"readiness"`
	Signals   []SignalCoverage `json:"signals"`
	Problems  []Problem        `json:"problems"`
}

type CoverageInput struct {
	Subjects []Subject
	Bindings []Binding
	Sources  []SourceSample
}

// Những chức năng cần tín hiệu nào: live (sơ đồ chạy theo dữ liệu), dự báo từ live, hiệu chỉnh AGV, bản đồ xe.
var features = []string{"live", "forecast", "calibration", "map"}

func needOf(s Subject, signal string) []string {
	switch {
	case s.Kind == "edge" && signal == "moved":
		return []string{"live"} // hạt chảy lấy từ tốc độ tăng của moved; in_transit chỉ là nhãn phụ nên tuỳ chọn
	case s.Kind == "edge" && signal == "trip_s":
		return []string{"calibration"}
	case s.Archetype == "PROCESS" && signal == "state":
		return []string{"live"}
	case s.Archetype == "STORAGE" && strings.HasPrefix(signal, "level:"):
		return []string{"live", "forecast"}
	case s.Archetype == "RESOURCE_POOL" && signal == SignalFleet:
		return []string{"map"}
	}
	return nil
}

// AnalyzeCoverage cho biết với mỗi tín hiệu của sơ đồ: đã có nguồn, đã tự tính, chưa có gì, hay hỏng; chức năng nào đã đủ tín hiệu;
// và với tín hiệu chưa có thì có công thức tự tính nào gợi ý được.
func AnalyzeCoverage(in CoverageInput) CoverageReport {
	g := newSuggester(in.Subjects, in.Bindings)
	byRef := map[Ref]Binding{}
	for _, b := range in.Bindings {
		byRef[Ref{b.Subject, b.Signal}] = b
	}
	catalog := map[Ref]bool{}
	for _, s := range in.Subjects {
		for _, d := range s.Signals {
			catalog[Ref{s.Subject, d.Name}] = true
		}
	}
	known := func(r Ref) bool { return catalog[r] }
	var rep CoverageReport
	rep.Problems = []Problem{}
	for _, s := range in.Subjects {
		for _, d := range s.Signals {
			ref := Ref{s.Subject, d.Name}
			c := SignalCoverage{Subject: s.Subject, Signal: d.Name, Label: d.Label, Need: needOf(s, d.Name)}
			if c.Need == nil {
				c.Need = []string{}
			}
			b, has := byRef[ref]
			switch {
			case !has:
				c.Status = StatusMissing
				c.Suggestions = g.suggest(ref)
			case !b.Enabled:
				c.Status, c.Reason = StatusMissing, "Ghép nối này đang tắt."
				c.Suggestions = g.suggest(ref)
			case b.Mode == ModeDerived && b.Derive != nil:
				if err := ValidateDerive(ref, *b.Derive, in.Bindings, known, RelatedSubjects(in.Subjects, ref.Subject)); err != nil {
					c.Status, c.Reason = StatusBroken, err.Error()
				} else {
					c.Status = StatusDerived
				}
			default:
				c.Status, c.Reason = checkSourceBinding(b, in.Sources, &rep.Problems)
			}
			rep.Signals = append(rep.Signals, c)
		}
	}
	for _, c := range rep.Signals {
		rep.Summary.Signals++
		switch c.Status {
		case StatusSource:
			rep.Summary.Source++
		case StatusDerived:
			rep.Summary.Derived++
		case StatusMissing:
			rep.Summary.Missing++
		case StatusBroken:
			rep.Summary.Broken++
		}
	}
	rep.Readiness = readiness(rep.Signals)
	return rep
}

func readiness(signals []SignalCoverage) []Readiness {
	out := []Readiness{}
	for _, f := range features {
		r := Readiness{Feature: f, OK: true, Missing: []Ref{}}
		applies := false
		for _, c := range signals {
			for _, n := range c.Need {
				if n != f {
					continue
				}
				applies = true
				if c.Status != StatusSource && c.Status != StatusDerived {
					r.OK = false
					r.Missing = append(r.Missing, Ref{c.Subject, c.Signal})
				}
			}
		}
		if applies {
			out = append(out, r)
		}
	}
	return out
}

// checkSourceBinding kiểm một ghép nối lấy từ nguồn với bản tin mẫu đã biết của nguồn. Chỉ báo hỏng khi chắc chắn không chạy được
// (thiếu trường, sai kiểu). Nguồn chưa từng thấy vẫn tính là có nguồn, chỉ kèm cảnh báo, để không báo hỏng oan khi feed chưa chạy.
func checkSourceBinding(b Binding, sources []SourceSample, problems *[]Problem) (status, reason string) {
	warn := func(msg string) {
		*problems = append(*problems, Problem{Subject: b.Subject, Signal: b.Signal, Severity: "warning", Message: msg})
	}
	var sample any
	found := false
	for _, s := range sources {
		if s.Source == b.Source {
			sample, found = s.Sample, true
			break
		}
	}
	if !found {
		for _, s := range sources {
			if MatchSource(b.Source, s.Source) {
				sample, found = s.Sample, true
				break
			}
		}
	}
	if !found {
		warn(fmt.Sprintf("Nguồn '%s' chưa từng gửi bản tin nào (hoặc chưa được đăng ký). Kiểm tra tên nguồn hoặc thêm nguồn ở tab Nguồn dữ liệu.", b.Source))
		return StatusSource, ""
	}
	if sample == nil || b.Signal == SignalFleet {
		return StatusSource, ""
	}
	raw, ok := Extract(sample, b.JSONPath)
	if !ok {
		return StatusBroken, fmt.Sprintf("Bản tin mẫu của nguồn '%s' không có trường '%s'. Chọn lại trường trong bản tin.", b.Source, b.JSONPath)
	}
	if IsTextSignal(b.Signal) {
		if len(b.Transform.Enum) > 0 {
			_, byRaw := b.Transform.Enum[fmt.Sprint(raw)]
			_, byUpper := b.Transform.Enum[strings.ToUpper(fmt.Sprint(raw))]
			if !byRaw && !byUpper {
				warn(fmt.Sprintf("Giá trị '%v' chưa có trong bảng đổi trạng thái của ghép nối này: khi nhận sẽ báo lỗi. Thêm dòng cho '%v' ở bảng đổi trạng thái.", raw, raw))
			}
		}
		return StatusSource, ""
	}
	if _, ok := toFloat(raw); !ok {
		return StatusBroken, fmt.Sprintf("Giá trị '%v' ở trường '%s' không phải số nên không dùng cho tín hiệu số này.", raw, b.JSONPath)
	}
	return StatusSource, ""
}

// ---- gợi ý công thức tự tính ----

type suggester struct {
	subj     map[string]Subject
	inEdges  map[string][]Subject
	outEdges map[string][]Subject
	bound    map[Ref]bool
}

func newSuggester(subjects []Subject, bindings []Binding) *suggester {
	g := &suggester{subj: map[string]Subject{}, inEdges: map[string][]Subject{}, outEdges: map[string][]Subject{}, bound: map[Ref]bool{}}
	for _, s := range subjects {
		g.subj[s.Subject] = s
	}
	for _, s := range subjects {
		if s.Kind == "edge" {
			g.inEdges[s.Dst] = append(g.inEdges[s.Dst], s)
			g.outEdges[s.Src] = append(g.outEdges[s.Src], s)
		}
	}
	for _, b := range bindings {
		if b.Enabled {
			g.bound[Ref{b.Subject, b.Signal}] = true
		}
	}
	return g
}

// SuggestDerive gợi ý các công thức tự tính cho một tín hiệu chưa có nguồn, dựa vào cấu trúc sơ đồ. Chỉ gợi ý khi mọi đầu vào của
// công thức đã có ghép nối (nguồn hoặc tự tính); không bao giờ gợi ý thời gian chuyến (trip_s, dùng để so với mô hình) hay cảm biến.
func SuggestDerive(subjects []Subject, bindings []Binding, target Ref) []Suggestion {
	return newSuggester(subjects, bindings).suggest(target)
}

// fac: hệ số nhân để lưu; 1 được bỏ trống (nghĩa là 1).
func fac(q float64) float64 {
	if q == 0 || q == 1 {
		return 0
	}
	return q
}

func qtyText(q float64) string { return vnNum(q) }

func (g *suggester) has(subject, signal string) bool { return g.bound[Ref{subject, signal}] }

func withMaterial(list []Subject, mat string) []Subject {
	var out []Subject
	for _, e := range list {
		if e.Material == mat {
			out = append(out, e)
		}
	}
	return out
}

// movedTerms: một số hạng `moved` cho mỗi edge; ok=false nếu không có edge nào hoặc có edge chưa có moved.
func (g *suggester) movedTerms(edges []Subject, sign int, factor float64) ([]Term, bool) {
	if len(edges) == 0 {
		return nil, false
	}
	out := make([]Term, len(edges))
	for i, e := range edges {
		if !g.has(e.Subject, "moved") {
			return nil, false
		}
		out[i] = Term{Subject: e.Subject, Signal: "moved", Sign: sign, Factor: fac(factor)}
	}
	return out, true
}

func sumOf(note string, c float64, terms ...Term) []Suggestion {
	return []Suggestion{{Derive: Derive{Kind: KindSum, Const: c, Terms: terms}, Note: note}}
}

func (g *suggester) suggest(t Ref) []Suggestion {
	s, ok := g.subj[t.Subject]
	if !ok {
		return nil
	}
	if s.Kind == "edge" {
		switch t.Signal {
		case "moved":
			return g.edgeMoved(s)
		case "in_transit":
			return g.edgeInTransit(s)
		}
		return nil
	}
	switch s.Archetype {
	case "STORAGE":
		if mat, ok := strings.CutPrefix(t.Signal, "level:"); ok {
			return g.storageLevel(s, mat)
		}
	case "PROCESS":
		switch t.Signal {
		case "count_in":
			return g.processCountIn(s)
		case "count_ok":
			return g.processCountOk(s)
		case "state":
			return g.processState(s)
		}
	case "SOURCE":
		if t.Signal == "arrived" {
			if terms, ok := g.movedTerms(g.outEdges[s.Subject], 1, 1); ok {
				return sumOf(fmt.Sprintf("Tổng số đã chuyển đi trên các đường nối ra khỏi %s.", s.Name), 0, terms...)
			}
		}
	case "SINK":
		if t.Signal == "fulfilled" {
			if terms, ok := g.movedTerms(g.inEdges[s.Subject], 1, 1); ok {
				return sumOf(fmt.Sprintf("Tổng số đã chuyển tới %s trên các đường nối vào.", s.Name), 0, terms...)
			}
		}
	case "RESOURCE_POOL":
		if t.Signal == "busy" {
			return g.poolBusy(s)
		}
	}
	return nil
}

// siblings trả các edge khác cùng vật tư, cùng đầu (đầu ra của src hoặc đầu vào của dst) với edge e.
func siblings(list []Subject, e Subject) []Subject {
	var out []Subject
	for _, o := range list {
		if o.Subject != e.Subject && o.Material == e.Material {
			out = append(out, o)
		}
	}
	return out
}

// minusMoved: trừ số đã chuyển của các edge anh em; ok=false nếu có edge chưa có moved (không suy được).
func (g *suggester) minusMoved(others []Subject) ([]Term, bool) {
	out := make([]Term, 0, len(others))
	for _, o := range others {
		if !g.has(o.Subject, "moved") {
			return nil, false
		}
		out = append(out, Term{Subject: o.Subject, Signal: "moved", Sign: -1})
	}
	return out, true
}

// producer: phần bộ đếm của node phát ra hàng dành riêng cho edge này. Bộ đếm của nguồn hoặc trạm gộp mọi edge ra cùng vật tư,
// nên nếu có edge anh em thì trừ số đã chuyển trên chúng (cần các edge đó đã có moved).
func (g *suggester) producer(e Subject) ([]Term, string, bool) {
	src := g.subj[e.Src]
	others, ok := g.minusMoved(siblings(g.outEdges[e.Src], e))
	if !ok {
		return nil, "", false
	}
	var base Term
	var what string
	switch src.Archetype {
	case "PROCESS":
		q := src.OutQty[e.Material]
		if q <= 0 || !g.has(src.Subject, "count_ok") {
			return nil, "", false
		}
		base = Term{Subject: src.Subject, Signal: "count_ok", Sign: 1, Factor: fac(q)}
		what = fmt.Sprintf("số lượt %s làm ra sản phẩm đạt (count_ok) × %s %s mỗi lượt", src.Name, qtyText(q), e.Material)
	case "SOURCE":
		if !g.has(src.Subject, "arrived") {
			return nil, "", false
		}
		base = Term{Subject: src.Subject, Signal: "arrived", Sign: 1}
		what = fmt.Sprintf("số đã nhập về của %s (arrived)", src.Name)
	default:
		return nil, "", false
	}
	if len(others) > 0 {
		what += fmt.Sprintf(" trừ số đã chuyển trên %d đường nối còn lại cùng vật tư", len(others))
	}
	return append([]Term{base}, others...), what, true
}

// consumer: phần bộ đếm của node nhận hàng dành riêng cho edge này (trạm: số lượt × đơn vị mỗi lượt; đích: số đã giao),
// trừ số đã chuyển trên các edge vào khác cùng vật tư.
func (g *suggester) consumer(e Subject) ([]Term, string, bool) {
	dst := g.subj[e.Dst]
	others, ok := g.minusMoved(siblings(g.inEdges[e.Dst], e))
	if !ok {
		return nil, "", false
	}
	var base Term
	var what string
	switch dst.Archetype {
	case "PROCESS":
		q := dst.InQty[e.Material]
		if q <= 0 || !g.has(dst.Subject, "count_in") {
			return nil, "", false
		}
		base = Term{Subject: dst.Subject, Signal: "count_in", Sign: 1, Factor: fac(q)}
		what = fmt.Sprintf("số lượt %s đã nhận (count_in) × %s %s mỗi lượt", dst.Name, qtyText(q), e.Material)
	case "SINK":
		if !g.has(dst.Subject, "fulfilled") {
			return nil, "", false
		}
		base = Term{Subject: dst.Subject, Signal: "fulfilled", Sign: 1}
		what = fmt.Sprintf("số đã giao của %s (fulfilled)", dst.Name)
	default:
		return nil, "", false
	}
	if len(others) > 0 {
		what += fmt.Sprintf(" trừ số đã chuyển trên %d đường nối còn lại cùng vật tư", len(others))
	}
	return append([]Term{base}, others...), what, true
}

func (g *suggester) edgeMoved(e Subject) []Suggestion {
	var out []Suggestion
	if terms, what, ok := g.consumer(e); ok {
		out = append(out, sumOf("Bằng "+what+".", 0, terms...)...)
	}
	if terms, what, ok := g.producer(e); ok {
		out = append(out, sumOf("Bằng "+what+".", 0, terms...)...)
	}
	return out
}

func (g *suggester) edgeInTransit(e Subject) []Suggestion {
	// Chỉ khi edge là đường ra duy nhất của vật tư: nếu không, bộ đếm của node phát ra lẫn nhiều edge và không tách được phần đang đi trên đường này.
	if !g.has(e.Subject, "moved") || len(siblings(g.outEdges[e.Src], e)) > 0 {
		return nil
	}
	terms, what, ok := g.producer(e)
	if !ok {
		return nil
	}
	return sumOf(fmt.Sprintf("Số đã làm ra (%s) trừ số đã chuyển tới nơi (moved).", what), 0, append(terms, Term{Subject: e.Subject, Signal: "moved", Sign: -1})...)
}

func (g *suggester) storageLevel(s Subject, mat string) []Suggestion {
	in, ok1 := g.movedTerms(withMaterial(g.inEdges[s.Subject], mat), 1, 1)
	out, ok2 := g.movedTerms(withMaterial(g.outEdges[s.Subject], mat), -1, 1)
	hasIn, hasOut := len(withMaterial(g.inEdges[s.Subject], mat)) > 0, len(withMaterial(g.outEdges[s.Subject], mat)) > 0
	if !hasIn && !hasOut || (hasIn && !ok1) || (hasOut && !ok2) {
		return nil
	}
	initial := s.Initial[mat]
	note := fmt.Sprintf("Tồn đầu kỳ %s + số %s đã vào − số đã ra.", qtyText(initial), mat)
	if initial == 0 {
		note = fmt.Sprintf("Số %s đã vào − số đã ra, tính từ tồn đầu kỳ 0. Nếu %s đang có hàng lúc bắt đầu, sửa tồn đầu kỳ.", mat, s.Name)
	}
	return sumOf(note, initial, append(in, out...)...)
}

func (g *suggester) processCountIn(s Subject) []Suggestion {
	if len(s.InQty) != 1 {
		return nil
	}
	for mat, q := range s.InQty {
		if q <= 0 {
			return nil
		}
		if terms, ok := g.movedTerms(withMaterial(g.inEdges[s.Subject], mat), 1, 1/q); ok {
			return sumOf(fmt.Sprintf("Số %s đã chuyển tới %s chia cho %s mỗi lượt.", mat, s.Name, qtyText(q)), 0, terms...)
		}
	}
	return nil
}

func (g *suggester) processCountOk(s Subject) []Suggestion {
	if len(s.OutQty) != 1 {
		return nil
	}
	for mat, q := range s.OutQty {
		if q <= 0 {
			return nil
		}
		if terms, ok := g.movedTerms(withMaterial(g.outEdges[s.Subject], mat), 1, 1/q); ok {
			return sumOf(fmt.Sprintf("Số %s đã chuyển đi khỏi %s chia cho %s mỗi lượt.", mat, s.Name, qtyText(q)), 0, terms...)
		}
	}
	return nil
}

func (g *suggester) processState(s Subject) []Suggestion {
	watch := ""
	for _, sig := range []string{"count_in", "count_ok"} {
		if g.has(s.Subject, sig) {
			watch = sig
			break
		}
	}
	if watch == "" {
		return nil
	}
	idle := 2 * s.CycleS
	note := fmt.Sprintf("Đang chạy khi bộ đếm %s của %s còn tăng trong %s giây gần nhất (gấp đôi chu kỳ), ngược lại là nghỉ.", watch, s.Name, qtyText(idle))
	if s.CycleS <= 0 {
		idle = 60
		note = fmt.Sprintf("Đang chạy khi bộ đếm %s của %s còn tăng trong 60 giây gần nhất, ngược lại là nghỉ.", watch, s.Name)
	}
	return []Suggestion{{Derive: Derive{Kind: KindActivity, Watch: &Ref{s.Subject, watch}, IdleAfterS: idle}, Note: note}}
}

func (g *suggester) poolBusy(s Subject) []Suggestion {
	var terms []Term
	for _, e := range g.subj {
		if e.Kind != "edge" || e.Mode != "POOL" || e.Pool != s.Subject {
			continue
		}
		if !g.has(e.Subject, "in_transit") {
			return nil
		}
		lot := e.Lot
		if lot <= 0 {
			lot = 1
		}
		terms = append(terms, Term{Subject: e.Subject, Signal: "in_transit", Sign: 1, Factor: fac(1 / lot)})
	}
	if len(terms) == 0 {
		return nil
	}
	// thứ tự ổn định
	for i := 1; i < len(terms); i++ {
		for j := i; j > 0 && terms[j].Subject < terms[j-1].Subject; j-- {
			terms[j], terms[j-1] = terms[j-1], terms[j]
		}
	}
	return sumOf(fmt.Sprintf("Số đơn vị đang trên đường của các đường nối dùng %s, chia cho số đơn vị mỗi chuyến.", s.Name), 0, terms...)
}

func vnNum(f float64) string {
	return strings.Replace(strconv.FormatFloat(f, 'f', -1, 64), ".", ",", 1)
}

// offMapShare: quá tỷ lệ xe nằm ngoài đường này thì nhiều khả năng khung toạ độ của đội xe đang sai.
const offMapShare = 0.2

// OffMapProblem báo khi quá 20% số xe đang nhận được nằm ngoài mọi làn (xa hơn dung sai khớp), thường do khung toạ độ sai; nil nếu ổn.
func OffMapProblem(fleet map[string][]Vehicle) *Problem {
	total, off := 0, 0
	for _, vs := range fleet {
		for _, v := range vs {
			total++
			if v.Off {
				off++
			}
		}
	}
	if total == 0 || float64(off)/float64(total) <= offMapShare {
		return nil
	}
	return &Problem{Signal: SignalFleet, Severity: "warning", Message: fmt.Sprintf(
		"%d/%d xe nằm ngoài mọi làn (xa hơn %.1f m): kiểm tra khung toạ độ của đội xe ở trang Bản đồ AGV (dịch, góc xoay, tỉ lệ, lật trục Y).", off, total, MatchTolM)}
}
