package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sort"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/kaizenflow/api/internal/live"
	"github.com/kaizenflow/api/internal/livesvc"
	"github.com/kaizenflow/api/internal/resolve"
	"github.com/kaizenflow/api/internal/simapi"
	"github.com/kaizenflow/api/internal/store"
	"github.com/kaizenflow/api/internal/validate"
)

var errNoPublished = errors.New("mô hình chưa có version nào đã Publish")

// modelGraph trả graph của version mới nhất (publishedOnly thì chỉ tính version đã Publish) và catalog loại node.
func (h *handlers) modelGraph(ctx context.Context, key string, publishedOnly bool) (*store.Graph, map[string]store.NodeType, error) {
	versions, err := h.Store.ListVersions(ctx, key)
	if err != nil {
		return nil, nil, err
	}
	var pick *store.VersionInfo
	for i := range versions {
		if publishedOnly && versions[i].Status != "PUBLISHED" {
			continue
		}
		pick = &versions[i]
	}
	if pick == nil {
		if len(versions) == 0 {
			return nil, nil, store.ErrNotFound
		}
		return nil, nil, errNoPublished
	}
	g, err := h.Store.GetGraph(ctx, pick.ID)
	if err != nil {
		return nil, nil, err
	}
	types, err := h.Store.NodeTypes(ctx)
	return g, types, err
}

func (h *handlers) ingest(w http.ResponseWriter, r *http.Request) {
	if h.Live == nil {
		writeJSON(w, 503, map[string]string{"error": "live chưa bật"})
		return
	}
	var body struct {
		// Model là mô hình mà các nguồn trong lô thuộc về (feed gửi kèm); không có thì nguồn được gắn theo ghép nối khớp.
		Model    string         `json:"model"`
		Messages []live.Message `json:"messages"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
	if !decode(w, r, &body) {
		return
	}
	writeJSON(w, 200, h.Live.IngestFor(body.Model, body.Messages))
}

type liveResp struct {
	live.Snapshot
	Errors   []livesvc.ErrCount `json:"errors"`
	Bindings int                `json:"bindings"`
}

func (h *handlers) liveState(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "key")
	bs, err := h.Store.ListBindings(r.Context(), key)
	if err != nil {
		writeErr(w, err)
		return
	}
	errs := h.Live.RecentErrors(key)
	if errs == nil {
		errs = []livesvc.ErrCount{}
	}
	writeJSON(w, 200, liveResp{Snapshot: h.Live.Snapshot(key), Errors: errs, Bindings: len(bs)})
}

func (h *handlers) clearLive(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "key")
	h.Live.Clear(key) // trước: bỏ hàng đợi ghi DB rồi mới xoá DB, để dòng của phiên cũ không được ghi sau khi đã xoá
	if err := h.Store.ClearLive(r.Context(), key); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(204)
}

// subjectView là live.Subject: node hoặc edge cùng các tín hiệu chuẩn của nó.
type subjectView = live.Subject

func (h *handlers) liveSubjects(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "key")
	g, types, err := h.modelGraph(r.Context(), key, false)
	if err != nil {
		writeErr(w, err)
		return
	}
	subs, err := subjectsOf(g, types)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"model": key, "version_id": g.VersionID, "version": g.Version, "status": g.Status, "subjects": subs})
}

func subjectsOf(g *store.Graph, types map[string]store.NodeType) ([]subjectView, error) {
	subs := make([]subjectView, 0, len(g.Nodes)+len(g.Edges))
	names := map[string]string{}
	for _, n := range g.Nodes {
		t, ok := types[n.NodeType]
		if !ok {
			return nil, &resolve.IssueError{Key: n.Key, Msg: "unknown node type '" + n.NodeType + "'"}
		}
		params, err := resolve.MergeNodeParams(t, n)
		if err != nil {
			return nil, &resolve.IssueError{Key: n.Key, Msg: err.Error()}
		}
		name := n.Name
		if name == "" {
			name = t.Name
		}
		names[n.Key] = name
		defs := live.SignalsFor(t.Archetype, params)
		if defs == nil {
			defs = []live.SignalDef{}
		}
		sv := subjectView{Subject: n.Key, Kind: "node", Name: name, NodeType: n.NodeType, Archetype: t.Archetype, Signals: defs}
		fillHints(&sv, params)
		subs = append(subs, sv)
	}
	for _, e := range g.Edges {
		mode, _ := e.Params["mode"].(string)
		label := func(key string) string {
			if n, ok := names[key]; ok {
				return n
			}
			return key
		}
		sv := subjectView{Subject: e.Key, Kind: "edge", Name: label(e.Src) + " → " + label(e.Dst), Material: e.Material,
			Mode: mode, Src: e.Src, Dst: e.Dst, Signals: live.EdgeSignals(mode)}
		sv.Pool, _ = e.Params["pool"].(string)
		sv.Lot = 1
		if lot, ok := numOf(e.Params["lot"]); ok && lot > 0 {
			sv.Lot = lot
		}
		subs = append(subs, sv)
	}
	return subs, nil
}

func numOf(v any) (float64, bool) {
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

// meanSeconds: giá trị trung bình của một thời gian cho dạng số hoặc phân phối ({dist: const|norm|lognorm|exp|tri|uniform...}).
func meanSeconds(v any) float64 {
	if f, ok := numOf(v); ok {
		return f
	}
	m, ok := v.(map[string]any)
	if !ok {
		return 0
	}
	for _, k := range []string{"value", "mean", "mean_s"} {
		if f, ok := numOf(m[k]); ok {
			return f
		}
	}
	if lo, ok := numOf(m["min"]); ok {
		if hi, ok := numOf(m["max"]); ok {
			return (lo + hi) / 2
		}
	}
	return 0
}

// fillHints điền các dữ kiện từ tham số hiệu lực của node mà phần gợi ý công thức tự tính cần (tồn đầu kỳ, số đơn vị mỗi lượt, chu kỳ).
func fillHints(sv *subjectView, params map[string]any) {
	switch sv.Archetype {
	case "STORAGE":
		sv.Initial = map[string]float64{}
		for _, raw := range listAny(params["stock"]) {
			m, _ := raw.(map[string]any)
			if code, _ := m["material"].(string); code != "" {
				init, _ := numOf(m["initial"])
				sv.Initial[code] = init
			}
		}
	case "PROCESS":
		sv.CycleS = meanSeconds(params["cycle"])
		sv.InQty, sv.OutQty = map[string]float64{}, map[string]float64{}
		recipes := listAny(params["recipes"])
		if len(recipes) == 0 {
			return
		}
		r0, _ := recipes[0].(map[string]any)
		for _, raw := range listAny(r0["inputs"]) {
			m, _ := raw.(map[string]any)
			if code, _ := m["material"].(string); code != "" {
				q, _ := numOf(m["qty"])
				sv.InQty[code] = q
			}
		}
		for _, raw := range listAny(r0["outputs"]) {
			m, _ := raw.(map[string]any)
			port, _ := m["port"].(string)
			if code, _ := m["material"].(string); code != "" && port != "NG" {
				q, _ := numOf(m["qty"])
				sv.OutQty[code] = q
			}
		}
	}
}

func listAny(v any) []any {
	l, _ := v.([]any)
	return l
}

// sourceSamples trả các nguồn đã đăng ký của mô hình cùng bản tin mẫu (bản tin mới nhất đang phát nếu có, không thì mẫu đã lưu).
func (h *handlers) sourceSamples(ctx context.Context, model string) ([]live.SourceSample, error) {
	rows, err := h.Store.ListSources(ctx, model)
	if err != nil {
		return nil, err
	}
	ram := map[string]any{}
	for _, s := range h.Live.Snapshot(model).Sources {
		ram[s.Source] = s.Last
	}
	out := make([]live.SourceSample, 0, len(rows))
	for _, d := range rows {
		var sample any
		if last, ok := ram[d.Source]; ok && last != nil {
			sample = last
		} else if len(d.Sample) > 0 {
			_ = json.Unmarshal(d.Sample, &sample)
		}
		out = append(out, live.SourceSample{Source: d.Source, Sample: sample})
	}
	return out, nil
}

// liveCheck: GET /api/models/{key}/live/check. Độ phủ ghép nối: tín hiệu nào đã có nguồn, đã tự tính, chưa có hay hỏng;
// chức năng nào đã đủ tín hiệu; và gợi ý công thức tự tính cho tín hiệu chưa có.
func (h *handlers) liveCheck(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	key := chi.URLParam(r, "key")
	g, types, err := h.modelGraph(ctx, key, false)
	if err != nil {
		writeErr(w, err)
		return
	}
	subs, err := subjectsOf(g, types)
	if err != nil {
		writeErr(w, err)
		return
	}
	bs, err := h.Store.ListBindings(ctx, key)
	if err != nil {
		writeErr(w, err)
		return
	}
	samples, err := h.sourceSamples(ctx, key)
	if err != nil {
		writeErr(w, err)
		return
	}
	rep := live.AnalyzeCoverage(live.CoverageInput{Subjects: subs, Bindings: bs, Sources: samples})
	if p := live.OffMapProblem(h.Live.Snapshot(key).Fleet); p != nil {
		rep.Problems = append(rep.Problems, *p)
	}
	writeJSON(w, 200, rep)
}

func (h *handlers) liveSignals(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	parse := func(name string) (*time.Time, bool) {
		v := q.Get(name)
		if v == "" {
			return nil, true
		}
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": name + " phải theo RFC3339"})
			return nil, false
		}
		return &t, true
	}
	since, ok := parse("since")
	if !ok {
		return
	}
	until, ok := parse("until")
	if !ok {
		return
	}
	limit, _ := strconv.Atoi(q.Get("limit"))
	rows, err := h.Store.LiveSignals(r.Context(), chi.URLParam(r, "key"), q.Get("subject"), q.Get("name"), since, until, limit)
	if err != nil {
		writeErr(w, err)
		return
	}
	if rows == nil {
		rows = []store.SignalRow{}
	}
	writeJSON(w, 200, rows)
}

func (h *handlers) listBindings(w http.ResponseWriter, r *http.Request) {
	list, err := h.Store.ListBindings(r.Context(), chi.URLParam(r, "key"))
	if err != nil {
		writeErr(w, err)
		return
	}
	if list == nil {
		list = []live.Binding{}
	}
	writeJSON(w, 200, list)
}

func (h *handlers) putBindings(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	key := chi.URLParam(r, "key")
	var body struct {
		Bindings []struct {
			Subject   string         `json:"subject"`
			Signal    string         `json:"signal"`
			Source    string         `json:"source"`
			JSONPath  string         `json:"json_path"`
			Transform live.Transform `json:"transform"`
			Enabled   *bool          `json:"enabled"`
			Mode      string         `json:"mode"`
			Derive    *live.Derive   `json:"derive"`
		} `json:"bindings"`
	}
	if !decode(w, r, &body) {
		return
	}
	g, types, err := h.modelGraph(ctx, key, false)
	if err != nil {
		writeErr(w, err)
		return
	}
	subs, err := subjectsOf(g, types)
	if err != nil {
		writeErr(w, err)
		return
	}
	bySubject := map[string]subjectView{}
	for _, s := range subs {
		bySubject[s.Subject] = s
	}
	// signalOK: tín hiệu có nằm trong danh mục của đối tượng không (kho nhận mọi `level:<vật tư>`, vì vật tư có thể thêm sau).
	signalOK := func(s subjectView, name string) bool {
		for _, d := range s.Signals {
			if d.Name == name {
				return true
			}
		}
		return s.Archetype == "STORAGE" && live.ValidSignal("STORAGE", nil, name)
	}
	var list []validate.Issue
	bs := make([]live.Binding, 0, len(body.Bindings))
	for _, in := range body.Bindings {
		s, ok := bySubject[in.Subject]
		if !ok {
			list = append(list, validate.Issue{Key: in.Subject, Message: "không có node hoặc edge này trong sơ đồ"})
			continue
		}
		if !signalOK(s, in.Signal) {
			list = append(list, validate.Issue{Key: in.Subject, Message: "tín hiệu '" + in.Signal + "' không hợp lệ cho đối tượng này"})
			continue
		}
		enabled := in.Enabled == nil || *in.Enabled
		b := live.Binding{Subject: in.Subject, Signal: in.Signal, Source: in.Source, JSONPath: in.JSONPath,
			Transform: in.Transform, Enabled: enabled, Mode: in.Mode, Derive: in.Derive}
		if b.Mode == "" {
			b.Mode = live.ModeSource
		}
		if b.Mode == live.ModeDerived {
			b.Source, b.JSONPath, b.Transform = "", "", live.Transform{} // tự tính không có nguồn
		} else {
			b.Derive = nil
		}
		bs = append(bs, b)
	}
	if len(list) == 0 {
		// Công thức tự tính được kiểm trên trạng thái sau khi lưu: các ghép nối cũ (bớt những cái sắp bị thay) cộng các ghép nối mới.
		existing, err := h.Store.ListBindings(ctx, key)
		if err != nil {
			writeErr(w, err)
			return
		}
		replaced := map[live.Ref]bool{}
		for _, b := range bs {
			replaced[live.Ref{Subject: b.Subject, Signal: b.Signal}] = true
		}
		final := append([]live.Binding{}, bs...)
		for _, b := range existing {
			if !replaced[live.Ref{Subject: b.Subject, Signal: b.Signal}] {
				final = append(final, b)
			}
		}
		known := func(ref live.Ref) bool {
			s, ok := bySubject[ref.Subject]
			return ok && signalOK(s, ref.Signal)
		}
		for _, b := range bs {
			if b.Mode != live.ModeDerived {
				continue
			}
			if b.Derive == nil {
				list = append(list, validate.Issue{Key: b.Subject, Message: "Thiếu công thức tự tính."})
			} else if err := live.ValidateDerive(live.Ref{Subject: b.Subject, Signal: b.Signal}, *b.Derive, final, known); err != nil {
				list = append(list, validate.Issue{Key: b.Subject, Message: err.Error()})
			}
		}
	}
	if len(list) > 0 {
		writeJSON(w, 422, issues(list...))
		return
	}
	// ?check=1: chỉ kiểm tra (mọi luật như khi lưu) mà không lưu, để hộp thoại báo hợp lệ hay chưa trước khi bấm Lưu.
	if r.URL.Query().Get("check") == "1" {
		writeJSON(w, 200, map[string]bool{"ok": true})
		return
	}
	if err := h.Store.SaveBindings(ctx, key, bs); err != nil {
		writeErr(w, err)
		return
	}
	if err := h.Live.ReloadBindings(ctx); err != nil {
		writeErr(w, err)
		return
	}
	out, err := h.Store.ListBindings(ctx, key)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"bindings": out})
}

func (h *handlers) deleteBinding(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if err := h.Store.DeleteBinding(r.Context(), chi.URLParam(r, "key"), id); err != nil {
		writeErr(w, err)
		return
	}
	if err := h.Live.ReloadBindings(r.Context()); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(204)
}

func (h *handlers) deleteAllBindings(w http.ResponseWriter, r *http.Request) {
	if _, err := h.Store.DeleteAllBindings(r.Context(), chi.URLParam(r, "key")); err != nil {
		writeErr(w, err)
		return
	}
	if err := h.Live.ReloadBindings(r.Context()); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(204)
}

func (h *handlers) getAgvMap(w http.ResponseWriter, r *http.Request) {
	raw, err := h.Store.GetAgvMap(r.Context(), chi.URLParam(r, "key"))
	if err != nil {
		writeErr(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)
	_, _ = w.Write(normalizedMap(raw))
}

// normalizedMap đổi bản đồ lưu từ trước (v1, đơn vị vẽ × unit_m) sang v2 (mét) để mọi nơi đọc đều thấy một dạng; hỏng thì trả nguyên.
func normalizedMap(raw json.RawMessage) json.RawMessage {
	m, err := live.ParseMap(raw)
	if err != nil {
		return raw
	}
	out, err := json.Marshal(m)
	if err != nil {
		return raw
	}
	return out
}

func (h *handlers) putAgvMap(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	key := chi.URLParam(r, "key")
	var m live.AgvMap
	if !decode(w, r, &m) {
		return
	}
	g, _, err := h.modelGraph(ctx, key, false)
	if err != nil {
		writeErr(w, err)
		return
	}
	nodes := map[string]bool{}
	for _, n := range g.Nodes {
		nodes[n.Key] = true
	}
	m.Normalize()
	if m.Points == nil {
		m.Points = []live.MapPoint{}
	}
	if m.Lanes == nil {
		m.Lanes = []live.MapLane{}
	}
	if list := m.Validate(nodes); len(list) > 0 {
		out := make([]validate.Issue, len(list))
		for i, x := range list {
			out[i] = validate.Issue{Key: x.Key, Message: x.Message}
		}
		writeJSON(w, 422, issues(out...))
		return
	}
	raw, _ := json.Marshal(m)
	if err := h.Store.PutAgvMap(ctx, key, raw); err != nil {
		writeErr(w, err)
		return
	}
	h.Live.InvalidateMap(key)
	w.WriteHeader(204)
}

// blueprint là bản mô tả mô hình mà feed cần để dựng "nhà máy thật": RunRequest đã resolve, tên node, bản đồ AGV.
func (h *handlers) blueprint(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	key := chi.URLParam(r, "key")
	g, types, err := h.modelGraph(ctx, key, true)
	if err != nil {
		writeErr(w, err)
		return
	}
	mats, err := h.Store.MaterialCodes(ctx)
	if err != nil {
		writeErr(w, err)
		return
	}
	sc := store.Scenario{Origin: "USER", HorizonS: 7 * 86400, Replications: 1, StartState: "WARMUP"}
	req, err := resolve.Build(ctx, g, types, mats, &sc, 0, time.Now(), h.Store.DailyForecast, resolve.Options{})
	if err != nil {
		writeErr(w, err)
		return
	}
	names := map[string]string{}
	for _, n := range g.Nodes {
		names[n.Key] = n.Name
		if n.Name == "" {
			names[n.Key] = types[n.NodeType].Name
		}
	}
	var agv json.RawMessage
	if raw, err := h.Store.GetAgvMap(ctx, key); err == nil {
		agv = normalizedMap(raw)
	} else if !errors.Is(err, store.ErrNotFound) {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, struct {
		Model     string             `json:"model"`
		VersionID int64              `json:"version_id"`
		Version   int                `json:"version"`
		Request   *simapi.RunRequest `json:"run_request"`
		Names     map[string]string  `json:"names"`
		AgvMap    json.RawMessage    `json:"agv_map"`
	}{key, g.VersionID, g.Version, req, names, agv})
}

// feedProxy chuyển /api/feed/* sang feed service (bỏ tiền tố), để web chỉ phải gọi Go.
func (h *handlers) feedProxy() http.Handler {
	if h.FeedURL == "" {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, 503, map[string]string{"error": "chưa cấu hình feed service (KF_FEED_URL)"})
		})
	}
	target, err := url.Parse(h.FeedURL)
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, 503, map[string]string{"error": "KF_FEED_URL không hợp lệ: " + err.Error()})
		})
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		writeJSON(w, 502, map[string]string{"error": "feed service không phản hồi (" + err.Error() + "). Hãy bật service feed rồi thử lại."})
	}
	return http.StripPrefix("/api/feed", proxy)
}

const (
	minForecastS = 1800
	maxForecastS = 7 * 86400
	// forecastReps: số lần lặp của dự báo từ live; đủ để có dải P10–P90 mà một dự báo 7 ngày vẫn xong trong vài chục giây.
	forecastReps = 20
)

// liveForecast dựng scenario NOWCAST từ trạng thái live hiện tại (tồn kho, máy hỏng) rồi chạy nó, bắt đầu từ giờ nhà máy hiện tại.
func (h *handlers) liveForecast(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	key := chi.URLParam(r, "key")
	var body struct {
		HorizonS     float64 `json:"horizon_s"`
		Replications int     `json:"replications"`
	}
	if !decode(w, r, &body) {
		return
	}
	if body.HorizonS < minForecastS || body.HorizonS > maxForecastS {
		writeJSON(w, 422, issues(validate.Issue{Key: "horizon_s", Message: "Thời gian dự báo phải từ 30 phút đến 7 ngày"}))
		return
	}
	g, types, err := h.modelGraph(ctx, key, true)
	if err != nil {
		writeErr(w, err)
		return
	}
	now := h.Live.State().Now(key)
	if now.IsZero() {
		writeJSON(w, 422, issues(validate.Issue{Key: "live", Message: "Chưa nhận dữ liệu live nào của mô hình này. Ghép tín hiệu ở tab Kết nối dữ liệu và bật feed."}))
		return
	}
	nodes := make([]live.NodeInfo, 0, len(g.Nodes))
	for _, n := range g.Nodes {
		t, ok := types[n.NodeType]
		if !ok {
			continue
		}
		params, err := resolve.MergeNodeParams(t, n)
		if err != nil {
			writeErr(w, &resolve.IssueError{Key: n.Key, Msg: err.Error()})
			return
		}
		nodes = append(nodes, live.NodeInfo{Key: n.Key, Archetype: t.Archetype, Params: params})
	}
	snap := live.BuildSnapshot(nodes, h.Live.State().Levels(key), h.Live.State().States(key))
	if len(snap.Overrides) == 0 && len(snap.Injections) == 0 {
		writeJSON(w, 422, issues(validate.Issue{Key: "live", Message: "Chưa có tồn kho hay trạng thái máy nào từ dữ liệu live để làm điểm xuất phát. Ghép các tín hiệu Tồn của kho ở tab Kết nối dữ liệu."}))
		return
	}
	reps := body.Replications
	if reps <= 0 {
		reps = forecastReps
	}
	if reps > 50 {
		reps = 50
	}
	overrides := snap.Overrides
	if overrides == nil {
		overrides = []map[string]any{}
	}
	injections := snap.Injections
	if injections == nil {
		injections = []map[string]any{}
	}
	sc := store.Scenario{
		ModelVersionID: g.VersionID, Origin: "NOWCAST", HorizonS: body.HorizonS, StartState: "LIVE_SNAPSHOT",
		Name:      "Dự báo từ trạng thái live lúc " + now.In(time.FixedZone("", 7*3600)).Format("15:04 02/01"),
		Overrides: overrides, Injections: injections, Replications: reps,
		Action: map[string]any{"live_snapshot": map[string]any{"at": now, "notes": snap.Notes, "levels": snap.Levels, "down": snap.Down}},
	}
	sid, err := h.Store.CreateScenario(ctx, sc)
	if err != nil {
		writeErr(w, err)
		return
	}
	rid, err := h.Runs.Start(ctx, sid, now)
	if err != nil {
		writeErr(w, err)
		return
	}
	if _, err := h.Store.SupersedeDrift(ctx, key); err != nil { // dự báo mới thay dự báo cũ
		writeErr(w, err)
		return
	}
	writeJSON(w, 202, map[string]any{"scenario_id": sid, "run_id": rid, "notes": snap.Notes, "at": now})
}

const calibrationSamples = 500

type calibrationRow struct {
	live.Calibration
	Name     string `json:"name"`
	Material string `json:"material"`
}

type tripWaiting struct {
	Edge string `json:"edge"`
	Name string `json:"name"`
	N    int    `json:"n"`
}

// calibrations so thời gian chuyến đo được (trip_s) của mọi edge chạy bằng xe với `travel` của mô hình.
func (h *handlers) calibrations(ctx context.Context, key string) (*store.Graph, []calibrationRow, []tripWaiting, error) {
	g, types, err := h.modelGraph(ctx, key, true)
	if err != nil {
		return nil, nil, nil, err
	}
	subs, err := subjectsOf(g, types)
	if err != nil {
		return nil, nil, nil, err
	}
	names := map[string]subjectView{}
	for _, s := range subs {
		names[s.Subject] = s
	}
	rows := []calibrationRow{}
	waiting := []tripWaiting{}
	for _, e := range g.Edges {
		if mode, _ := e.Params["mode"].(string); mode != "POOL" {
			continue
		}
		vals, err := h.Store.RecentLiveValues(ctx, key, e.Key, "trip_s", calibrationSamples)
		if err != nil {
			return nil, nil, nil, err
		}
		if len(vals) == 0 {
			continue
		}
		c, ok := live.Calibrate(e.Key, vals, e.Params["travel"])
		if !ok {
			waiting = append(waiting, tripWaiting{Edge: e.Key, Name: names[e.Key].Name, N: len(vals)})
			continue
		}
		rows = append(rows, calibrationRow{Calibration: c, Name: names[e.Key].Name, Material: e.Material})
	}
	sort.Slice(rows, func(i, j int) bool { return math.Abs(rows[i].DeltaPct) > math.Abs(rows[j].DeltaPct) })
	return g, rows, waiting, nil
}

func (h *handlers) calibration(w http.ResponseWriter, r *http.Request) {
	_, rows, waiting, err := h.calibrations(r.Context(), chi.URLParam(r, "key"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"min_trips": live.MinTrips, "edges": rows, "waiting": waiting})
}

// applyCalibration tạo hai scenario cùng seed để so được: nền (travel danh nghĩa) và bản có travel đã hiệu chỉnh, rồi chạy cả hai.
// Không sửa version đã Publish: travel mới đi qua overrides của scenario.
func (h *handlers) applyCalibration(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	key := chi.URLParam(r, "key")
	var body struct {
		Edges []string `json:"edges"`
	}
	if !decode(w, r, &body) {
		return
	}
	g, rows, _, err := h.calibrations(ctx, key)
	if err != nil {
		writeErr(w, err)
		return
	}
	want := map[string]bool{}
	for _, e := range body.Edges {
		want[e] = true
	}
	overrides := []map[string]any{}
	for _, c := range rows {
		if want[c.Edge] {
			overrides = append(overrides, map[string]any{"target": c.Edge, "path": "/travel", "value": c.Suggested})
			delete(want, c.Edge)
		}
	}
	if len(overrides) == 0 {
		writeJSON(w, 422, issues(validate.Issue{Key: "edges", Message: "Chưa có edge nào đủ chuyến đo (tối thiểu 8 chuyến) trong danh sách đã chọn."}))
		return
	}
	seed := time.Now().Unix()
	base := store.Scenario{ModelVersionID: g.VersionID, Origin: "USER", Name: "Nền: travel danh nghĩa (so với dữ liệu AGV)", HorizonS: 4 * 3600,
		StartState: "WARMUP", Replications: forecastReps, Seed: &seed}
	cal := base
	cal.Name = fmt.Sprintf("Travel hiệu chỉnh từ dữ liệu AGV (%d edge)", len(overrides))
	cal.Overrides = overrides
	baseID, err := h.Store.CreateScenario(ctx, base)
	if err != nil {
		writeErr(w, err)
		return
	}
	calID, err := h.Store.CreateScenario(ctx, cal)
	if err != nil {
		writeErr(w, err)
		return
	}
	start := time.Now().Truncate(time.Minute)
	baseRun, err := h.Runs.Start(ctx, baseID, start)
	if err != nil {
		writeErr(w, err)
		return
	}
	calRun, err := h.Runs.Start(ctx, calID, start)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 202, map[string]any{"baseline_scenario_id": baseID, "scenario_id": calID, "baseline_run_id": baseRun, "run_id": calRun, "edges": len(overrides)})
}

func (h *handlers) ackInsight(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if err := h.Store.SetInsightStatus(r.Context(), id, "ACK"); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(204)
}
