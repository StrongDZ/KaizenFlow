package httpapi_test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/kaizenflow/api/internal/simapi"
	"github.com/kaizenflow/api/internal/testfix"
)

func codes(rep map[string]any) map[string]string {
	out := map[string]string{}
	for _, raw := range rep["issues"].([]any) {
		i := raw.(map[string]any)
		out[i["code"].(string)+"|"+i["key"].(string)] = i["severity"].(string)
	}
	return out
}

func draftModel(a *api, key string) int64 {
	vid := int64(a.call("POST", "/api/models", map[string]any{"model_key": key}, 201)["version_id"].(float64))
	a.call("PUT", fmt.Sprintf("/api/versions/%d/graph", vid), graphBody(), 204)
	return vid
}

func TestCheckSavedGraph(t *testing.T) {
	a := newAPI(t)
	vid := draftModel(a, "chk-saved")
	rep := a.call("POST", fmt.Sprintf("/api/versions/%d/check", vid), nil, 200)
	if rep["ok"] != true {
		t.Fatalf("bản mini không có lỗi: %v", rep)
	}
	if got := codes(rep)["storage_no_stock|S"]; got != "warning" {
		t.Fatalf("kho S phải có cảnh báo storage_no_stock: %v", codes(rep))
	}
	if rep["inferred"] == nil {
		t.Fatalf("thiếu inferred: %v", rep)
	}
}

func TestCheckEmptyJSONObjectMeansSavedGraph(t *testing.T) {
	a := newAPI(t)
	vid := draftModel(a, "chk-empty-body")
	rep := a.call("POST", fmt.Sprintf("/api/versions/%d/check", vid), map[string]any{}, 200)
	if rep["ok"] != true {
		t.Fatalf("thân {} phải kiểm bản đã lưu, không phải sơ đồ trống: %v", rep)
	}
}

func TestCheckDraftBodyDoesNotTouchSavedGraph(t *testing.T) {
	a := newAPI(t)
	vid := draftModel(a, "chk-draft")
	body := map[string]any{"nodes": []any{}, "edges": []any{}}
	rep := a.call("POST", fmt.Sprintf("/api/versions/%d/check", vid), body, 200)
	if rep["ok"] != false {
		t.Fatalf("sơ đồ trống phải có lỗi: %v", rep)
	}
	c := codes(rep)
	if c["no_source|model"] != "error" || c["no_sink|model"] != "error" {
		t.Fatalf("codes = %v", c)
	}
	g := a.call("GET", fmt.Sprintf("/api/versions/%d", vid), nil, 200)
	if len(g["nodes"].([]any)) != 4 {
		t.Fatalf("kiểm nháp không được ghi đè bản đã lưu: %v", g["nodes"])
	}
}

func TestCheckUnknownMaterialAndUnknownVersion(t *testing.T) {
	a := newAPI(t)
	vid := draftModel(a, "chk-mat")
	body := graphBody()
	bad := map[string]any{"nodes": body["nodes"], "edges": []map[string]any{
		{"key": "SRC>S", "src": "SRC", "dst": "S", "material": "RAW01", "params": map[string]any{}},
		{"key": "S>OUT", "src": "S", "dst": "OUT", "material": "RAW-01", "params": map[string]any{}},
	}}
	rep := a.call("POST", fmt.Sprintf("/api/versions/%d/check", vid), bad, 200)
	if codes(rep)["material_unknown|SRC>S"] != "error" {
		t.Fatalf("codes = %v", codes(rep))
	}
	a.call("POST", "/api/versions/99999/check", nil, 404)
}

func TestCheckDeepAsksSim(t *testing.T) {
	a := newAPI(t)
	vid := draftModel(a, "chk-deep")
	if rep := a.call("POST", fmt.Sprintf("/api/versions/%d/check?deep=1", vid), nil, 200); rep["ok"] != true {
		t.Fatalf("deep hợp lệ: %v", rep)
	}
	a.fake.ValidateErr = &simapi.ContractError{Key: "S>OUT", Message: "lô quá lớn"}
	rep := a.call("POST", fmt.Sprintf("/api/versions/%d/check?deep=1", vid), nil, 200)
	if rep["ok"] != false || codes(rep)["sim_rejected|S>OUT"] != "error" {
		t.Fatalf("deep phải đưa lỗi của sim lên: %v", rep)
	}
	// chế độ nhanh không gọi sim
	if rep := a.call("POST", fmt.Sprintf("/api/versions/%d/check", vid), nil, 200); rep["ok"] != true {
		t.Fatalf("chế độ nhanh không hỏi sim: %v", rep)
	}
}

func TestPublishBlockedByUnknownMaterialWithVietnameseIssues(t *testing.T) {
	a := newAPI(t)
	vid := int64(a.call("POST", "/api/models", map[string]any{"model_key": "chk-pub"}, 201)["version_id"].(float64))
	bad := graphBody()
	nodes := testfix.MiniNodes()
	nodes[0].Params = map[string]any{"arrivals": map[string]any{"interarrival": 60.0},
		"lots": []any{map[string]any{"material": "RAW01", "qty": 10.0}}} // vật tư gõ sai trong tham số node
	bad["nodes"] = nodes
	a.call("PUT", fmt.Sprintf("/api/versions/%d/graph", vid), bad, 204)
	resp := a.call("POST", fmt.Sprintf("/api/versions/%d/publish", vid), nil, 422)
	list := resp["issues"].([]any)
	if len(list) == 0 {
		t.Fatalf("issues rỗng: %v", resp)
	}
	first := list[0].(map[string]any)
	if first["code"] != "material_unknown" || first["severity"] != "error" || first["key"] != "SRC" {
		t.Fatalf("issue đầu = %v", first)
	}
	for _, raw := range list {
		if raw.(map[string]any)["severity"] == "warning" {
			t.Fatalf("Publish chỉ trả lỗi, không trả cảnh báo: %v", list)
		}
	}
}

func TestSaveRejectsUnknownEdgeMaterialInVietnamese(t *testing.T) {
	a := newAPI(t)
	vid := int64(a.call("POST", "/api/models", map[string]any{"model_key": "chk-save"}, 201)["version_id"].(float64))
	bad := graphBody()
	bad["edges"] = []map[string]any{{"key": "SRC>S", "src": "SRC", "dst": "S", "material": "RAW01", "params": map[string]any{}}}
	resp := a.call("PUT", fmt.Sprintf("/api/versions/%d/graph", vid), bad, 422)
	msg := resp["issues"].([]any)[0].(map[string]any)["message"].(string)
	if !strings.Contains(msg, "Thư viện") {
		t.Fatalf("thông điệp lưu phải bằng tiếng Việt: %q", msg)
	}
}

func TestCreateModelCanCopyTheLatestGraphOfAnotherModel(t *testing.T) {
	a := newAPI(t)
	src := draftModel(a, "goc")
	vid := int64(a.call("POST", "/api/models", map[string]any{"model_key": "ban-sao", "copy_from": "goc"}, 201)["version_id"].(float64))
	g := a.call("GET", fmt.Sprintf("/api/versions/%d", vid), nil, 200)
	if len(g["nodes"].([]any)) != 4 || len(g["edges"].([]any)) != 2 || g["status"] != "DRAFT" || g["version"].(float64) != 1 {
		t.Fatalf("bản sao = nodes %v edges %v status %v", len(g["nodes"].([]any)), len(g["edges"].([]any)), g["status"])
	}
	orig := a.call("GET", fmt.Sprintf("/api/versions/%d", src), nil, 200)
	if len(orig["nodes"].([]any)) != 4 {
		t.Fatalf("mô hình gốc không được đổi: %v", orig["nodes"])
	}
	// nguồn không tồn tại: báo rõ và không để lại mô hình rỗng
	res := a.call("POST", "/api/models", map[string]any{"model_key": "ma-mo-coi", "copy_from": "khong-co"}, 422)
	if msg := res["issues"].([]any)[0].(map[string]any)["message"].(string); !strings.Contains(msg, "khong-co") {
		t.Fatalf("message = %q", msg)
	}
	models := a.call("GET", "/api/models", nil, 200)["items"]
	for _, m := range models.([]any) {
		if m.(map[string]any)["model_key"] == "ma-mo-coi" {
			t.Fatal("không được để lại mô hình rỗng khi sao chép lỗi")
		}
	}
}
