package httpapi_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/kaizenflow/api/internal/httpapi"
	"github.com/kaizenflow/api/internal/runs"
	"github.com/kaizenflow/api/internal/simapi"
	"github.com/kaizenflow/api/internal/simclient"
	"github.com/kaizenflow/api/internal/simfake"
	"github.com/kaizenflow/api/internal/testfix"
	"github.com/kaizenflow/api/internal/validate"
	"github.com/kaizenflow/api/internal/ws"
)

type api struct {
	t    *testing.T
	srv  *httptest.Server
	fake *simfake.Server
}

func newAPI(t *testing.T) *api {
	st := testfix.Seeded(t, "httpapi")
	fake := simfake.New()
	t.Cleanup(fake.Close)
	sim := simclient.New(fake.URL)
	hub := ws.NewHub()
	h := httpapi.New(httpapi.Deps{Store: st, Sim: sim, Hub: hub, Validator: validate.New(),
		Runs: &runs.Service{Store: st, Sim: sim, Hub: hub, Poll: 10 * time.Millisecond}})
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &api{t, srv, fake}
}

func (a *api) call(method, path string, body any, want int) map[string]any {
	a.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, a.srv.URL+path, rd)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		a.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != want {
		a.t.Fatalf("%s %s = %d (want %d): %s", method, path, resp.StatusCode, want, raw)
	}
	out := map[string]any{}
	if len(raw) > 0 && raw[0] == '{' {
		_ = json.Unmarshal(raw, &out)
	} else if len(raw) > 0 && raw[0] == '[' {
		var list []any
		_ = json.Unmarshal(raw, &list)
		out["items"] = list
	}
	return out
}

func graphBody() map[string]any {
	return map[string]any{"nodes": testfix.MiniNodes(), "edges": testfix.MiniEdges()}
}

func TestFullFlow(t *testing.T) {
	a := newAPI(t)
	a.call("GET", "/api/health", nil, 200)
	if n := len(a.call("GET", "/api/node-types", nil, 200)["items"].([]any)); n != 14 {
		t.Fatalf("node types = %d", n)
	}
	vid := int64(a.call("POST", "/api/models", map[string]any{"model_key": "denso-mini"}, 201)["version_id"].(float64))
	a.call("PUT", fmt.Sprintf("/api/versions/%d/graph", vid), graphBody(), 204)
	g := a.call("GET", fmt.Sprintf("/api/versions/%d", vid), nil, 200)
	if len(g["nodes"].([]any)) != 4 {
		t.Fatalf("graph = %v", g)
	}
	// run trước khi publish → 409
	sid := int64(a.call("POST", "/api/scenarios", map[string]any{"model_version_id": vid, "name": "base",
		"horizon_s": 3600, "replications": 2}, 201)["id"].(float64))
	a.call("POST", fmt.Sprintf("/api/scenarios/%d/runs", sid), map[string]any{}, 409)
	a.call("POST", fmt.Sprintf("/api/versions/%d/publish", vid), nil, 200)
	a.call("PUT", fmt.Sprintf("/api/versions/%d/graph", vid), graphBody(), 409)
	rid := int64(a.call("POST", fmt.Sprintf("/api/scenarios/%d/runs", sid),
		map[string]any{"sim_start": "2026-10-01T08:00:00+07:00"}, 202)["run_id"].(float64))
	var run map[string]any
	for i := 0; i < 300; i++ {
		run = a.call("GET", fmt.Sprintf("/api/runs/%d", rid), nil, 200)
		if run["status"] == "DONE" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if run["status"] != "DONE" || len(run["insights"].([]any)) != 2 {
		t.Fatalf("run = %v", run)
	}
	bands := a.call("GET", fmt.Sprintf("/api/runs/%d/bands?metric=coverage_h", rid), nil, 200)["items"].([]any)
	events := a.call("GET", fmt.Sprintf("/api/runs/%d/events?type=COLOR_CHANGE", rid), nil, 200)["items"].([]any)
	sigs := a.call("GET", fmt.Sprintf("/api/runs/%d/signals?subject=S", rid), nil, 200)["items"].([]any)
	if len(bands) != 2 || len(events) != 1 || len(sigs) != 5000 {
		t.Fatalf("bands=%d events=%d sigs=%d", len(bands), len(events), len(sigs))
	}
	rec := run["insights"].([]any)[1].(map[string]any)
	child := a.call("POST", fmt.Sprintf("/api/insights/%d/apply", int64(rec["id"].(float64))), map[string]any{"rank": 1}, 202)
	if child["run_id"].(float64) <= float64(rid) {
		t.Fatalf("child = %v", child)
	}
	if n := len(a.call("GET", fmt.Sprintf("/api/versions/%d/scenarios", vid), nil, 200)["items"].([]any)); n != 2 {
		t.Fatalf("scenarios = %d", n)
	}
	resp, _ := http.Get(a.srv.URL + fmt.Sprintf("/api/runs/%d/export.csv", rid))
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "text/csv" {
		t.Fatalf("csv = %d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	resp.Body.Close()
	clone := a.call("POST", fmt.Sprintf("/api/versions/%d/clone", vid), nil, 201)
	if clone["version_id"].(float64) == float64(vid) {
		t.Fatalf("clone = %v", clone)
	}
}

func TestValidationErrorsAre422WithKeys(t *testing.T) {
	a := newAPI(t)
	vid := int64(a.call("POST", "/api/models", map[string]any{"model_key": "bad"}, 201)["version_id"].(float64))
	body := graphBody()
	body["edges"] = []map[string]any{{"key": "X>Y", "src": "X", "dst": "Y", "material": "RAW-01"}}
	res := a.call("PUT", fmt.Sprintf("/api/versions/%d/graph", vid), body, 422)
	if res["issues"].([]any)[0].(map[string]any)["key"] != "X>Y" {
		t.Fatalf("issues = %v", res)
	}
	nodes := testfix.MiniNodes()
	nodes[1].Params = map[string]any{"capacity": -5.0}
	a.call("PUT", fmt.Sprintf("/api/versions/%d/graph", vid), map[string]any{"nodes": nodes, "edges": testfix.MiniEdges()}, 204)
	res = a.call("POST", fmt.Sprintf("/api/versions/%d/publish", vid), nil, 422)
	if res["issues"].([]any)[0].(map[string]any)["key"] != "S" {
		t.Fatalf("publish issues = %v", res)
	}
	a.call("PUT", fmt.Sprintf("/api/versions/%d/graph", vid), graphBody(), 204)
	a.fake.ValidateErr = &simapi.ContractError{Key: "S>OUT", Message: "lot too big"}
	res = a.call("POST", fmt.Sprintf("/api/versions/%d/publish", vid), nil, 422)
	if res["issues"].([]any)[0].(map[string]any)["key"] != "S>OUT" {
		t.Fatalf("sim issues = %v", res)
	}
	a.fake.ValidateErr = nil
	a.call("POST", fmt.Sprintf("/api/versions/%d/publish", vid), nil, 200)
	sid := int64(a.call("POST", "/api/scenarios", map[string]any{"model_version_id": vid, "horizon_s": 60,
		"overrides": []map[string]any{{"target": "GHOST", "path": "/count", "value": 1}}}, 201)["id"].(float64))
	res = a.call("POST", fmt.Sprintf("/api/scenarios/%d/runs", sid), map[string]any{}, 422)
	if res["issues"].([]any)[0].(map[string]any)["key"] != "GHOST" {
		t.Fatalf("override issue = %v", res)
	}
	a.call("GET", "/api/runs/999999", nil, 404)
	a.call("POST", "/api/models", map[string]any{"model_key": "bad"}, 422)
}
