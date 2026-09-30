package httpapi_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/kaizenflow/api/internal/httpapi"
	"github.com/kaizenflow/api/internal/livesvc"
	"github.com/kaizenflow/api/internal/runs"
	"github.com/kaizenflow/api/internal/simclient"
	"github.com/kaizenflow/api/internal/simfake"
	"github.com/kaizenflow/api/internal/testfix"
	"github.com/kaizenflow/api/internal/validate"
	"github.com/kaizenflow/api/internal/ws"
)

type liveAPI struct {
	*api
	svc *livesvc.Service
}

func newLiveAPI(t *testing.T, feedURL string) *liveAPI {
	st := testfix.Seeded(t, "httpapi_live")
	fake := simfake.New()
	t.Cleanup(fake.Close)
	sim := simclient.New(fake.URL)
	hub := ws.NewHub()
	svc := livesvc.New(st, hub)
	h := httpapi.New(httpapi.Deps{Store: st, Sim: sim, Hub: hub, Validator: validate.New(), Live: svc, FeedURL: feedURL,
		Runs: &runs.Service{Store: st, Sim: sim, Hub: hub, Poll: 10 * time.Millisecond}})
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &liveAPI{&api{t, srv, fake}, svc}
}

// publishedModel tạo mô hình có graph mini đã Publish, trả id version.
func (a *liveAPI) publishedModel(key string) int64 {
	vid := int64(a.call("POST", "/api/models", map[string]any{"model_key": key}, 201)["version_id"].(float64))
	a.call("PUT", fmt.Sprintf("/api/versions/%d/graph", vid), graphBody(), 204)
	a.call("POST", fmt.Sprintf("/api/versions/%d/publish", vid), nil, 200)
	return vid
}

func TestLiveSubjectsListNodesAndEdgesWithSignals(t *testing.T) {
	a := newLiveAPI(t, "")
	a.publishedModel("lm")
	res := a.call("GET", "/api/models/lm/live/subjects", nil, 200)
	subs := res["subjects"].([]any)
	byKey := map[string]map[string]any{}
	for _, s := range subs {
		m := s.(map[string]any)
		byKey[m["subject"].(string)] = m
	}
	if byKey["SRC"] == nil || byKey["S>OUT"] == nil || byKey["TUG"] == nil {
		t.Fatalf("subjects = %v", byKey)
	}
	has := func(sub map[string]any, signal string) bool {
		for _, s := range sub["signals"].([]any) {
			if s.(map[string]any)["name"] == signal {
				return true
			}
		}
		return false
	}
	if !has(byKey["S>OUT"], "trip_s") || has(byKey["SRC>S"], "trip_s") {
		t.Errorf("trip_s must exist only on POOL edges: %v / %v", byKey["S>OUT"], byKey["SRC>S"])
	}
	if !has(byKey["TUG"], "fleet") {
		t.Errorf("tugger pool should offer fleet: %v", byKey["TUG"])
	}
	a.call("GET", "/api/models/nope/live/subjects", nil, 404)
}

func TestBindingsValidateAgainstTheGraph(t *testing.T) {
	a := newLiveAPI(t, "")
	a.publishedModel("lm")
	bad := func(subject, signal string) {
		a.call("PUT", "/api/models/lm/bindings", map[string]any{"bindings": []any{
			map[string]any{"subject": subject, "signal": signal, "source": "s", "json_path": "x"}}}, 422)
	}
	bad("NOPE", "state")       // node không có
	bad("SRC", "level:RAW-01") // tín hiệu không hợp lệ cho nguồn
	bad("SRC>S", "trip_s")     // edge chạy trực tiếp không có thời gian chuyến
	a.call("PUT", "/api/models/nope/bindings", map[string]any{"bindings": []any{}}, 404)
}

func TestIngestFlowsThroughBindingsToLiveStateAndDB(t *testing.T) {
	a := newLiveAPI(t, "")
	a.publishedModel("lm")
	a.call("PUT", "/api/models/lm/bindings", map[string]any{"bindings": []any{
		map[string]any{"subject": "S", "signal": "level:RAW-01", "source": "wms/wh-a/stock", "json_path": "items[sku=RAW-01].qty"},
		map[string]any{"subject": "SRC", "signal": "arrived", "source": "dock/src/count", "json_path": "n",
			"transform": map[string]any{"scale": 3}},
	}}, 200)
	if n := len(a.call("GET", "/api/models/lm/bindings", nil, 200)["items"].([]any)); n != 2 {
		t.Fatalf("bindings = %d", n)
	}
	res := a.call("POST", "/api/ingest", map[string]any{"messages": []any{
		map[string]any{"source": "wms/wh-a/stock", "ts": "2026-10-01T08:00:00+07:00", "desc": "Kho A",
			"payload": map[string]any{"items": []any{map[string]any{"sku": "RAW-01", "qty": 320}}}},
		map[string]any{"source": "dock/src/count", "ts": "2026-10-01T08:00:00+07:00", "payload": map[string]any{"n": 10}},
		map[string]any{"source": "", "ts": "2026-10-01T08:00:00+07:00"},
	}}, 200)
	if res["accepted"].(float64) != 2 || res["rejected"].(float64) != 1 || res["readings"].(float64) != 2 {
		t.Fatalf("ingest result = %v", res)
	}
	snap := a.call("GET", "/api/models/lm/live", nil, 200)
	subj := snap["subjects"].(map[string]any)
	if subj["S"].(map[string]any)["signals"].(map[string]any)["level:RAW-01"].(map[string]any)["v"].(float64) != 320 {
		t.Errorf("level not applied: %v", subj["S"])
	}
	if subj["SRC"].(map[string]any)["signals"].(map[string]any)["arrived"].(map[string]any)["v"].(float64) != 30 {
		t.Errorf("scale not applied: %v", subj["SRC"])
	}
	if len(snap["sources"].([]any)) != 2 || snap["bindings"].(float64) != 2 {
		t.Errorf("sources/bindings wrong: %v", snap)
	}
	if err := a.svc.Flush(t.Context()); err != nil {
		t.Fatal(err)
	}
	sigs := a.call("GET", "/api/models/lm/live/signals?subject=S&name=level:RAW-01", nil, 200)["items"].([]any)
	if len(sigs) != 1 || sigs[0].(map[string]any)["value"].(float64) != 320 {
		t.Errorf("signals = %v", sigs)
	}
	a.call("DELETE", "/api/models/lm/live", nil, 204)
	if len(a.call("GET", "/api/models/lm/live", nil, 200)["subjects"].(map[string]any)) != 0 {
		t.Error("live state not cleared")
	}
	if sigs := a.call("GET", "/api/models/lm/live/signals?subject=S", nil, 200)["items"]; sigs != nil && len(sigs.([]any)) != 0 {
		t.Errorf("live rows not cleared: %v", sigs)
	}
}

func TestBindingDeleteReloadsIngest(t *testing.T) {
	a := newLiveAPI(t, "")
	a.publishedModel("lm")
	a.call("PUT", "/api/models/lm/bindings", map[string]any{"bindings": []any{
		map[string]any{"subject": "S", "signal": "level:RAW-01", "source": "x", "json_path": "v"}}}, 200)
	list := a.call("GET", "/api/models/lm/bindings", nil, 200)["items"].([]any)
	id := int64(list[0].(map[string]any)["id"].(float64))
	a.call("DELETE", fmt.Sprintf("/api/models/lm/bindings/%d", id), nil, 204)
	a.call("DELETE", fmt.Sprintf("/api/models/lm/bindings/%d", id), nil, 404)
	res := a.call("POST", "/api/ingest", map[string]any{"messages": []any{
		map[string]any{"source": "x", "ts": "2026-10-01T08:00:00Z", "payload": map[string]any{"v": 1}}}}, 200)
	if res["readings"].(float64) != 0 {
		t.Errorf("deleted binding still applied: %v", res)
	}
}

func TestAgvMapValidationAndRoundTrip(t *testing.T) {
	a := newLiveAPI(t, "")
	a.publishedModel("lm")
	a.call("GET", "/api/models/lm/agv-map", nil, 404)
	bad := map[string]any{"speed_mps": 1.4, "points": []any{map[string]any{"id": "A", "x": 0, "y": 0, "kind": "station", "node_key": "NOPE"}}, "lanes": []any{}}
	a.call("PUT", "/api/models/lm/agv-map", bad, 422)
	good := map[string]any{"speed_mps": 1.4,
		"points": []any{
			map[string]any{"id": "A", "x": 0, "y": 0, "kind": "station", "node_key": "S"},
			map[string]any{"id": "B", "x": 30, "y": 0, "kind": "station", "node_key": "OUT"}},
		"lanes": []any{map[string]any{"id": "L1", "from": "A", "to": "B", "capacity": 2}}}
	a.call("PUT", "/api/models/lm/agv-map", good, 204)
	got := a.call("GET", "/api/models/lm/agv-map", nil, 200)
	if len(got["points"].([]any)) != 2 || got["unit_m"].(float64) != 1 {
		t.Errorf("map = %v", got)
	}
}

func TestBlueprintGivesFeedTheResolvedRequestAndMap(t *testing.T) {
	a := newLiveAPI(t, "")
	a.call("GET", "/api/models/nope/live/blueprint", nil, 404)
	vid := int64(a.call("POST", "/api/models", map[string]any{"model_key": "draft"}, 201)["version_id"].(float64))
	a.call("PUT", fmt.Sprintf("/api/versions/%d/graph", vid), graphBody(), 204)
	a.call("GET", "/api/models/draft/live/blueprint", nil, 409) // chưa Publish
	a.publishedModel("lm")
	a.call("PUT", "/api/models/lm/agv-map", map[string]any{"speed_mps": 1.4, "points": []any{}, "lanes": []any{}}, 204)
	bp := a.call("GET", "/api/models/lm/live/blueprint", nil, 200)
	req := bp["run_request"].(map[string]any)
	if len(req["nodes"].([]any)) != 3 || len(req["pools"].([]any)) != 1 || len(req["edges"].([]any)) != 2 {
		t.Errorf("run_request = %v", req)
	}
	if bp["names"].(map[string]any)["SRC"] == "" || bp["agv_map"] == nil || bp["model"] != "lm" {
		t.Errorf("blueprint = %v", bp)
	}
}

func TestFeedProxyForwardsAndReportsMissingFeed(t *testing.T) {
	feed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"path":%q,"method":%q}`, r.URL.Path, r.Method)
	}))
	defer feed.Close()
	a := newLiveAPI(t, feed.URL)
	got := a.call("POST", "/api/feed/incidents", map[string]any{"kind": "machine_down"}, 200)
	if got["path"] != "/incidents" || got["method"] != "POST" {
		t.Errorf("proxied = %v", got)
	}
	down := newLiveAPI(t, "http://127.0.0.1:1")
	if res := down.call("GET", "/api/feed/status", nil, 502); res["error"] == nil {
		t.Errorf("502 must explain: %v", res)
	}
	none := newLiveAPI(t, "")
	none.call("GET", "/api/feed/status", nil, 503)
}
