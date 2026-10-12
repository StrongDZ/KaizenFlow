package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/kaizenflow/api/internal/live"
	"github.com/kaizenflow/api/internal/resolve"
	"github.com/kaizenflow/api/internal/simapi"
	"github.com/kaizenflow/api/internal/store"
	"github.com/kaizenflow/api/internal/validate"
)

// graphReport chạy các luật kiểm tra sơ đồ. deep thì nếu chưa có lỗi còn dựng RunRequest thử và hỏi sim,
// đúng những bước Publish đã chạy, nên Lưu, Kiểm tra và Publish dùng chung một bộ luật.
func (h *handlers) graphReport(ctx context.Context, g *store.Graph, deep bool) (validate.Report, error) {
	types, err := h.Store.NodeTypes(ctx)
	if err != nil {
		return validate.Report{}, err
	}
	mats, err := h.Store.MaterialCodes(ctx)
	if err != nil {
		return validate.Report{}, err
	}
	var travel func(src, dst string) (float64, bool)
	var route func(src, dst string) string
	if raw, err := h.Store.GetAgvMap(ctx, g.ModelKey); err == nil {
		if m, err := live.ParseMap(raw); err == nil {
			travel, route = m.Travel, m.Route
		}
	}
	assets, err := h.Store.ListAssets(ctx)
	if err != nil {
		return validate.Report{}, err
	}
	known := make(map[string]bool, len(assets))
	for _, a := range assets {
		known[a.Key] = true
	}
	rep := h.Validator.Check(validate.CheckInput{Graph: g, Types: types, Materials: mats, Assets: known,
		MapTravel: travel, MapRoute: route})
	if !deep || !rep.OK {
		return rep, nil
	}
	probe := &store.Scenario{Origin: "RECOMMENDER", HorizonS: 60, StartState: "EMPTY", Replications: 1}
	req, err := resolve.Build(ctx, g, types, mats, probe, 0, time.Now(), nil, resolve.Options{ForValidation: true})
	if err == nil {
		err = h.Sim.Validate(ctx, req)
	}
	if err == nil {
		return rep, nil
	}
	var ie *resolve.IssueError
	var ce *simapi.ContractError
	switch {
	case errors.As(err, &ie):
		rep.Issues = append([]validate.Issue{{Key: ie.Key, Message: ie.Msg, Severity: validate.SevError, Code: "resolve"}}, rep.Issues...)
	case errors.As(err, &ce):
		rep.Issues = append([]validate.Issue{{Key: ce.Key, Message: ce.Message, Severity: validate.SevError, Code: "sim_rejected"}}, rep.Issues...)
	default:
		return rep, err
	}
	rep.OK = false
	return rep, nil
}

func errorsOf(rep validate.Report) []validate.Issue {
	var out []validate.Issue
	for _, i := range rep.Issues {
		if i.Severity == validate.SevError {
			out = append(out, i)
		}
	}
	return out
}

// checkGraph: POST /api/versions/{id}/check. Thân tuỳ chọn {nodes, edges, settings} để kiểm bản đang sửa chưa lưu;
// không có thân thì kiểm bản đã lưu. ?deep=1 còn hỏi sim (dùng khi Lưu và Publish).
func (h *handlers) checkGraph(w http.ResponseWriter, r *http.Request) {
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
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad body"})
		return
	}
	if len(strings.TrimSpace(string(raw))) > 0 {
		var body struct {
			Nodes    *[]store.GraphNode `json:"nodes"`
			Edges    *[]store.GraphEdge `json:"edges"`
			Settings map[string]any     `json:"settings"`
		}
		if err := json.Unmarshal(raw, &body); err != nil {
			writeJSON(w, 400, map[string]string{"error": "bad json: " + err.Error()})
			return
		}
		// Thân {} (hay không có nodes/edges) nghĩa là kiểm bản đã lưu, không phải sơ đồ trống.
		if body.Nodes != nil || body.Edges != nil {
			g.Nodes, g.Edges = nil, nil
			if body.Nodes != nil {
				g.Nodes = *body.Nodes
			}
			if body.Edges != nil {
				g.Edges = *body.Edges
			}
		}
		if body.Settings != nil {
			g.Settings = body.Settings
		}
	}
	rep, err := h.graphReport(ctx, g, r.URL.Query().Get("deep") == "1")
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, rep)
}
