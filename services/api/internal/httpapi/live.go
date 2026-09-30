package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httputil"
	"net/url"
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
		Messages []live.Message `json:"messages"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
	if !decode(w, r, &body) {
		return
	}
	writeJSON(w, 200, h.Live.Ingest(body.Messages))
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
	if err := h.Store.ClearLive(r.Context(), key); err != nil {
		writeErr(w, err)
		return
	}
	h.Live.Clear(key)
	w.WriteHeader(204)
}

type subjectView struct {
	Subject   string           `json:"subject"`
	Kind      string           `json:"kind"`
	Name      string           `json:"name"`
	NodeType  string           `json:"node_type,omitempty"`
	Archetype string           `json:"archetype,omitempty"`
	Material  string           `json:"material,omitempty"`
	Mode      string           `json:"mode,omitempty"`
	Signals   []live.SignalDef `json:"signals"`
}

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
		defs := live.SignalsFor(t.Archetype, params)
		if defs == nil {
			defs = []live.SignalDef{}
		}
		subs = append(subs, subjectView{Subject: n.Key, Kind: "node", Name: name, NodeType: n.NodeType, Archetype: t.Archetype, Signals: defs})
	}
	for _, e := range g.Edges {
		mode, _ := e.Params["mode"].(string)
		subs = append(subs, subjectView{Subject: e.Key, Kind: "edge", Name: e.Src + " → " + e.Dst, Material: e.Material, Mode: mode,
			Signals: live.EdgeSignals(mode)})
	}
	return subs, nil
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
	var list []validate.Issue
	bs := make([]live.Binding, 0, len(body.Bindings))
	for _, in := range body.Bindings {
		s, ok := bySubject[in.Subject]
		if !ok {
			list = append(list, validate.Issue{Key: in.Subject, Message: "không có node hoặc edge này trong sơ đồ"})
			continue
		}
		valid := false
		for _, d := range s.Signals {
			if d.Name == in.Signal {
				valid = true
			}
		}
		if s.Archetype == "STORAGE" && live.ValidSignal("STORAGE", nil, in.Signal) {
			valid = true
		}
		if !valid {
			list = append(list, validate.Issue{Key: in.Subject, Message: "tín hiệu '" + in.Signal + "' không hợp lệ cho đối tượng này"})
			continue
		}
		enabled := in.Enabled == nil || *in.Enabled
		bs = append(bs, live.Binding{Subject: in.Subject, Signal: in.Signal, Source: in.Source, JSONPath: in.JSONPath,
			Transform: in.Transform, Enabled: enabled})
	}
	if len(list) > 0 {
		writeJSON(w, 422, issues(list...))
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
	_, _ = w.Write(raw)
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
	if m.UnitM <= 0 {
		m.UnitM = 1
	}
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
		agv = raw
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
