package httpapi_test

import (
	"fmt"
	"testing"
	"time"
)

func mustMap(t *testing.T, v any) map[string]any {
	t.Helper()
	m, ok := v.(map[string]any)
	if !ok {
		t.Fatalf("not an object: %v", v)
	}
	return m
}

func TestCascadeDeleteProtocolOverHTTP(t *testing.T) {
	a := newAPI(t)
	vid := a.publishedModel("denso-mini")
	sid, rid := a.doneRun(vid, "Ca sáng")

	// có run: bước 1 trả 409 kèm impact, chưa xoá gì
	res := a.call("DELETE", fmt.Sprintf("/api/scenarios/%d", sid), nil, 409)
	if impact := mustMap(t, res["impact"]); impact["runs"] != 1.0 {
		t.Fatalf("impact = %v", res)
	}
	a.call("GET", fmt.Sprintf("/api/scenarios/%d", sid), nil, 200)

	// xoá run riêng lẻ → 204, sau đó GET 404
	a.call("DELETE", fmt.Sprintf("/api/runs/%d", rid), nil, 204)
	a.call("GET", fmt.Sprintf("/api/runs/%d", rid), nil, 404)
	a.call("DELETE", fmt.Sprintf("/api/runs/%d", rid), nil, 404)
	// hết run: scenario xoá luôn
	a.call("DELETE", fmt.Sprintf("/api/scenarios/%d", sid), nil, 204)

	// phiên bản có scenario + run: 409 rồi cascade
	vid2 := a.publishedModel("beta")
	a.doneRun(vid2, "Ca tối")
	res = a.call("DELETE", fmt.Sprintf("/api/versions/%d", vid2), nil, 409)
	if impact := mustMap(t, res["impact"]); impact["scenarios"] != 1.0 || impact["runs"] != 1.0 {
		t.Fatalf("version impact = %v", res)
	}
	a.call("DELETE", fmt.Sprintf("/api/versions/%d?cascade=true", vid2), nil, 204)
	a.call("GET", fmt.Sprintf("/api/versions/%d", vid2), nil, 404)

	// mô hình còn một version không scenario: xoá luôn; không tồn tại: 404
	a.call("DELETE", "/api/models/denso-mini", nil, 204)
	a.call("DELETE", "/api/models/denso-mini", nil, 404)
	if items, ok := a.call("GET", "/api/models", nil, 200)["items"].([]any); !ok || len(items) != 0 {
		t.Fatalf("models left: %v", items)
	}
}

func TestDeleteIsRefusedWhileARunIsActive(t *testing.T) {
	a := newAPI(t)
	vid := a.publishedModel("denso-mini")
	sid := int64(a.call("POST", "/api/scenarios", map[string]any{"model_version_id": vid, "name": "x",
		"horizon_s": 3600, "replications": 2}, 201)["id"].(float64))
	a.fake.Hold = true
	rid := int64(a.call("POST", fmt.Sprintf("/api/scenarios/%d/runs", sid),
		map[string]any{"sim_start": "2026-10-01T08:00:00+07:00"}, 202)["run_id"].(float64))

	a.call("DELETE", fmt.Sprintf("/api/runs/%d", rid), nil, 409)
	a.call("DELETE", fmt.Sprintf("/api/scenarios/%d?cascade=true", sid), nil, 409)
	a.call("DELETE", fmt.Sprintf("/api/versions/%d?cascade=true", vid), nil, 409)
	a.call("GET", fmt.Sprintf("/api/scenarios/%d", sid), nil, 200)

	a.fake.Hold = false
	for i := 0; i < 300; i++ {
		if a.call("GET", fmt.Sprintf("/api/runs/%d", rid), nil, 200)["status"] == "DONE" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	a.call("DELETE", fmt.Sprintf("/api/runs/%d", rid), nil, 204)
}

func TestScenarioEditAndCloneOverHTTP(t *testing.T) {
	a := newAPI(t)
	vid := a.publishedModel("denso-mini")
	sid := int64(a.call("POST", "/api/scenarios", map[string]any{"model_version_id": vid, "name": "cũ", "horizon_s": 3600}, 201)["id"].(float64))
	a.call("PUT", fmt.Sprintf("/api/scenarios/%d", sid), map[string]any{"name": "mới", "horizon_s": 7200, "replications": 5}, 204)
	if sc := a.call("GET", fmt.Sprintf("/api/scenarios/%d", sid), nil, 200); sc["name"] != "mới" || sc["horizon_s"].(float64) != 7200 {
		t.Fatalf("after edit = %v", sc)
	}
	a.call("PUT", fmt.Sprintf("/api/scenarios/%d", sid), map[string]any{"name": "lỗi", "horizon_s": 0}, 422)
	a.call("PUT", "/api/scenarios/999999", map[string]any{"name": "x", "horizon_s": 60}, 404)

	cid := int64(a.call("POST", fmt.Sprintf("/api/scenarios/%d/clone", sid), nil, 201)["id"].(float64))
	if cid == sid {
		t.Fatal("clone returned the same id")
	}
	if c := a.call("GET", fmt.Sprintf("/api/scenarios/%d", cid), nil, 200); c["name"] != "mới (bản sao)" || c["origin"] != "USER" {
		t.Fatalf("clone = %v", c)
	}
	a.call("POST", "/api/scenarios/999999/clone", nil, 404)

	// có run thì khoá sửa
	a.call("POST", fmt.Sprintf("/api/scenarios/%d/runs", sid), map[string]any{"sim_start": "2026-10-01T08:00:00+07:00"}, 202)
	res := a.call("PUT", fmt.Sprintf("/api/scenarios/%d", sid), map[string]any{"name": "lại", "horizon_s": 60}, 409)
	if res["locked"] != true {
		t.Fatalf("locked body = %v", res)
	}
}

func TestNodeTypeAndMaterialWritesOverHTTP(t *testing.T) {
	a := newAPI(t)
	a.publishedModel("denso-mini")

	// có sẵn: khoá
	a.call("PUT", "/api/node-types/STAMP_PRESS", map[string]any{"name": "X"}, 409)
	a.call("DELETE", "/api/node-types/STAMP_PRESS", nil, 409)
	a.call("PUT", "/api/node-types/NOPE", map[string]any{"name": "X"}, 404)

	// tạo node type: default_params sai kiểu bị từ chối (R14), đúng thì tạo được
	bad := map[string]any{"code": "CUST_SINK", "name": "Cust", "archetype": "SINK", "default_params": map[string]any{"buffer": -1}}
	res := a.call("POST", "/api/node-types", bad, 422)
	if res["issues"].([]any)[0].(map[string]any)["key"] != "default_params" {
		t.Fatalf("create issues = %v", res)
	}
	ok := map[string]any{"code": "CUST_SINK", "name": "Cust", "archetype": "SINK", "default_params": map[string]any{"buffer": 5}}
	a.call("POST", "/api/node-types", ok, 201)
	a.call("PUT", "/api/node-types/CUST_SINK", map[string]any{"name": "Cust 2", "default_params": map[string]any{"buffer": -5}}, 422)
	a.call("PUT", "/api/node-types/CUST_SINK", map[string]any{"name": "Cust 2", "signals": "không phải mảng"}, 422)
	a.call("PUT", "/api/node-types/CUST_SINK", map[string]any{"name": ""}, 422)
	a.call("PUT", "/api/node-types/CUST_SINK", map[string]any{"name": "Cust 2", "default_params": map[string]any{"buffer": 9}}, 204)
	if d := a.call("GET", "/api/node-types/CUST_SINK", nil, 200); d["name"] != "Cust 2" {
		t.Fatalf("detail = %v", d)
	}
	a.call("DELETE", "/api/node-types/CUST_SINK", nil, 204)
	a.call("GET", "/api/node-types/CUST_SINK", nil, 404)

	// vật tư: đang dùng thì tên sửa được, đơn vị và xoá thì bị khoá
	a.call("PUT", "/api/materials/RAW-01", map[string]any{"name": "Nguyên liệu"}, 204)
	res = a.call("PUT", "/api/materials/RAW-01", map[string]any{"name": "Nguyên liệu", "unit": "kg"}, 409)
	if res["locked"] != true {
		t.Fatalf("material lock body = %v", res)
	}
	a.call("DELETE", "/api/materials/RAW-01", nil, 409)
	a.call("POST", "/api/materials", map[string]any{"code": "FREE", "name": "F"}, 201)
	a.call("PUT", "/api/materials/FREE", map[string]any{"name": "F2", "unit": "kg"}, 204)
	a.call("DELETE", "/api/materials/FREE", nil, 204)
	a.call("DELETE", "/api/materials/FREE", nil, 404)
}
