package httpapi_test

import (
	"fmt"
	"testing"

	"github.com/kaizenflow/api/internal/testfix"
)

// Publish phải bất biến: sau khi Publish, sửa tham số của thiết bị trong danh mục Thiết bị không
// được làm đổi đầu vào của version đã khoá (chạy lại scenario cũ phải ra đúng số cũ).
// Bản DRAFT thì ngược lại — nó đọc thiết bị trực tiếp nên thấy ngay thay đổi.
func TestPublishFreezesAssetParamsIntoTheVersion(t *testing.T) {
	a := newAPI(t)
	// Thiết bị S khai dung lượng 300 ở danh mục, sơ đồ không override gì.
	a.call("PUT", "/api/assets/S", map[string]any{
		"key": "S", "node_type": "RACK_WAREHOUSE", "name": "Kho dùng chung",
		"params": map[string]any{"stock": []any{map[string]any{"material": "RAW-01", "initial": 300, "max": 300}}},
	}, 200)

	vid := int64(a.call("POST", "/api/models", map[string]any{"model_key": "dong-cung"}, 201)["version_id"].(float64))
	nodes := graphBody()["nodes"]
	a.call("PUT", fmt.Sprintf("/api/versions/%d/graph", vid), map[string]any{"nodes": nodes, "edges": graphBody()["edges"]}, 204)

	// DRAFT: tham số đến từ thiết bị, node chưa giữ gì.
	draft := nodeOf(t, a.call("GET", fmt.Sprintf("/api/versions/%d", vid), nil, 200), "S")
	if assetParams(draft) == nil {
		t.Fatalf("bản DRAFT phải đọc tham số thiết bị, node = %v", draft)
	}

	a.call("POST", fmt.Sprintf("/api/versions/%d/publish", vid), nil, 200)

	// Đổi thiết bị sau khi Publish.
	a.call("PUT", "/api/assets/S", map[string]any{
		"key": "S", "node_type": "RACK_WAREHOUSE", "name": "Kho dùng chung",
		"params": map[string]any{"stock": []any{map[string]any{"material": "RAW-01", "initial": 999, "max": 999}}},
	}, 200)

	pub := nodeOf(t, a.call("GET", fmt.Sprintf("/api/versions/%d", vid), nil, 200), "S")
	if assetParams(pub) != nil {
		t.Fatalf("bản đã Publish không được đọc thiết bị nữa, node = %v", pub)
	}
	stock := firstStock(t, pub)
	if stock["initial"] != 300.0 || stock["max"] != 300.0 {
		t.Fatalf("tham số của bản đã Publish bị thiết bị kéo theo: %v", stock)
	}

	// Bản DRAFT mới (nhân bản) thì lấy tham số thiết bị mới nhất.
	cid := int64(a.call("POST", fmt.Sprintf("/api/versions/%d/clone", vid), nil, 201)["version_id"].(float64))
	cl := nodeOf(t, a.call("GET", fmt.Sprintf("/api/versions/%d", cid), nil, 200), "S")
	if ap := assetParams(cl); ap == nil {
		t.Fatalf("bản nhân bản (DRAFT) phải đọc thiết bị, node = %v", cl)
	}
}

func nodeOf(t *testing.T, graph map[string]any, key string) map[string]any {
	t.Helper()
	for _, raw := range graph["nodes"].([]any) {
		n := raw.(map[string]any)
		if n["key"] == key {
			return n
		}
	}
	t.Fatalf("không thấy node %s trong %v", key, graph["nodes"])
	return nil
}

func assetParams(node map[string]any) map[string]any {
	ap, ok := node["asset_params"].(map[string]any)
	if !ok || len(ap) == 0 {
		return nil
	}
	return ap
}

func firstStock(t *testing.T, node map[string]any) map[string]any {
	t.Helper()
	params, ok := node["params"].(map[string]any)
	if !ok {
		t.Fatalf("node không có params: %v", node)
	}
	list, ok := params["stock"].([]any)
	if !ok || len(list) == 0 {
		t.Fatalf("node chưa đông cứng stock: %v", params)
	}
	return list[0].(map[string]any)
}

// Danh mục tín hiệu của một thiết bị phải gồm cả thứ chỉ khai trong mô hình: vật tư của kho và
// loại xe của đội xe. Không gom thì trang Tín hiệu thiết bị trống trơn đúng ở hai loại quan trọng
// nhất (tồn kho cho câu chuyện Đỏ, và vị trí xe cho bản đồ AGV).
func TestAssetSignalsIncludeWarehouseMaterialsAndFleetKind(t *testing.T) {
	a := newAPI(t)
	vid := int64(a.call("POST", "/api/models", map[string]any{"model_key": "tin-hieu"}, 201)["version_id"].(float64))
	nodes := testfix.MiniNodes()
	for i := range nodes {
		if nodes[i].Key == "TUG" {
			nodes[i].Params = map[string]any{"kind": "AMR", "count": 2.0}
		}
		if nodes[i].Key == "S" {
			nodes[i].Params = map[string]any{"stock": []any{map[string]any{"material": "RAW-01", "initial": 10.0, "max": 100.0}}}
		}
	}
	a.call("PUT", fmt.Sprintf("/api/versions/%d/graph", vid), map[string]any{"nodes": nodes, "edges": testfix.MiniEdges()}, 204)

	signals := map[string][]string{}
	for _, raw := range a.call("GET", "/api/assets", nil, 200)["items"].([]any) {
		v := raw.(map[string]any)
		var names []string
		for _, s := range v["signals"].([]any) {
			names = append(names, s.(map[string]any)["name"].(string))
		}
		signals[v["key"].(string)] = names
	}
	if !has(signals["S"], "level:RAW-01") {
		t.Fatalf("kho phải có level:RAW-01, có %v", signals["S"])
	}
	if !has(signals["TUG"], "fleet") {
		t.Fatalf("đội xe AMR phải có tín hiệu fleet, có %v", signals["TUG"])
	}
	// Và ghép được thật, không bị chặn vì "tín hiệu không hợp lệ".
	a.call("PUT", "/api/assets/bindings", map[string]any{"bindings": []any{
		map[string]any{"subject": "S", "signal": "level:RAW-01", "source": "plc/kho/level", "json_path": "qty"},
		map[string]any{"subject": "TUG", "signal": "fleet", "source": "fms/xe"},
	}}, 200)
	// Mô hình thấy ngay cả hai ghép nối dùng chung.
	got := map[string]bool{}
	for _, raw := range a.call("GET", "/api/models/tin-hieu/bindings", nil, 200)["items"].([]any) {
		b := raw.(map[string]any)
		got[b["subject"].(string)+"|"+b["signal"].(string)] = true
	}
	if !got["S|level:RAW-01"] || !got["TUG|fleet"] {
		t.Fatalf("mô hình phải thấy ghép nối thiết bị, có %v", got)
	}
}

func has(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

// Ghép nối thiết bị là toàn cục và được trải ra theo các mô hình đang CHỨA thiết bị đó (qua bảng
// node). Vậy nên lưu sơ đồ phải nạp lại tập ghép nối đang hoạt động: đặt một thiết bị đã ghép nối
// sẵn lên sơ đồ thì dữ liệu của nó phải chảy vào mô hình ngay, không phải chờ khởi động lại API.
// (Đã từng sai: ghép nối lưu trước khi thiết bị có mặt trong mô hình nào thì không bao giờ áp.)
func TestPlacingADeviceOnADiagramActivatesItsBindingRightAway(t *testing.T) {
	a := newLiveAPI(t, "")
	// Ghép nối cho thiết bị TRƯỚC khi nó nằm trong mô hình nào.
	a.call("PUT", "/api/assets/S", map[string]any{"key": "S", "node_type": "RACK_WAREHOUSE"}, 200)
	a.call("PUT", "/api/assets/bindings", map[string]any{"bindings": []any{
		map[string]any{"subject": "S", "signal": "level:RAW-01", "source": "plc/kho/level", "json_path": "qty"},
	}}, 200)

	// Bản tin lúc này không áp cho đâu cả: chưa mô hình nào có thiết bị S.
	a.call("POST", "/api/ingest", map[string]any{"messages": []any{
		map[string]any{"source": "plc/kho/level", "ts": "2026-10-12T08:00:00Z", "payload": map[string]any{"qty": 11.0}},
	}}, 200)

	// Giờ đặt S lên sơ đồ của một mô hình.
	vid := int64(a.call("POST", "/api/models", map[string]any{"model_key": "dat-len-so-do"}, 201)["version_id"].(float64))
	a.call("PUT", fmt.Sprintf("/api/versions/%d/graph", vid), graphBody(), 204)

	// Bản tin tiếp theo phải vào được trạng thái live của mô hình, không cần khởi động lại gì.
	a.call("POST", "/api/ingest", map[string]any{"messages": []any{
		map[string]any{"source": "plc/kho/level", "ts": "2026-10-12T08:00:30Z", "payload": map[string]any{"qty": 42.0}},
	}}, 200)
	live := a.call("GET", "/api/models/dat-len-so-do/live", nil, 200)
	subjects, _ := live["subjects"].(map[string]any)
	s, _ := subjects["S"].(map[string]any)
	if s == nil {
		t.Fatalf("mô hình chưa thấy thiết bị S: %v", subjects)
	}
	signals, _ := s["signals"].(map[string]any)
	got, _ := signals["level:RAW-01"].(map[string]any)
	if got == nil || got["v"] != 42.0 {
		t.Fatalf("ghép nối thiết bị phải áp ngay sau khi lưu sơ đồ, got %v", signals)
	}
}
