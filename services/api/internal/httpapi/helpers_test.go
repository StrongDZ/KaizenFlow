package httpapi_test

import (
	"fmt"
	"time"
)

// publishedModel tạo mô hình mini đã Publish và trả version id.
func (a *api) publishedModel(key string) int64 {
	a.t.Helper()
	vid := int64(a.call("POST", "/api/models", map[string]any{"model_key": key}, 201)["version_id"].(float64))
	a.call("PUT", fmt.Sprintf("/api/versions/%d/graph", vid), graphBody(), 204)
	a.call("POST", fmt.Sprintf("/api/versions/%d/publish", vid), nil, 200)
	return vid
}

// doneRun tạo scenario, chạy và đợi run DONE.
func (a *api) doneRun(vid int64, name string) (sid, rid int64) {
	a.t.Helper()
	sid = int64(a.call("POST", "/api/scenarios", map[string]any{"model_version_id": vid, "name": name,
		"horizon_s": 3600, "replications": 2}, 201)["id"].(float64))
	rid = int64(a.call("POST", fmt.Sprintf("/api/scenarios/%d/runs", sid),
		map[string]any{"sim_start": "2026-10-01T08:00:00+07:00"}, 202)["run_id"].(float64))
	for i := 0; i < 300; i++ {
		if a.call("GET", fmt.Sprintf("/api/runs/%d", rid), nil, 200)["status"] == "DONE" {
			return sid, rid
		}
		time.Sleep(10 * time.Millisecond)
	}
	a.t.Fatalf("run %d chưa xong", rid)
	return 0, 0
}
