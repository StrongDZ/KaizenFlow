package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/kaizenflow/api/internal/httpapi"
	"github.com/kaizenflow/api/internal/livesvc"
	"github.com/kaizenflow/api/internal/runs"
	"github.com/kaizenflow/api/internal/simclient"
	"github.com/kaizenflow/api/internal/simfake"
	"github.com/kaizenflow/api/internal/store"
	"github.com/kaizenflow/api/internal/testfix"
	"github.com/kaizenflow/api/internal/validate"
	"github.com/kaizenflow/api/internal/ws"
)

type liveAPI struct {
	*api
	svc   *livesvc.Service
	store *store.Store
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
	return &liveAPI{&api{t, srv, fake}, svc, st}
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
	if len(got["points"].([]any)) != 2 || got["v"].(float64) != 2 {
		t.Errorf("map = %v", got)
	}
}

func TestAgvMapLegacyUnitsAreStoredAndServedAsMeters(t *testing.T) {
	a := newLiveAPI(t, "")
	a.publishedModel("lm")
	legacy := map[string]any{"unit_m": 2, "speed_mps": 1.4,
		"points": []any{
			map[string]any{"id": "A", "x": 0, "y": 0, "kind": "station", "node_key": "S"},
			map[string]any{"id": "B", "x": 15, "y": 0, "kind": "station", "node_key": "OUT"}},
		"lanes": []any{map[string]any{"id": "L1", "from": "A", "to": "B", "capacity": 2, "path": []any{map[string]any{"x": 7, "y": 3}}}}}
	a.call("PUT", "/api/models/lm/agv-map", legacy, 204)
	got := a.call("GET", "/api/models/lm/agv-map", nil, 200)
	b := got["points"].([]any)[1].(map[string]any)
	path := got["lanes"].([]any)[0].(map[string]any)["path"].([]any)[0].(map[string]any)
	if b["x"].(float64) != 30 || path["x"].(float64) != 14 || path["y"].(float64) != 6 || got["v"].(float64) != 2 {
		t.Errorf("legacy map must come back in meters: %v", got)
	}
	if _, has := got["unit_m"]; has {
		t.Errorf("unit_m must be gone: %v", got)
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

func (a *liveAPI) bindStock() {
	a.call("PUT", "/api/models/lm/bindings", map[string]any{"bindings": []any{
		map[string]any{"subject": "S", "signal": "level:RAW-01", "source": "wms/s/stock", "json_path": "items[sku=RAW-01].qty"}}}, 200)
}

func (a *liveAPI) ingestStock(ts string, qty float64) {
	a.call("POST", "/api/ingest", map[string]any{"messages": []any{
		map[string]any{"source": "wms/s/stock", "ts": ts, "payload": map[string]any{"items": []any{map[string]any{"sku": "RAW-01", "qty": qty}}}}}}, 200)
}

func TestLiveForecastBuildsANowcastScenarioFromLiveStateAndRunsIt(t *testing.T) {
	a := newLiveAPI(t, "")
	a.publishedModel("lm")
	a.bindStock()
	// chưa có dữ liệu live → 422 kèm hướng dẫn
	if res := a.call("POST", "/api/models/lm/live/forecast", map[string]any{"horizon_s": 7200}, 422); res["issues"] == nil {
		t.Errorf("422 must explain: %v", res)
	}
	a.ingestStock("2026-10-01T08:00:00+07:00", 77)
	res := a.call("POST", "/api/models/lm/live/forecast", map[string]any{"horizon_s": 7200}, 202)
	sid := int64(res["scenario_id"].(float64))
	rid := int64(res["run_id"].(float64))
	if len(res["notes"].([]any)) == 0 {
		t.Errorf("notes = %v", res)
	}
	sc := a.call("GET", fmt.Sprintf("/api/scenarios/%d", sid), nil, 200)
	if sc["origin"] != "NOWCAST" || sc["start_state"] != "LIVE_SNAPSHOT" || sc["horizon_s"].(float64) != 7200 {
		t.Fatalf("scenario = %v", sc)
	}
	ov := sc["overrides"].([]any)[0].(map[string]any)
	stock := ov["value"].([]any)[0].(map[string]any)
	if ov["target"] != "S" || ov["path"] != "/stock" || stock["material"] != "RAW-01" || stock["initial"].(float64) != 77 {
		t.Errorf("override = %v", ov)
	}
	if sc["action"].(map[string]any)["live_snapshot"] == nil {
		t.Errorf("the snapshot must be recorded on the scenario: %v", sc["action"])
	}
	var run map[string]any
	for i := 0; i < 300; i++ {
		run = a.call("GET", fmt.Sprintf("/api/runs/%d", rid), nil, 200)
		if run["status"] == "DONE" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if run["status"] != "DONE" {
		t.Fatalf("run = %v", run)
	}
	got, err := time.Parse(time.RFC3339, run["sim_start"].(string))
	if want := time.Date(2026, 10, 1, 1, 0, 0, 0, time.UTC); err != nil || !got.Equal(want) {
		t.Errorf("the forecast starts at the live factory time %v, got %v (%v)", want, got, err)
	}
	// dự báo mới thay thế dự báo cũ: cảnh báo lệch của dự báo cũ tự đóng
	subj := "S"
	if _, err := a.store.InsertInsight(context.Background(), store.Insight{SimRunID: &rid, Kind: "DRIFT", SubjectKey: &subj, Payload: map[string]any{"metric": "level:RAW-01"}}); err != nil {
		t.Fatal(err)
	}
	a.call("POST", "/api/models/lm/live/forecast", map[string]any{"horizon_s": 3600}, 202)
	if left := a.call("GET", "/api/insights?kind=DRIFT&status=OPEN", nil, 200)["items"]; left != nil && len(left.([]any)) != 0 {
		t.Errorf("a newer forecast must close the old drift alerts: %v", left)
	}
	// lọc theo nguồn gốc scenario
	rows := a.call("GET", "/api/runs?model=lm&origin=NOWCAST", nil, 200)["items"].([]any)
	if len(rows) != 2 || rows[0].(map[string]any)["scenario_origin"] != "NOWCAST" {
		t.Errorf("rows = %v", rows)
	}
	if n := len(a.call("GET", "/api/runs?model=lm&origin=USER", nil, 200)["items"].([]any)); n != 0 {
		t.Errorf("USER rows = %d", n)
	}
}

func TestLiveForecastRejectsBadHorizonAndUnpublishedModels(t *testing.T) {
	a := newLiveAPI(t, "")
	a.publishedModel("lm")
	a.bindStock()
	a.ingestStock("2026-10-01T08:00:00+07:00", 10)
	for _, h := range []float64{0, 60, 8 * 86400} {
		a.call("POST", "/api/models/lm/live/forecast", map[string]any{"horizon_s": h}, 422)
	}
	a.call("POST", "/api/models/nope/live/forecast", map[string]any{"horizon_s": 3600}, 404)
}

func (a *liveAPI) bindTrip() {
	a.call("PUT", "/api/models/lm/bindings", map[string]any{"bindings": []any{
		map[string]any{"subject": "S>OUT", "signal": "trip_s", "source": "agv/trip/s-out", "json_path": "dur"}}}, 200)
}

func (a *liveAPI) trips(durs ...float64) {
	msgs := make([]any, len(durs))
	for i, d := range durs {
		ts := time.Date(2026, 10, 1, 8, i, 0, 0, time.UTC).Format(time.RFC3339)
		msgs[i] = map[string]any{"source": "agv/trip/s-out", "ts": ts, "payload": map[string]any{"dur": d}}
	}
	a.call("POST", "/api/ingest", map[string]any{"messages": msgs}, 200)
	if err := a.svc.Flush(context.Background()); err != nil {
		a.t.Fatal(err)
	}
}

func TestCalibrationComparesMeasuredTripsWithTheModelAndAppliesThemAsScenarios(t *testing.T) {
	a := newLiveAPI(t, "")
	a.publishedModel("lm")
	a.bindTrip()
	a.trips(100, 110, 120) // chưa đủ chuyến
	res := a.call("GET", "/api/models/lm/live/calibration", nil, 200)
	if len(res["edges"].([]any)) != 0 || len(res["waiting"].([]any)) != 1 || res["min_trips"].(float64) != 8 {
		t.Fatalf("with 3 trips the edge is still being measured: %v", res)
	}
	w := res["waiting"].([]any)[0].(map[string]any)
	if w["edge"] != "S>OUT" || w["n"].(float64) != 3 {
		t.Errorf("waiting = %v", w)
	}
	a.call("POST", "/api/models/lm/live/calibration/apply", map[string]any{"edges": []any{"S>OUT"}}, 422)

	a.trips(100, 110, 120, 130, 140, 100, 110, 120, 130, 140)
	res = a.call("GET", "/api/models/lm/live/calibration", nil, 200)
	edges := res["edges"].([]any)
	if len(edges) != 1 {
		t.Fatalf("calibration = %v", res)
	}
	e := edges[0].(map[string]any)
	if e["edge"] != "S>OUT" || e["n"].(float64) < 8 || e["suggested"].(map[string]any)["dist"] != "norm" || e["name"] == "" {
		t.Errorf("edge = %v", e)
	}
	out := a.call("POST", "/api/models/lm/live/calibration/apply", map[string]any{"edges": []any{"S>OUT"}}, 202)
	sc := a.call("GET", fmt.Sprintf("/api/scenarios/%d", int64(out["scenario_id"].(float64))), nil, 200)
	ov := sc["overrides"].([]any)[0].(map[string]any)
	if ov["target"] != "S>OUT" || ov["path"] != "/travel" || ov["value"].(map[string]any)["dist"] != "norm" || sc["origin"] != "USER" {
		t.Errorf("calibrated scenario = %v", sc)
	}
	base := a.call("GET", fmt.Sprintf("/api/scenarios/%d", int64(out["baseline_scenario_id"].(float64))), nil, 200)
	if len(base["overrides"].([]any)) != 0 || base["seed"] == nil || base["seed"] != sc["seed"] {
		t.Errorf("baseline must have no overrides and the same seed as the calibrated one: %v vs %v", base, sc)
	}
	if out["run_id"].(float64) == out["baseline_run_id"].(float64) {
		t.Errorf("two different runs expected: %v", out)
	}
	a.call("POST", "/api/models/lm/live/calibration/apply", map[string]any{"edges": []any{"NOPE"}}, 422)
}

func TestAckInsight(t *testing.T) {
	a := newLiveAPI(t, "")
	a.call("POST", "/api/insights/99999/ack", nil, 404)
}

func bindSource(a *liveAPI, model, subject, signal, source, path string) {
	a.call("PUT", "/api/models/"+model+"/bindings", map[string]any{"bindings": []any{
		map[string]any{"subject": subject, "signal": signal, "source": source, "json_path": path}}}, 200)
}

func sourcesOf(a *liveAPI, model string) map[string]map[string]any {
	out := map[string]map[string]any{}
	for _, raw := range a.call("GET", "/api/models/"+model+"/sources", nil, 200)["sources"].([]any) {
		m := raw.(map[string]any)
		out[m["source"].(string)] = m
	}
	return out
}

func TestSourcesRegistryMergesDBWithLiveStateAndSurvivesSilence(t *testing.T) {
	a := newLiveAPI(t, "")
	a.publishedModel("lm")
	bindSource(a, "lm", "SRC", "arrived", "dock/src/count", "n")
	a.call("POST", "/api/ingest", map[string]any{"model": "lm", "messages": []any{
		map[string]any{"source": "dock/src/count", "ts": "2026-10-01T08:00:00+07:00", "desc": "Cửa nhận hàng", "payload": map[string]any{"n": 4}},
		map[string]any{"source": "plc/other", "ts": "2026-10-01T08:00:00+07:00", "payload": map[string]any{"st": "RUN"}},
	}}, 200)
	if err := a.svc.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := sourcesOf(a, "lm")
	if len(got) != 2 {
		t.Fatalf("sources = %v", got)
	}
	d := got["dock/src/count"]
	if d["desc"] != "Cửa nhận hàng" || d["origin"] != "feed" || d["live"] != true || d["count"].(float64) < 1 {
		t.Fatalf("source = %v", d)
	}
	refs := d["bindings"].([]any)
	if len(refs) != 1 || refs[0].(map[string]any)["subject"] != "SRC" || refs[0].(map[string]any)["signal"] != "arrived" {
		t.Fatalf("bindings = %v", refs)
	}
	if len(got["plc/other"]["bindings"].([]any)) != 0 {
		t.Fatalf("nguồn chưa ghép: %v", got["plc/other"])
	}
	if sample := d["sample"].(map[string]any); sample["n"].(float64) != 4 {
		t.Fatalf("sample = %v", d["sample"])
	}
	// API khởi động lại hoặc feed tắt: RAM mất nguồn, danh sách vẫn còn, chỉ không còn "sống"
	a.svc.State().ClearSources()
	after := sourcesOf(a, "lm")
	if len(after) != 2 || after["dock/src/count"]["live"] != false {
		t.Fatalf("sau khi im lặng: %v", after)
	}
	if after["dock/src/count"]["sample"] == nil {
		t.Fatalf("mẫu phải còn trong DB: %v", after["dock/src/count"])
	}
	a.call("GET", "/api/models/nope/sources", nil, 404)
}

func TestAddManualSourceAndDryRunTest(t *testing.T) {
	a := newLiveAPI(t, "")
	a.publishedModel("lm")
	a.call("POST", "/api/models/lm/sources", map[string]any{"source": "", "sample": map[string]any{}}, 422)
	a.call("POST", "/api/models/lm/sources", map[string]any{"source": "dev/x/count", "desc": "Đếm tại X", "sample": map[string]any{"n": 3}}, 201)
	got := sourcesOf(a, "lm")["dev/x/count"]
	if got == nil || got["origin"] != "manual" || got["desc"] != "Đếm tại X" || got["live"] != false {
		t.Fatalf("source = %v", got)
	}
	bindSource(a, "lm", "SRC", "arrived", "dev/x/count", "n")
	res := a.call("POST", "/api/models/lm/sources/test", map[string]any{"source": "dev/x/count", "payload": map[string]any{"n": 7}}, 200)
	rs := res["readings"].([]any)
	if res["matched"].(float64) != 1 || len(rs) != 1 || rs[0].(map[string]any)["value"].(float64) != 7 || rs[0].(map[string]any)["subject"] != "SRC" {
		t.Fatalf("test result = %v", res)
	}
	// thử không ghi vào dữ liệu live
	snap := a.call("GET", "/api/models/lm/live", nil, 200)
	if subj, _ := snap["subjects"].(map[string]any); len(subj) != 0 {
		t.Fatalf("gửi thử không được ghi vào trạng thái live: %v", subj)
	}
	// giá trị 0 vẫn phải có trong kết quả (không bị omitempty nuốt)
	res = a.call("POST", "/api/models/lm/sources/test", map[string]any{"source": "dev/x/count", "payload": map[string]any{"n": 0}}, 200)
	if v, ok := res["readings"].([]any)[0].(map[string]any)["value"]; !ok || v.(float64) != 0 {
		t.Fatalf("giá trị 0 phải có mặt: %v", res)
	}
	// payload không có trường → lỗi nói rõ, không vỡ
	res = a.call("POST", "/api/models/lm/sources/test", map[string]any{"source": "dev/x/count", "payload": map[string]any{"khac": 1}}, 200)
	if len(res["errors"].([]any)) == 0 {
		t.Fatalf("thiếu trường phải báo lỗi: %v", res)
	}
}

func TestDeleteSourceAsksBeforeBreakingBindings(t *testing.T) {
	a := newLiveAPI(t, "")
	a.publishedModel("lm")
	a.call("POST", "/api/models/lm/sources", map[string]any{"source": "dev/a", "sample": map[string]any{"n": 1}}, 201)
	a.call("POST", "/api/models/lm/sources", map[string]any{"source": "dev/free", "sample": map[string]any{"n": 1}}, 201)
	bindSource(a, "lm", "SRC", "arrived", "dev/a", "n")
	// nguồn chưa ghép: xoá thẳng
	a.call("DELETE", "/api/models/lm/sources?source=dev%2Ffree", nil, 204)
	a.call("DELETE", "/api/models/lm/sources?source=dev%2Ffree", nil, 404)
	// nguồn đang được ghép: 409 kèm số ghép nối sẽ hỏng
	res := a.call("DELETE", "/api/models/lm/sources?source=dev%2Fa", nil, 409)
	if res["impact"].(map[string]any)["bindings"].(float64) != 1 {
		t.Fatalf("409 = %v", res)
	}
	if sourcesOf(a, "lm")["dev/a"] == nil {
		t.Fatal("chưa xác nhận thì nguồn phải còn")
	}
	a.call("DELETE", "/api/models/lm/sources?source=dev%2Fa&cascade=true", nil, 204)
	if sourcesOf(a, "lm")["dev/a"] != nil {
		t.Fatal("xoá cascade phải xoá nguồn")
	}
	if n := len(a.call("GET", "/api/models/lm/bindings", nil, 200)["items"].([]any)); n != 0 {
		t.Fatalf("ghép nối phụ thuộc phải bị xoá theo: %d", n)
	}
}

func putBindingsRaw(a *liveAPI, model string, list []any, want int) map[string]any {
	return a.call("PUT", "/api/models/"+model+"/bindings", map[string]any{"bindings": list}, want)
}

func derivedSum(subject, signal string, terms ...map[string]any) map[string]any {
	ts := make([]any, len(terms))
	for i, t := range terms {
		ts[i] = t
	}
	return map[string]any{"subject": subject, "signal": signal, "mode": "derived", "derive": map[string]any{"kind": "sum", "terms": ts}}
}

func term(subject, signal string, sign int) map[string]any {
	return map[string]any{"subject": subject, "signal": signal, "sign": sign}
}

func TestDerivedBindingRoundTripsAndSwitchesBackToSource(t *testing.T) {
	a := newLiveAPI(t, "")
	a.publishedModel("lm")
	bindSource(a, "lm", "SRC", "arrived", "dock/src/count", "n")
	putBindingsRaw(a, "lm", []any{derivedSum("SRC>S", "moved", term("SRC", "arrived", 1))}, 200)
	var got map[string]any
	for _, raw := range a.call("GET", "/api/models/lm/bindings", nil, 200)["items"].([]any) {
		if m := raw.(map[string]any); m["subject"] == "SRC>S" {
			got = m
		}
	}
	if got == nil || got["mode"] != "derived" || got["source"] != "" {
		t.Fatalf("binding = %v", got)
	}
	d := got["derive"].(map[string]any)
	if d["kind"] != "sum" || d["terms"].([]any)[0].(map[string]any)["subject"] != "SRC" {
		t.Fatalf("derive = %v", d)
	}
	// đổi lại sang lấy từ nguồn: công thức bị bỏ
	putBindingsRaw(a, "lm", []any{map[string]any{"subject": "SRC>S", "signal": "moved", "source": "belt/x", "json_path": "moved"}}, 200)
	for _, raw := range a.call("GET", "/api/models/lm/bindings", nil, 200)["items"].([]any) {
		if m := raw.(map[string]any); m["subject"] == "SRC>S" && (m["mode"] != "source" || m["derive"] != nil) {
			t.Fatalf("binding sau khi đổi lại = %v", m)
		}
	}
}

func TestDerivedBindingIsValidatedBeforeSaving(t *testing.T) {
	a := newLiveAPI(t, "")
	a.publishedModel("lm")
	bindSource(a, "lm", "SRC", "arrived", "dock/src/count", "n")
	msg := func(res map[string]any) string { return res["issues"].([]any)[0].(map[string]any)["message"].(string) }
	// đầu vào chưa ghép
	res := putBindingsRaw(a, "lm", []any{derivedSum("SRC>S", "moved", term("S", "level:RAW-01", 1))}, 422)
	if m := msg(res); !strings.Contains(m, "chưa có nguồn") {
		t.Fatalf("message = %q", m)
	}
	// tín hiệu không có trong sơ đồ
	res = putBindingsRaw(a, "lm", []any{derivedSum("SRC>S", "moved", term("NOPE", "arrived", 1))}, 422)
	if m := msg(res); !strings.Contains(m, "không có trong sơ đồ") {
		t.Fatalf("message = %q", m)
	}
	// vòng: hai edge tính từ nhau trong cùng một lần lưu
	res = putBindingsRaw(a, "lm", []any{
		derivedSum("SRC>S", "moved", term("S>OUT", "moved", 1)),
		derivedSum("S>OUT", "moved", term("SRC>S", "moved", 1)),
	}, 422)
	if m := msg(res); !strings.Contains(m, "vòng") {
		t.Fatalf("message = %q", m)
	}
	// thiếu công thức
	putBindingsRaw(a, "lm", []any{map[string]any{"subject": "SRC>S", "signal": "moved", "mode": "derived"}}, 422)
	// không có gì bị lưu sau các lần lỗi
	for _, raw := range a.call("GET", "/api/models/lm/bindings", nil, 200)["items"].([]any) {
		if raw.(map[string]any)["mode"] == "derived" {
			t.Fatalf("lần lưu lỗi không được để lại ghép nối tự tính: %v", raw)
		}
	}
}

func TestDerivedChainInOneSaveIsAcceptedWhenOrdered(t *testing.T) {
	a := newLiveAPI(t, "")
	a.publishedModel("lm")
	bindSource(a, "lm", "SRC", "arrived", "dock/src/count", "n")
	putBindingsRaw(a, "lm", []any{
		derivedSum("SRC>S", "moved", term("SRC", "arrived", 1)),
		derivedSum("S>OUT", "moved", term("SRC>S", "moved", 1)), // dựa vào ghép nối tự tính ngay trong lô này
	}, 200)
}

func TestLiveCheckReportsCoverageReadinessAndSuggestions(t *testing.T) {
	a := newLiveAPI(t, "")
	a.publishedModel("lm")
	a.call("GET", "/api/models/nope/live/check", nil, 404)
	bindSource(a, "lm", "SRC", "arrived", "dock/src/count", "n")
	a.call("POST", "/api/models/lm/sources", map[string]any{"source": "dock/src/count", "sample": map[string]any{"n": 5}}, 201)
	rep := a.call("GET", "/api/models/lm/live/check", nil, 200)
	sum := rep["summary"].(map[string]any)
	if sum["source"].(float64) != 1 || sum["signals"].(float64) < 5 || sum["broken"].(float64) != 0 {
		t.Fatalf("summary = %v", sum)
	}
	var moved map[string]any
	for _, raw := range rep["signals"].([]any) {
		c := raw.(map[string]any)
		if c["subject"] == "SRC>S" && c["signal"] == "moved" {
			moved = c
		}
	}
	if moved == nil || moved["status"] != "missing" {
		t.Fatalf("SRC>S moved = %v", moved)
	}
	sugg := moved["suggestions"].([]any)
	if len(sugg) != 1 {
		t.Fatalf("SRC arrived đã ghép nên phải gợi ý moved = arrived: %v", moved)
	}
	d := sugg[0].(map[string]any)["derive"].(map[string]any)
	if d["kind"] != "sum" || d["terms"].([]any)[0].(map[string]any)["signal"] != "arrived" {
		t.Fatalf("derive = %v", d)
	}
	// gợi ý áp dụng được nguyên xi: lưu rồi coi như đã tự tính
	putBindingsRaw(a, "lm", []any{map[string]any{"subject": "SRC>S", "signal": "moved", "mode": "derived", "derive": d}}, 200)
	rep = a.call("GET", "/api/models/lm/live/check", nil, 200)
	if rep["summary"].(map[string]any)["derived"].(float64) != 1 {
		t.Fatalf("summary sau khi áp dụng gợi ý = %v", rep["summary"])
	}
	live := false
	for _, raw := range rep["readiness"].([]any) {
		if r := raw.(map[string]any); r["feature"] == "live" && r["ok"] == false && len(r["missing"].([]any)) > 0 {
			live = true
		}
	}
	if !live {
		t.Fatalf("live chưa đủ tín hiệu phải báo thiếu: %v", rep["readiness"])
	}
	// trường không có trong bản tin mẫu → hỏng
	bindSource(a, "lm", "SRC", "arrived", "dock/src/count", "khong_co")
	rep = a.call("GET", "/api/models/lm/live/check", nil, 200)
	if rep["summary"].(map[string]any)["broken"].(float64) < 1 {
		t.Fatalf("trường không có trong mẫu phải báo hỏng: %v", rep["summary"])
	}
}

func TestPutBindingsCheckModeValidatesWithoutSaving(t *testing.T) {
	a := newLiveAPI(t, "")
	a.publishedModel("lm")
	bindSource(a, "lm", "SRC", "arrived", "dock/src/count", "n")
	good := derivedSum("SRC>S", "moved", term("SRC", "arrived", 1))
	res := a.call("PUT", "/api/models/lm/bindings?check=1", map[string]any{"bindings": []any{good}}, 200)
	if res["ok"] != true {
		t.Fatalf("res = %v", res)
	}
	for _, raw := range a.call("GET", "/api/models/lm/bindings", nil, 200)["items"].([]any) {
		if raw.(map[string]any)["subject"] == "SRC>S" {
			t.Fatal("chế độ kiểm tra không được lưu gì")
		}
	}
	bad := derivedSum("SRC>S", "moved", term("S", "level:RAW-01", 1)) // đầu vào chưa ghép
	res = a.call("PUT", "/api/models/lm/bindings?check=1", map[string]any{"bindings": []any{bad}}, 422)
	if msg := res["issues"].([]any)[0].(map[string]any)["message"].(string); !strings.Contains(msg, "chưa có nguồn") {
		t.Fatalf("message = %q", msg)
	}
}

func TestFleetPositionsAreFramedAndMatchedToLanesEndToEnd(t *testing.T) {
	a := newLiveAPI(t, "")
	a.publishedModel("lm")
	a.call("PUT", "/api/models/lm/agv-map", map[string]any{"v": 2, "speed_mps": 1.4,
		"points": []any{
			map[string]any{"id": "A", "x": 0, "y": 0, "kind": "station", "node_key": "S"},
			map[string]any{"id": "B", "x": 30, "y": 0, "kind": "station", "node_key": "OUT"}},
		"lanes": []any{map[string]any{"id": "L1", "from": "A", "to": "B", "capacity": 2}}}, 204)
	a.call("PUT", "/api/models/lm/bindings", map[string]any{"bindings": []any{
		map[string]any{"subject": "TUG", "signal": "fleet", "source": "agv/+/pos",
			"transform": map[string]any{"frame": map[string]any{"scale": 0.001}}}}}, 200) // hãng xe báo mm
	send := func(x, y float64) {
		a.call("POST", "/api/ingest", map[string]any{"messages": []any{
			map[string]any{"source": "agv/t1/pos", "ts": "2026-10-01T08:00:00Z", "payload": map[string]any{"id": "T1", "x": x, "y": y, "st": "MOVING"}}}}, 200)
	}
	vehicle := func() map[string]any {
		fleet := a.call("GET", "/api/models/lm/live", nil, 200)["fleet"].(map[string]any)
		return fleet["TUG"].([]any)[0].(map[string]any)
	}
	send(15000, 500) // 15 m, lệch 0,5 m khỏi làn
	if v := vehicle(); v["lane"] != "L1" || v["off_map"] != false || v["x"].(float64) != 15 || v["raw_x"].(float64) != 15000 || v["s"].(float64) != 15 {
		t.Errorf("xe phải nằm trên L1 ở 15 m: %v", v)
	}
	send(15000, 9000) // cách làn 9 m
	if v := vehicle(); v["off_map"] != true || v["lane"] != "" {
		t.Errorf("xe cách làn 9 m phải ngoài đường: %v", v)
	}
}

func TestAgvMapStoredBeforeV2IsServedInMeters(t *testing.T) {
	a := newLiveAPI(t, "")
	a.publishedModel("lm")
	raw := `{"unit_m":1.5,"speed_mps":1.2,"points":[{"id":"A","x":0,"y":0,"kind":"junction"},{"id":"B","x":20,"y":0,"kind":"junction"}],"lanes":[{"id":"L","from":"A","to":"B","capacity":1}]}`
	if err := a.store.PutAgvMap(context.Background(), "lm", json.RawMessage(raw)); err != nil { // bản lưu từ trước khi có v2
		t.Fatal(err)
	}
	got := a.call("GET", "/api/models/lm/agv-map", nil, 200)
	if got["v"].(float64) != 2 || got["points"].([]any)[1].(map[string]any)["x"].(float64) != 30 {
		t.Errorf("bản đồ lưu từ trước phải được phục vụ ở dạng v2 (mét): %v", got)
	}
	bp := a.call("GET", "/api/models/lm/live/blueprint", nil, 200)
	if bp["agv_map"].(map[string]any)["v"].(float64) != 2 {
		t.Errorf("blueprint cho feed cũng phải là v2: %v", bp["agv_map"])
	}
}
