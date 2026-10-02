package live

import (
	"math"
	"sort"
	"strings"
	"sync"
	"time"
)

// Sample là một điểm (thời điểm ảo, giá trị) trong lịch sử ngắn của tín hiệu.
type Sample struct {
	TS time.Time
	V  float64
}

const (
	// NoUseCoverage: quy ước của sim khi kho không bị lấy hàng.
	NoUseCoverage = 999.0
	// CoverageWindowS: cửa sổ tính tốc độ tiêu thụ, cùng giá trị mặc định với sim (`coverage_window_s`).
	CoverageWindowS   = 3600.0
	recentRateWindowS = 6 * 3600.0
	minCoverageSpanS  = 300.0
	histMinGapS       = 5.0
	histCap           = 512
	rateSamples       = 5
	maxSources        = 2000
	// sessionBackstep: giờ ảo của bản tin mới lùi quá chừng này so với giờ ảo đang giữ thì đó là phiên feed mới (feed bắt đầu lại),
	// không phải bản tin đến trễ.
	sessionBackstep = 10 * time.Minute
)

// Coverage = tồn hiện tại ÷ tốc độ giảm trong cửa sổ. Chỉ tính các lần giảm (nạp thêm không phải tiêu thụ), giống sim.
// Cần đủ lịch sử (≥5 phút); không giảm thì trả NoUseCoverage.
func Coverage(hist []Sample, windowS float64) (float64, bool) {
	if len(hist) < 2 {
		return 0, false
	}
	last := hist[len(hist)-1]
	from := last.TS.Add(-time.Duration(windowS * float64(time.Second)))
	i := 0
	for i < len(hist)-1 && hist[i].TS.Before(from) {
		i++
	}
	win := hist[i:]
	span := last.TS.Sub(win[0].TS).Seconds()
	if len(win) < 2 || span < minCoverageSpanS {
		return 0, false
	}
	drops := 0.0
	for k := 1; k < len(win); k++ {
		if d := win[k-1].V - win[k].V; d > 0 {
			drops += d
		}
	}
	if drops <= 0 {
		return NoUseCoverage, true
	}
	return last.V / (drops / (span / 3600.0)), true
}

type SigVal struct {
	V  float64   `json:"v"`
	TS time.Time `json:"ts"`
}

type subject struct {
	state    string
	stateTS  time.Time
	signals  map[string]SigVal
	hist     map[string][]Sample
	seenWall time.Time
}

type sourceInfo struct {
	source, desc string
	lastTS       time.Time
	seenWall     time.Time
	count        int64
	last         any
}

type modelState struct {
	now      time.Time
	subjects map[string]*subject
	fleet    map[string]map[string]Vehicle
}

// State là trạng thái live của mọi mô hình, an toàn khi nhiều goroutine dùng.
type State struct {
	mu      sync.RWMutex
	models  map[string]*modelState
	sources map[string]*sourceInfo
}

func NewState() *State {
	return &State{models: map[string]*modelState{}, sources: map[string]*sourceInfo{}}
}

func (s *State) model(key string) *modelState {
	m := s.models[key]
	if m == nil {
		m = &modelState{subjects: map[string]*subject{}, fleet: map[string]map[string]Vehicle{}}
		s.models[key] = m
	}
	return m
}

// NoteSource ghi nhận một nguồn đang phát (để UI liệt kê và gợi ý ghép), kể cả khi chưa có binding nào.
func (s *State) NoteSource(msg Message, wall time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	so := s.sources[msg.Source]
	if so == nil {
		if len(s.sources) >= maxSources {
			return
		}
		so = &sourceInfo{source: msg.Source}
		s.sources[msg.Source] = so
	}
	if msg.Desc != "" {
		so.desc = msg.Desc
	}
	so.lastTS, so.seenWall, so.last = msg.TS, wall, msg.Payload
	so.count++
}

// Apply cập nhật trạng thái theo các giá trị đã chuẩn hoá. Giá trị cũ hơn giá trị đang giữ thì bị bỏ.
func (s *State) Apply(model string, rs []Reading, wall time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.model(model)
	if newest := newestTS(rs); !m.now.IsZero() && m.now.Sub(newest) > sessionBackstep {
		// Feed bắt đầu lại với giờ ảo sớm hơn phiên trước (phiên trước có thể đã chạy ×600 vào tương lai): bỏ trạng thái cũ,
		// nếu không mọi bản tin mới đều bị coi là cũ hơn và giao diện đứng hình.
		delete(s.models, model)
		m = s.model(model)
	}
	for _, r := range rs {
		if r.TS.After(m.now) {
			m.now = r.TS
		}
		if r.Fleet != nil {
			pool := m.fleet[r.Subject]
			if pool == nil {
				pool = map[string]Vehicle{}
				m.fleet[r.Subject] = pool
			}
			v := *r.Fleet
			v.seen = wall
			pool[v.ID] = v
			continue
		}
		sub := m.subjects[r.Subject]
		if sub == nil {
			sub = &subject{signals: map[string]SigVal{}, hist: map[string][]Sample{}}
			m.subjects[r.Subject] = sub
		}
		sub.seenWall = wall
		if r.IsText {
			if !r.TS.Before(sub.stateTS) {
				sub.state, sub.stateTS = r.Text, r.TS
			}
			continue
		}
		if cur, ok := sub.signals[r.Signal]; ok && r.TS.Before(cur.TS) {
			continue
		}
		sub.signals[r.Signal] = SigVal{V: r.Num, TS: r.TS}
		sub.push(r.Signal, Sample{TS: r.TS, V: r.Num})
	}
}

func newestTS(rs []Reading) time.Time {
	var out time.Time
	for _, r := range rs {
		if r.TS.After(out) {
			out = r.TS
		}
	}
	return out
}

func (sub *subject) push(name string, sm Sample) {
	h := sub.hist[name]
	if n := len(h); n > 0 && sm.TS.Sub(h[n-1].TS).Seconds() < histMinGapS {
		return
	}
	h = append(h, sm)
	keepWindowS := math.Max(CoverageWindowS, recentRateWindowS)
	cut := sm.TS.Add(-time.Duration((keepWindowS + 60) * float64(time.Second)))
	i := 0
	for i < len(h)-1 && h[i].TS.Before(cut) {
		i++
	}
	h = h[i:]
	if len(h) > histCap {
		h = h[len(h)-histCap:]
	}
	sub.hist[name] = h
}

// Clear xoá trạng thái live của một mô hình (dùng khi đặt lại demo).
func (s *State) Clear(model string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.models, model)
}

// ClearSources xoá danh sách nguồn đã thấy.
func (s *State) ClearSources() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sources = map[string]*sourceInfo{}
}

func (s *State) historyLen(model, subj, signal string) int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if m := s.models[model]; m != nil {
		if sub := m.subjects[subj]; sub != nil {
			return len(sub.hist[signal])
		}
	}
	return 0
}

func rateFromHistory(hist []Sample, window time.Duration) (float64, int, float64, bool) {
	if len(hist) < 2 {
		return 0, len(hist), 0, false
	}
	last := hist[len(hist)-1]
	from := last.TS.Add(-window)
	i := 0
	for i < len(hist)-1 && hist[i].TS.Before(from) {
		i++
	}
	start := max(i, len(hist)-rateSamples)
	win := hist[start:]
	if len(win) < 2 {
		return 0, len(win), 0, false
	}
	spanH := last.TS.Sub(win[0].TS).Hours()
	if spanH <= 0 {
		return 0, len(win), 0, false
	}
	delta := last.V - win[0].V
	if delta < 0 {
		return 0, len(win), spanH, false
	}
	return delta / spanH, len(win), spanH, true
}

// SignalRate trả tốc độ tăng gần đây của một tín hiệu cộng dồn theo giờ, lấy trực tiếp từ history trong RAM.
func (s *State) SignalRate(model, subj, signal string, window time.Duration) (float64, int, float64, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if m := s.models[model]; m != nil {
		if sub := m.subjects[subj]; sub != nil {
			return rateFromHistory(sub.hist[signal], window)
		}
	}
	return 0, 0, 0, false
}

type SubjectSnap struct {
	State   string            `json:"state,omitempty"`
	StateTS *time.Time        `json:"state_ts,omitempty"`
	Signals map[string]SigVal `json:"signals"`
	AgeMS   int64             `json:"age_ms"`
	Rate    *float64          `json:"rate,omitempty"`
}

type SourceSnap struct {
	Source string    `json:"source"`
	Desc   string    `json:"desc"`
	LastTS time.Time `json:"last_ts"`
	AgeMS  int64     `json:"age_ms"`
	Count  int64     `json:"count"`
	Last   any       `json:"last"`
	Bound  bool      `json:"bound"`
}

type Snapshot struct {
	Model    string                 `json:"model"`
	Now      time.Time              `json:"now"`
	Subjects map[string]SubjectSnap `json:"subjects"`
	Fleet    map[string][]Vehicle   `json:"fleet"`
	Sources  []SourceSnap           `json:"sources"`
}

// Snapshot chụp trạng thái một mô hình. bindings (của mô hình đó) chỉ dùng để đánh dấu nguồn nào đã được ghép.
func (s *State) Snapshot(model string, wall time.Time, bindings []Binding) Snapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := Snapshot{Model: model, Subjects: map[string]SubjectSnap{}, Fleet: map[string][]Vehicle{}, Sources: []SourceSnap{}}
	if m := s.models[model]; m != nil {
		out.Now = m.now
		for key, sub := range m.subjects {
			ss := SubjectSnap{State: sub.state, Signals: make(map[string]SigVal, len(sub.signals)+1), AgeMS: wall.Sub(sub.seenWall).Milliseconds()}
			if !sub.stateTS.IsZero() {
				ts := sub.stateTS
				ss.StateTS = &ts
			}
			for name, v := range sub.signals {
				ss.Signals[name] = v
			}
			if h := sub.hist["moved"]; len(h) >= 2 {
				a := h[max(0, len(h)-rateSamples)]
				b := h[len(h)-1]
				if dt := b.TS.Sub(a.TS).Seconds(); dt > 0 {
					r := max(0, (b.V-a.V)/dt)
					ss.Rate = &r
				}
			}
			minCov, have := NoUseCoverage, false
			var covTS time.Time
			for name, h := range sub.hist {
				if !strings.HasPrefix(name, "level:") {
					continue
				}
				if cov, ok := Coverage(h, CoverageWindowS); ok {
					have = true
					minCov = min(minCov, cov)
					covTS = h[len(h)-1].TS
				}
			}
			if have {
				ss.Signals["coverage_h"] = SigVal{V: minCov, TS: covTS}
			}
			out.Subjects[key] = ss
		}
		for pool, vs := range m.fleet {
			list := make([]Vehicle, 0, len(vs))
			for _, v := range vs {
				v.AgeMS = wall.Sub(v.seen).Milliseconds()
				list = append(list, v)
			}
			sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
			out.Fleet[pool] = list
		}
	}
	for _, so := range s.sources {
		bound := false
		for _, b := range bindings {
			if b.Enabled && MatchSource(b.Source, so.source) {
				bound = true
				break
			}
		}
		out.Sources = append(out.Sources, SourceSnap{Source: so.source, Desc: so.desc, LastTS: so.lastTS,
			AgeMS: wall.Sub(so.seenWall).Milliseconds(), Count: so.count, Last: so.last, Bound: bound})
	}
	sort.Slice(out.Sources, func(i, j int) bool { return out.Sources[i].Source < out.Sources[j].Source })
	return out
}

// Levels trả tồn kho hiện tại của một mô hình: node → vật tư → mức (tín hiệu `level:<vật tư>`).
func (s *State) Levels(model string) map[string]map[string]float64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := map[string]map[string]float64{}
	if m := s.models[model]; m != nil {
		for key, sub := range m.subjects {
			for name, v := range sub.signals {
				if mat, ok := strings.CutPrefix(name, "level:"); ok {
					if out[key] == nil {
						out[key] = map[string]float64{}
					}
					out[key][mat] = v.V
				}
			}
		}
	}
	return out
}

// States trả trạng thái chữ hiện tại của từng node (tín hiệu `state`).
func (s *State) States(model string) map[string]string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := map[string]string{}
	if m := s.models[model]; m != nil {
		for key, sub := range m.subjects {
			if sub.state != "" {
				out[key] = sub.state
			}
		}
	}
	return out
}

// Now là giờ ảo mới nhất đã thấy của mô hình (zero nếu chưa có dữ liệu).
func (s *State) Now(model string) time.Time {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if m := s.models[model]; m != nil {
		return m.now
	}
	return time.Time{}
}

// Models liệt kê các mô hình đang có dữ liệu live.
func (s *State) Models() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]string, 0, len(s.models))
	for k := range s.models {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
