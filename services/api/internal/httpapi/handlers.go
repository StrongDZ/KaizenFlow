package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/kaizenflow/api/internal/catalog"
	"github.com/kaizenflow/api/internal/resolve"
	"github.com/kaizenflow/api/internal/runs"
	"github.com/kaizenflow/api/internal/simapi"
	"github.com/kaizenflow/api/internal/store"
	"github.com/kaizenflow/api/internal/validate"
)

type handlers struct{ Deps }

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func issues(list ...validate.Issue) map[string]any {
	return map[string]any{"error": "invalid", "issues": list}
}

func writeErr(w http.ResponseWriter, err error) {
	var re *store.RefError
	var ie *resolve.IssueError
	var ce *simapi.ContractError
	var le *store.LockedError
	var im *store.ImpactError
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeJSON(w, 404, map[string]string{"error": "not found"})
	case errors.Is(err, store.ErrNotDraft), errors.Is(err, runs.ErrNotPublished), errors.Is(err, errNoPublished),
		errors.Is(err, store.ErrBusy), errors.Is(err, store.ErrChanged):
		writeJSON(w, 409, map[string]string{"error": err.Error()})
	case errors.As(err, &le):
		writeJSON(w, 409, map[string]any{"error": le.Msg, "locked": true, "usage": le.Usage})
	case errors.As(err, &im):
		writeJSON(w, 409, map[string]any{"error": "has dependents", "impact": im.Impact})
	case errors.As(err, &re):
		writeJSON(w, 422, issues(validate.Issue{Key: re.Key, Message: re.Msg}))
	case errors.As(err, &ie):
		writeJSON(w, 422, issues(validate.Issue{Key: ie.Key, Message: ie.Msg}))
	case errors.As(err, &ce):
		writeJSON(w, 422, issues(validate.Issue{Key: ce.Key, Message: ce.Message}))
	case errors.Is(err, runs.ErrNotRecommendation):
		writeJSON(w, 422, issues(validate.Issue{Key: "insight", Message: err.Error()}))
	default:
		writeJSON(w, 500, map[string]string{"error": err.Error()})
	}
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil && !errors.Is(err, io.EOF) {
		writeJSON(w, 400, map[string]string{"error": "bad json: " + err.Error()})
		return false
	}
	return true
}

func pathID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad id"})
		return 0, false
	}
	return id, true
}

func (h *handlers) listNodeTypes(w http.ResponseWriter, r *http.Request) {
	list, err := h.Store.ListNodeTypeRows(r.Context())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, list)
}

func (h *handlers) createNodeType(w http.ResponseWriter, r *http.Request) {
	var t store.NodeType
	if !decode(w, r, &t) {
		return
	}
	schema, ok := catalog.SchemaFor(t.Archetype)
	if !ok || t.Code == "" || t.Name == "" {
		writeJSON(w, 422, issues(validate.Issue{Key: t.Code, Message: "needs code, name and a valid archetype"}))
		return
	}
	t.ParamSchema = schema
	if list := checkNodeTypeJSON(h.Validator, t, t.DefaultParams, t.Signals, t.FailureModes); len(list) > 0 {
		writeJSON(w, 422, issues(list...))
		return
	}
	id, err := h.Store.CreateNodeType(r.Context(), t)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 201, map[string]int64{"id": id})
}

func (h *handlers) listMaterials(w http.ResponseWriter, r *http.Request) {
	list, err := h.Store.ListMaterialRows(r.Context())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, list)
}

func (h *handlers) createMaterial(w http.ResponseWriter, r *http.Request) {
	var m store.Material
	if !decode(w, r, &m) {
		return
	}
	if m.Code == "" {
		writeJSON(w, 422, issues(validate.Issue{Key: "code", Message: "required"}))
		return
	}
	id, err := h.Store.CreateMaterial(r.Context(), m)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 201, map[string]int64{"id": id})
}

func (h *handlers) listModels(w http.ResponseWriter, r *http.Request) {
	list, err := h.Store.ListModels(r.Context())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, list)
}

func (h *handlers) createModel(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ModelKey string         `json:"model_key"`
		Settings map[string]any `json:"settings"`
		// CopyFrom: khoá một mô hình có sẵn; mô hình mới bắt đầu từ bản sao sơ đồ mới nhất của nó (thay vì sơ đồ trống).
		CopyFrom string `json:"copy_from"`
	}
	if !decode(w, r, &body) {
		return
	}
	if body.ModelKey == "" {
		writeJSON(w, 422, issues(validate.Issue{Key: "model_key", Message: "required"}))
		return
	}
	ctx := r.Context()
	var src *store.Graph
	if body.CopyFrom != "" {
		g, _, err := h.modelGraph(ctx, body.CopyFrom, false)
		if errors.Is(err, store.ErrNotFound) {
			writeJSON(w, 422, issues(validate.Issue{Key: "copy_from", Message: "Không có mô hình '" + body.CopyFrom + "' để sao chép. Chọn một mô hình có trong danh sách."}))
			return
		} else if err != nil {
			writeErr(w, err)
			return
		}
		src = g
		if body.Settings == nil {
			body.Settings = g.Settings
		}
	}
	id, err := h.Store.CreateModel(ctx, body.ModelKey, body.Settings)
	if err != nil {
		writeErr(w, err)
		return
	}
	if src != nil {
		if err := h.Store.ReplaceGraph(ctx, id, src.Nodes, src.Edges, src.Settings); err != nil {
			_ = h.Store.DeleteModel(ctx, body.ModelKey, true) // không để lại mô hình rỗng khi sao chép lỗi
			writeErr(w, err)
			return
		}
	}
	writeJSON(w, 201, map[string]int64{"version_id": id})
}

func (h *handlers) listVersions(w http.ResponseWriter, r *http.Request) {
	list, err := h.Store.ListVersions(r.Context(), chi.URLParam(r, "key"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, list)
}

func (h *handlers) getGraph(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	g, err := h.Store.GetGraph(r.Context(), id)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, g)
}

func (h *handlers) putGraph(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var body struct {
		Nodes    []store.GraphNode `json:"nodes"`
		Edges    []store.GraphEdge `json:"edges"`
		Settings map[string]any    `json:"settings"`
	}
	if !decode(w, r, &body) {
		return
	}
	if err := h.Store.ReplaceGraph(r.Context(), id, body.Nodes, body.Edges, body.Settings); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(204)
}

func (h *handlers) publish(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	g, err := h.Store.GetGraph(ctx, id)
	if err != nil {
		writeErr(w, err)
		return
	}
	if g.Status != "DRAFT" {
		writeErr(w, store.ErrNotDraft)
		return
	}
	rep, err := h.graphReport(ctx, g, true)
	if err != nil {
		writeErr(w, err)
		return
	}
	if !rep.OK {
		writeJSON(w, 422, issues(errorsOf(rep)...))
		return
	}
	if err := h.Store.Publish(ctx, id); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]string{"status": "PUBLISHED"})
}

func (h *handlers) clone(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	nid, err := h.Store.Clone(r.Context(), id)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 201, map[string]int64{"version_id": nid})
}

func (h *handlers) listScenarios(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	list, err := h.Store.ListScenarios(r.Context(), id)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, list)
}

func (h *handlers) createScenario(w http.ResponseWriter, r *http.Request) {
	var sc store.Scenario
	if !decode(w, r, &sc) {
		return
	}
	if sc.HorizonS <= 0 || sc.ModelVersionID == 0 {
		writeJSON(w, 422, issues(validate.Issue{Key: "scenario", Message: "needs model_version_id and horizon_s > 0"}))
		return
	}
	sc.Origin = "USER"
	id, err := h.Store.CreateScenario(r.Context(), sc)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 201, map[string]int64{"id": id})
}

func (h *handlers) getScenario(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	sc, err := h.Store.GetScenario(r.Context(), id)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, sc)
}

func (h *handlers) startRun(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var body struct {
		SimStart *time.Time `json:"sim_start"`
	}
	if !decode(w, r, &body) {
		return
	}
	start := time.Now().Truncate(time.Minute)
	if body.SimStart != nil {
		start = *body.SimStart
	}
	runID, err := h.Runs.Start(r.Context(), id, start)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 202, map[string]int64{"run_id": runID})
}

func (h *handlers) listRuns(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	list, err := h.Store.ListRuns(r.Context(), id)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, list)
}

func (h *handlers) getRun(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	run, err := h.Store.GetRun(r.Context(), id)
	if err != nil {
		writeErr(w, err)
		return
	}
	ins, err := h.Store.ListInsights(r.Context(), id)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"id": run.ID, "scenario_id": run.ScenarioID, "status": run.Status,
		"purpose": run.Purpose, "sim_start": run.SimStart, "kpis": run.KPIs, "error": run.Error,
		"engine_version": run.EngineVersion, "created_at": run.CreatedAt, "finished_at": run.FinishedAt, "insights": ins})
}

func (h *handlers) bands(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	list, err := h.Store.Bands(r.Context(), id, q.Get("subject"), q.Get("metric"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, list)
}

func (h *handlers) events(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	list, err := h.Store.Events(r.Context(), id, q.Get("subject"), q.Get("type"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, list)
}

func (h *handlers) signals(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	list, err := h.Store.Signals(r.Context(), id, q.Get("subject"), q.Get("name"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, list)
}

func (h *handlers) exportCSV(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	rc, err := h.Sim.ExportCSV(r.Context(), id)
	if err != nil {
		writeJSON(w, 502, map[string]string{"error": err.Error()})
		return
	}
	defer rc.Close()
	w.Header().Set("Content-Type", "text/csv")
	w.Header().Set("Content-Disposition", "attachment; filename=run-"+strconv.FormatInt(id, 10)+".csv")
	_, _ = io.Copy(w, rc)
}

func (h *handlers) apply(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var body struct {
		Rank       int                   `json:"rank"`
		Adjustment *runs.ApplyAdjustment `json:"adjustment,omitempty"`
	}
	if !decode(w, r, &body) {
		return
	}
	if body.Rank == 0 {
		body.Rank = 1
	}
	runID, err := h.Runs.Apply(r.Context(), id, body.Rank, body.Adjustment)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 202, map[string]int64{"run_id": runID})
}

// queryInt đọc số nguyên từ query string; lỗi hoặc rỗng thì 0 (bị bỏ qua).
func queryInt(s string) int64 {
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}

func (h *handlers) listAllRuns(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := store.RunFilter{
		Model:     q.Get("model"),
		Origin:    q.Get("origin"),
		VersionID: queryInt(q.Get("version")),
		Limit:     int(queryInt(q.Get("limit"))),
		Offset:    int(queryInt(q.Get("offset"))),
	}
	if s := q.Get("status"); s != "" {
		f.Statuses = strings.Split(s, ",")
	}
	list, err := h.Store.ListRunRows(r.Context(), f)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, list)
}

func (h *handlers) listInsights(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	list, err := h.Store.ListInsightRows(r.Context(), q.Get("kind"), q.Get("status"), int(queryInt(q.Get("limit"))))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, list)
}

func (h *handlers) getNodeType(w http.ResponseWriter, r *http.Request) {
	d, err := h.Store.GetNodeTypeDetail(r.Context(), chi.URLParam(r, "code"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, d)
}

func (h *handlers) getMaterial(w http.ResponseWriter, r *http.Request) {
	d, err := h.Store.GetMaterialDetail(r.Context(), chi.URLParam(r, "code"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, d)
}

func cascadeFlag(r *http.Request) bool { return r.URL.Query().Get("cascade") == "true" }

// trimNull coi JSON null như trường vắng mặt (giữ nguyên giá trị cũ).
func trimNull(r json.RawMessage) json.RawMessage {
	if s := strings.TrimSpace(string(r)); s == "" || s == "null" {
		return nil
	}
	return r
}

func (h *handlers) deleteRun(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if err := h.Store.DeleteRun(r.Context(), id); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(204)
}

func (h *handlers) deleteScenario(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if err := h.Store.DeleteScenario(r.Context(), id, cascadeFlag(r)); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(204)
}

func (h *handlers) deleteVersion(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if err := h.Store.DeleteVersion(r.Context(), id, cascadeFlag(r)); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(204)
}

func (h *handlers) deleteModel(w http.ResponseWriter, r *http.Request) {
	if err := h.Store.DeleteModel(r.Context(), chi.URLParam(r, "key"), cascadeFlag(r)); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(204)
}

func (h *handlers) putScenario(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var sc store.Scenario
	if !decode(w, r, &sc) {
		return
	}
	if sc.HorizonS <= 0 {
		writeJSON(w, 422, issues(validate.Issue{Key: "scenario", Message: "needs horizon_s > 0"}))
		return
	}
	if err := h.Store.UpdateScenario(r.Context(), id, sc); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(204)
}

func (h *handlers) cloneScenario(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	nid, err := h.Store.CloneScenario(r.Context(), id)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 201, map[string]int64{"id": nid})
}

// checkNodeTypeJSON kiểm tra phần JSON của node type: default_params theo schema archetype, signals và failure_modes là mảng.
func checkNodeTypeJSON(v *validate.Validator, t store.NodeType, defaults, signals, failures json.RawMessage) []validate.Issue {
	var out []validate.Issue
	if defaults = trimNull(defaults); defaults != nil {
		var p map[string]any
		if err := json.Unmarshal(defaults, &p); err != nil || p == nil {
			out = append(out, validate.Issue{Key: "default_params", Message: "must be a JSON object"})
		} else {
			out = append(out, v.DefaultParams(t, p)...)
		}
	}
	for _, f := range []struct {
		key string
		raw json.RawMessage
	}{{"signals", signals}, {"failure_modes", failures}} {
		if raw := trimNull(f.raw); raw != nil {
			var arr []any
			if err := json.Unmarshal(raw, &arr); err != nil {
				out = append(out, validate.Issue{Key: f.key, Message: "must be a JSON array"})
			}
		}
	}
	return out
}

func (h *handlers) putNodeType(w http.ResponseWriter, r *http.Request) {
	code := chi.URLParam(r, "code")
	var body struct {
		Name          string          `json:"name"`
		DefaultParams json.RawMessage `json:"default_params"`
		Signals       json.RawMessage `json:"signals"`
		FailureModes  json.RawMessage `json:"failure_modes"`
		UI            json.RawMessage `json:"ui"`
	}
	if !decode(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.Name) == "" {
		writeJSON(w, 422, issues(validate.Issue{Key: "name", Message: "required"}))
		return
	}
	d, err := h.Store.GetNodeTypeDetail(r.Context(), code)
	if err != nil {
		writeErr(w, err)
		return
	}
	if list := checkNodeTypeJSON(h.Validator, d.NodeType, body.DefaultParams, body.Signals, body.FailureModes); len(list) > 0 {
		writeJSON(w, 422, issues(list...))
		return
	}
	err = h.Store.UpdateNodeType(r.Context(), code, store.NodeTypeUpdate{Name: strings.TrimSpace(body.Name),
		DefaultParams: trimNull(body.DefaultParams), Signals: trimNull(body.Signals),
		FailureModes: trimNull(body.FailureModes), UI: trimNull(body.UI)})
	if err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(204)
}

func (h *handlers) deleteNodeType(w http.ResponseWriter, r *http.Request) {
	if err := h.Store.DeleteNodeType(r.Context(), chi.URLParam(r, "code")); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(204)
}

func (h *handlers) putMaterial(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string  `json:"name"`
		Unit *string `json:"unit"`
	}
	if !decode(w, r, &body) {
		return
	}
	if err := h.Store.UpdateMaterial(r.Context(), chi.URLParam(r, "code"), strings.TrimSpace(body.Name), body.Unit); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(204)
}

func (h *handlers) deleteMaterial(w http.ResponseWriter, r *http.Request) {
	if err := h.Store.DeleteMaterial(r.Context(), chi.URLParam(r, "code")); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(204)
}
