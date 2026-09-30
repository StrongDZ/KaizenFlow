package validate

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"github.com/kaizenflow/api/internal/resolve"
	"github.com/kaizenflow/api/internal/store"
)

const (
	SevError   = "error"
	SevWarning = "warning"
)

// Inferred là một thông số node/edge không tự đặt nhưng có giá trị thay thế, để người dùng biết hệ thống sẽ dùng gì.
// Source: node_type_default (mặc định của loại node), sim_default (mặc định ngầm của mô phỏng), agv_map (gợi ý từ bản đồ AGV).
type Inferred struct {
	Key     string `json:"key"`
	Param   string `json:"param"`
	Value   string `json:"value"`
	Source  string `json:"source"`
	Message string `json:"message"`
}

// Report là kết quả kiểm tra một sơ đồ. OK là không có lỗi mức error; cảnh báo không làm OK=false.
type Report struct {
	OK       bool       `json:"ok"`
	Issues   []Issue    `json:"issues"`
	Inferred []Inferred `json:"inferred"`
}

// CheckInput gồm sơ đồ cần kiểm tra và những gì luật cần biết thêm.
// Materials nil nghĩa là không biết Thư viện vật tư nên bỏ qua luật mã vật tư; MapTravel nil nghĩa là không có bản đồ AGV.
type CheckInput struct {
	Graph     *store.Graph
	Types     map[string]store.NodeType
	Materials []string
	MapTravel func(src, dst string) (seconds float64, ok bool)
}

type checker struct {
	v      *Validator
	in     CheckInput
	out    []Issue
	inf    []Inferred
	arche  map[string]string
	merged map[string]map[string]any
	own    map[string]map[string]any // tham số riêng của node, chưa trộn mặc định của loại
	defs   map[string]map[string]any // mặc định của loại node
	label  map[string]string
	known  map[string]bool

	supplied map[string]bool // "node|vật tư" đã có đường nối cấp tới
}

func (c *checker) add(sev, code, key, format string, a ...any) {
	c.out = append(c.out, Issue{Key: key, Message: fmt.Sprintf(format, a...), Severity: sev, Code: code})
}
func (c *checker) errf(code, key, format string, a ...any) { c.add(SevError, code, key, format, a...) }
func (c *checker) warnf(code, key, format string, a ...any) {
	c.add(SevWarning, code, key, format, a...)
}

// Check chạy toàn bộ luật kiểm tra sơ đồ (spec 2026-10-01 §3.3). Luật chỉ nằm ở đây; web chỉ hiển thị kết quả.
func (v *Validator) Check(in CheckInput) Report {
	c := &checker{v: v, in: in, arche: map[string]string{}, merged: map[string]map[string]any{},
		own: map[string]map[string]any{}, defs: map[string]map[string]any{}, label: map[string]string{}}
	if in.Materials != nil {
		c.known = make(map[string]bool, len(in.Materials))
		for _, m := range in.Materials {
			c.known[m] = true
		}
	}
	c.run()
	sort.SliceStable(c.out, func(i, j int) bool {
		a, b := c.out[i], c.out[j]
		if a.Severity != b.Severity {
			return a.Severity == SevError
		}
		if a.Key != b.Key {
			return a.Key < b.Key
		}
		return a.Code < b.Code
	})
	sort.SliceStable(c.inf, func(i, j int) bool {
		if c.inf[i].Key != c.inf[j].Key {
			return c.inf[i].Key < c.inf[j].Key
		}
		return c.inf[i].Param < c.inf[j].Param
	})
	r := Report{OK: true, Issues: c.out, Inferred: c.inf}
	if r.Issues == nil {
		r.Issues = []Issue{}
	}
	if r.Inferred == nil {
		r.Inferred = []Inferred{}
	}
	for _, i := range r.Issues {
		if i.Severity == SevError {
			r.OK = false
		}
	}
	return r
}

func (c *checker) run() {
	g := c.in.Graph
	sources, sinks := 0, 0
	for _, n := range g.Nodes {
		t, ok := c.in.Types[n.NodeType]
		if !ok {
			c.errf("unknown_type", n.Key, "Loại node '%s' không còn trong Thư viện. Chọn loại khác hoặc tạo lại loại này.", n.NodeType)
			continue
		}
		c.arche[n.Key] = t.Archetype
		name := n.Name
		if name == "" {
			name = t.Name
		}
		c.label[n.Key] = nodeLabel(name, n.Key)
		p, err := resolve.MergeNodeParams(t, n)
		if err != nil {
			c.errf("params_merge", n.Key, "%s: không đọc được tham số (%v).", c.label[n.Key], err)
			continue
		}
		c.merged[n.Key] = p
		c.own[n.Key] = n.Params
		if d, err := resolve.MergeNodeParams(t, store.GraphNode{Key: n.Key, NodeType: n.NodeType}); err == nil {
			c.defs[n.Key] = d
		}
		if s, err := c.v.schema(t); err != nil {
			c.errf("params_schema", n.Key, "%s: schema của loại node hỏng (%v).", c.label[n.Key], err)
		} else if err := s.Validate(p); err != nil {
			c.errf("params_schema", n.Key, "%s: tham số chưa hợp lệ, %s.", c.label[n.Key], firstLine(err))
		}
		switch t.Archetype {
		case "SOURCE":
			sources++
		case "SINK":
			sinks++
		}
	}
	if sources == 0 {
		c.errf("no_source", "model", "Sơ đồ chưa có node Nguồn nào. Thêm một node Nguồn để hàng có chỗ bắt đầu.")
	}
	if sinks == 0 {
		c.errf("no_sink", "model", "Sơ đồ chưa có node Đích nào. Thêm một node Đích để hàng có chỗ kết thúc.")
	}
	c.materials()
	c.edges()
	c.processInputs()
	c.warnings()
	c.inferred()
}

func nodeLabel(name, key string) string {
	if name == "" || name == key {
		return key
	}
	return fmt.Sprintf("%s (%s)", name, key)
}

func (c *checker) nodeName(key string) string {
	if l, ok := c.label[key]; ok {
		return l
	}
	return key
}

// materials: mọi mã vật tư (trong edge và trong tham số node, kể cả mặc định của loại) phải có trong Thư viện.
func (c *checker) materials() {
	if c.known == nil {
		return
	}
	for _, n := range c.in.Graph.Nodes {
		seen := map[string]bool{}
		for _, code := range materialCodes(c.merged[n.Key]) {
			if seen[code] || c.known[code] {
				continue
			}
			seen[code] = true
			c.errf("material_unknown", n.Key, "%s: %s", c.nodeName(n.Key), c.unknownMaterial(code))
		}
	}
	for _, e := range c.in.Graph.Edges {
		if e.Material != "" && !c.known[e.Material] {
			c.errf("material_unknown", e.Key, "Đường nối %s: %s", c.edgeName(e), c.unknownMaterial(e.Material))
		}
	}
}

func (c *checker) unknownMaterial(code string) string {
	msg := fmt.Sprintf("vật tư '%s' chưa có trong Thư viện.", code)
	if near := closestMaterial(code, c.in.Materials); near != "" {
		return fmt.Sprintf("%s Có phải ý bạn là '%s'?", msg, near)
	}
	return msg + " Tạo vật tư này ở Thư viện hoặc chọn vật tư khác."
}

func (c *checker) edgeName(e store.GraphEdge) string {
	return fmt.Sprintf("%s → %s", c.nodeName(e.Src), c.nodeName(e.Dst))
}

func (c *checker) edges() {
	g := c.in.Graph
	supplied := map[string]bool{}
	adj := map[string][]string{}
	dup := map[string]bool{}
	for _, e := range g.Edges {
		if _, ok := c.arche[e.Src]; !ok {
			if !c.nodeExists(e.Src) {
				c.errf("edge_dangling", e.Key, "Đường nối %s trỏ tới node '%s' không còn trong sơ đồ.", e.Key, e.Src)
			}
			continue
		}
		if _, ok := c.arche[e.Dst]; !ok {
			if !c.nodeExists(e.Dst) {
				c.errf("edge_dangling", e.Key, "Đường nối %s trỏ tới node '%s' không còn trong sơ đồ.", e.Key, e.Dst)
			}
			continue
		}
		if c.arche[e.Src] == "RESOURCE_POOL" || c.arche[e.Dst] == "RESOURCE_POOL" {
			c.errf("edge_pool_node", e.Key, "Đội xe / người không nối bằng đường nối. Gán đội xe trong thuộc tính của đường nối (Cách vận chuyển: bằng xe).")
			continue
		}
		if e.Src == e.Dst {
			c.errf("edge_self", e.Key, "Đường nối %s nối node với chính nó.", e.Key)
			continue
		}
		if e.Material == "" {
			c.errf("edge_no_material", e.Key, "Đường nối %s chưa chọn vật tư.", c.edgeName(e))
		}
		id := e.Src + "\x00" + e.Dst + "\x00" + e.Material
		if dup[id] {
			c.errf("edge_duplicate", e.Key, "Có hai đường nối cùng chuyển %s từ %s sang %s. Giữ một đường thôi.", e.Material, c.nodeName(e.Src), c.nodeName(e.Dst))
		}
		dup[id] = true
		supplied[e.Dst+"|"+e.Material] = true
		if mode, _ := e.Params["mode"].(string); mode == "POOL" {
			pk, _ := e.Params["pool"].(string)
			if c.arche[pk] != "RESOURCE_POOL" {
				if pk == "" {
					c.errf("pool_invalid", e.Key, "Đường nối %s chạy bằng xe nhưng chưa chọn đội xe.", c.edgeName(e))
				} else {
					c.errf("pool_invalid", e.Key, "Đường nối %s chạy bằng xe nhưng '%s' không phải node đội xe trong sơ đồ.", c.edgeName(e), pk)
				}
			}
		}
		if hk, ok := e.Params["hook_pool"].(string); ok && hk != "" {
			if c.arche[hk] != "RESOURCE_POOL" || c.merged[hk]["kind"] != "OPERATOR" {
				c.errf("hook_invalid", e.Key, "Người móc kéo '%s' của đường nối %s phải là node Đội xe / người loại Người vận hành.", hk, c.edgeName(e))
			}
		}
		if c.arche[e.Src] != "STORAGE" && c.arche[e.Dst] != "STORAGE" {
			adj[e.Src] = append(adj[e.Src], e.Dst)
		}
	}
	c.supplied = supplied
	if k := findCycle(g.Nodes, adj); k != "" {
		c.errf("cycle_no_storage", k, "Có vòng khép kín quanh %s mà không có Kho nào trong vòng. Thêm một Kho vào vòng để hàng không quay mãi.", c.nodeName(k))
	}
}

func (c *checker) nodeExists(key string) bool {
	for _, n := range c.in.Graph.Nodes {
		if n.Key == key {
			return true
		}
	}
	return false
}

func (c *checker) processInputs() {
	for _, n := range c.in.Graph.Nodes {
		if c.arche[n.Key] != "PROCESS" {
			continue
		}
		r0 := firstRecipe(c.merged[n.Key])
		for _, m := range lineMaterials(r0["inputs"]) {
			if !c.supplied[n.Key+"|"+m] {
				c.errf("input_unsupplied", n.Key, "%s cần vật tư %s nhưng chưa có đường nối nào mang %s tới.", c.nodeName(n.Key), m, m)
			}
		}
	}
}

func (c *checker) warnings() {
	g := c.in.Graph
	degree := map[string]int{}
	out := map[string]map[string]bool{} // node -> vật tư đi ra
	poolUsed := map[string]bool{}
	for _, e := range g.Edges {
		degree[e.Src]++
		degree[e.Dst]++
		if out[e.Src] == nil {
			out[e.Src] = map[string]bool{}
		}
		out[e.Src][e.Material] = true
		if pk, _ := e.Params["pool"].(string); pk != "" {
			poolUsed[pk] = true
		}
		if hk, _ := e.Params["hook_pool"].(string); hk != "" {
			poolUsed[hk] = true
		}
	}
	for _, n := range g.Nodes {
		a, ok := c.arche[n.Key]
		if !ok {
			continue
		}
		name := c.nodeName(n.Key)
		switch a {
		case "RESOURCE_POOL":
			if !poolUsed[n.Key] {
				c.warnf("pool_unused", n.Key, "%s chưa được đường nối nào dùng. Chọn nó ở Cách vận chuyển của một đường nối.", name)
			}
			continue
		case "STORAGE":
			if len(listOf(c.merged[n.Key]["stock"])) == 0 {
				c.warnf("storage_no_stock", n.Key, "%s chưa khai báo vật tư nào: không theo dõi được tồn kho và không ghép được tín hiệu Tồn.", name)
			}
		case "SINK":
			if len(listOf(c.merged[n.Key]["demand"])) == 0 {
				c.warnf("sink_no_demand", n.Key, "%s chưa có nhu cầu nào nên không đo được việc giao hàng.", name)
			}
		case "PROCESS":
			r0 := firstRecipe(c.merged[n.Key])
			for _, o := range listOf(r0["outputs"]) {
				m, _ := o.(map[string]any)
				code, _ := m["material"].(string)
				if port, _ := m["port"].(string); port == "NG" || code == "" {
					continue
				}
				if !out[n.Key][code] {
					c.warnf("output_dead_end", n.Key, "%s làm ra %s (đạt) nhưng chưa có đường nối nào đưa %s đi tiếp.", name, code, code)
				}
			}
		}
		if degree[n.Key] == 0 {
			c.warnf("node_isolated", n.Key, "%s chưa nối với node nào.", name)
		}
	}
	for _, e := range g.Edges {
		if _, ok := c.arche[e.Src]; !ok {
			continue
		}
		if _, ok := c.arche[e.Dst]; !ok || e.Material == "" || c.arche[e.Dst] == "RESOURCE_POOL" {
			continue
		}
		c.materialUnused(e)
	}
}

// materialUnused: đường nối chở vật tư mà node đích không dùng tới.
func (c *checker) materialUnused(e store.GraphEdge) {
	p := c.merged[e.Dst]
	switch c.arche[e.Dst] {
	case "PROCESS":
		used := map[string]bool{}
		for _, r := range listOf(p["recipes"]) {
			rm, _ := r.(map[string]any)
			for _, m := range lineMaterials(rm["inputs"]) {
				used[m] = true
			}
		}
		if len(used) > 0 && !used[e.Material] {
			c.warnf("material_unused", e.Key, "Đường nối %s chở %s nhưng công thức của %s không dùng vật tư này.", c.edgeName(e), e.Material, c.nodeName(e.Dst))
		}
	case "STORAGE":
		stock := listOf(p["stock"])
		if len(stock) > 0 && !listHasMaterial(stock, e.Material) {
			c.warnf("material_unused", e.Key, "Đường nối %s chở %s nhưng %s chưa khai báo tồn cho vật tư này.", c.edgeName(e), e.Material, c.nodeName(e.Dst))
		}
	case "SINK":
		demand := listOf(p["demand"])
		if len(demand) > 0 && !listHasMaterial(demand, e.Material) {
			c.warnf("material_unused", e.Key, "Đường nối %s chở %s nhưng %s chưa có nhu cầu cho vật tư này.", c.edgeName(e), e.Material, c.nodeName(e.Dst))
		}
	}
}

// inferred: thông số không đặt ở node nhưng có giá trị thay thế (mặc định của loại node, hoặc mặc định ngầm của mô phỏng).
func (c *checker) inferred() {
	for _, n := range c.in.Graph.Nodes {
		a, ok := c.arche[n.Key]
		if !ok {
			continue
		}
		name := c.nodeName(n.Key)
		switch a {
		case "PROCESS":
			c.inferOne(n.Key, name, "cycle", "chu kỳ", "1 giây", distText, func() {
				c.warnf("cycle_unset", n.Key, "%s chưa đặt chu kỳ (kể cả ở loại node): mô phỏng sẽ dùng 1 giây.", name)
			})
			c.inferOne(n.Key, name, "slots", "số vị trí chạy song song", "1", countText, nil)
		case "STORAGE":
			c.inferOne(n.Key, name, "capacity", "sức chứa tổng", "không giới hạn", countText, nil)
		}
	}
	for _, e := range c.in.Graph.Edges {
		if _, ok := c.arche[e.Src]; !ok {
			continue
		}
		if mode, _ := e.Params["mode"].(string); mode != "POOL" || e.Params["travel"] != nil {
			continue
		}
		if secs, ok := c.mapTravel(e.Src, e.Dst); ok {
			c.warnf("travel_unset", e.Key, "Đường nối %s chạy bằng xe nhưng chưa đặt thời gian đi: mô phỏng coi xe đến ngay (0 giây). Bản đồ AGV cho khoảng %s.", c.edgeName(e), secText(secs))
			c.inf = append(c.inf, Inferred{Key: e.Key, Param: "travel", Value: "≈ " + secText(secs), Source: "agv_map",
				Message: fmt.Sprintf("Chưa đặt thời gian đi. Bản đồ AGV cho khoảng %s; đặt số này để mô phỏng khớp bản đồ.", secText(secs))})
			continue
		}
		c.warnf("travel_unset", e.Key, "Đường nối %s chạy bằng xe nhưng chưa đặt thời gian đi: mô phỏng coi xe đến ngay (0 giây).", c.edgeName(e))
	}
}

func (c *checker) mapTravel(src, dst string) (float64, bool) {
	if c.in.MapTravel == nil {
		return 0, false
	}
	return c.in.MapTravel(src, dst)
}

// inferOne: node tự đặt thì bỏ qua; loại node có mặc định thì báo giá trị đó; cả hai đều không có thì báo mặc định ngầm của sim.
func (c *checker) inferOne(key, name, param, vi, simDefault string, show func(any) string, whenMissing func()) {
	if _, ok := c.own[key][param]; ok {
		return
	}
	if d, ok := c.defs[key][param]; ok && d != nil {
		val := show(d)
		c.inf = append(c.inf, Inferred{Key: key, Param: param, Value: val, Source: "node_type_default",
			Message: fmt.Sprintf("%s chưa đặt riêng %s: dùng mặc định của loại node (%s).", name, vi, val)})
		return
	}
	c.inf = append(c.inf, Inferred{Key: key, Param: param, Value: simDefault, Source: "sim_default",
		Message: fmt.Sprintf("%s chưa đặt %s: mô phỏng dùng %s.", name, vi, simDefault)})
	if whenMissing != nil {
		whenMissing()
	}
}

// ---- hàm phụ ----

func listOf(v any) []any {
	l, _ := v.([]any)
	return l
}

func firstRecipe(p map[string]any) map[string]any {
	recipes := listOf(p["recipes"])
	if len(recipes) == 0 {
		return nil
	}
	r, _ := recipes[0].(map[string]any)
	return r
}

func lineMaterials(v any) []string {
	var out []string
	for _, raw := range listOf(v) {
		m, _ := raw.(map[string]any)
		if code, _ := m["material"].(string); code != "" {
			out = append(out, code)
		}
	}
	return out
}

func listHasMaterial(list []any, code string) bool {
	for _, raw := range list {
		m, _ := raw.(map[string]any)
		if c, _ := m["material"].(string); c == code {
			return true
		}
	}
	return false
}

// materialCodes gom mọi giá trị của khoá "material" trong một cây tham số, theo thứ tự ổn định.
func materialCodes(v any) []string {
	var out []string
	var walk func(any)
	walk = func(x any) {
		switch t := x.(type) {
		case map[string]any:
			keys := make([]string, 0, len(t))
			for k := range t {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				if s, ok := t[k].(string); ok && k == "material" && s != "" {
					out = append(out, s)
				} else {
					walk(t[k])
				}
			}
		case []any:
			for _, e := range t {
				walk(e)
			}
		}
	}
	walk(v)
	return out
}

func normCode(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// closestMaterial gợi ý mã vật tư trong Thư viện giống nhất với mã gõ sai: trùng khi bỏ dấu gạch và hoa thường, hoặc cách tối đa 2 ký tự.
func closestMaterial(code string, lib []string) string {
	n := normCode(code)
	best, bestD := "", 3
	for _, m := range lib {
		lm := normCode(m)
		if lm == n {
			return m
		}
		if d := levenshtein(n, lm); d < bestD {
			best, bestD = m, d
		}
	}
	if len(n) < 3 {
		return ""
	}
	return best
}

func levenshtein(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	prev := make([]int, len(rb)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(ra); i++ {
		cur := make([]int, len(rb)+1)
		cur[0] = i
		for j := 1; j <= len(rb); j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev = cur
	}
	return prev[len(rb)]
}

func num(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	}
	return 0, false
}

func secText(s float64) string {
	if s >= 120 {
		return vnNum(math.Round(s/6)/10) + " phút"
	}
	return vnNum(math.Round(s*10)/10) + " giây"
}

func vnNum(f float64) string {
	return strings.Replace(strconv.FormatFloat(f, 'f', -1, 64), ".", ",", 1)
}

// countText hiển thị một số đếm (sức chứa, số vị trí), không có đơn vị thời gian.
func countText(v any) string {
	if f, ok := num(v); ok {
		return vnNum(f)
	}
	return "theo loại node"
}

// distText mô tả ngắn một giá trị thời gian: số, hoặc phân phối xác suất.
func distText(v any) string {
	if f, ok := num(v); ok {
		return secText(f)
	}
	m, ok := v.(map[string]any)
	if !ok {
		return "theo loại node"
	}
	mean := func() (float64, bool) {
		if f, ok := num(m["mean"]); ok {
			return f, true
		}
		return num(m["mean_s"])
	}
	switch m["dist"] {
	case "const":
		if f, ok := num(m["value"]); ok {
			return secText(f)
		}
	case "lognorm", "exp", "norm", "normal":
		if f, ok := mean(); ok {
			return "trung bình " + secText(f)
		}
	case "tri":
		if lo, ok := num(m["min"]); ok {
			if hi, ok := num(m["max"]); ok {
				return "từ " + secText(lo) + " đến " + secText(hi)
			}
		}
	}
	return "theo loại node"
}
