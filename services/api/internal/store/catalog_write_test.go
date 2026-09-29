package store_test

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/kaizenflow/api/internal/catalog"
	"github.com/kaizenflow/api/internal/store"
	"github.com/kaizenflow/api/internal/testfix"
)

func TestNodeTypeWriteRules(t *testing.T) {
	st := testfix.Seeded(t, "store_nt_write")
	var lk *store.LockedError
	// có sẵn: luôn chỉ đọc
	if err := st.UpdateNodeType(ctx, "STAMP_PRESS", store.NodeTypeUpdate{Name: "X"}); !errors.As(err, &lk) {
		t.Fatalf("builtin update: %v", err)
	}
	if err := st.DeleteNodeType(ctx, "STAMP_PRESS"); !errors.As(err, &lk) {
		t.Fatalf("builtin delete: %v", err)
	}
	if err := st.UpdateNodeType(ctx, "NOPE", store.NodeTypeUpdate{Name: "X"}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown update: %v", err)
	}

	schema, _ := catalog.SchemaFor("SINK")
	if _, err := st.CreateNodeType(ctx, store.NodeType{Code: "CUST_SINK", Name: "Cust", Archetype: "SINK", ParamSchema: schema,
		DefaultParams: json.RawMessage(`{"buffer":5}`), Signals: json.RawMessage(`[{"name":"a"}]`)}); err != nil {
		t.Fatal(err)
	}
	// chưa ai dùng: sửa tự do; trường bỏ trống giữ nguyên
	if err := st.UpdateNodeType(ctx, "CUST_SINK", store.NodeTypeUpdate{Name: "Cust 2", DefaultParams: json.RawMessage(`{"buffer":9}`)}); err != nil {
		t.Fatal(err)
	}
	d, _ := st.GetNodeTypeDetail(ctx, "CUST_SINK")
	var dp map[string]any
	var sg []map[string]any
	_ = json.Unmarshal(d.DefaultParams, &dp)
	_ = json.Unmarshal(d.Signals, &sg)
	if d.Name != "Cust 2" || dp["buffer"] != 9.0 || len(sg) != 1 || d.IsBuiltin {
		t.Fatalf("after update: %+v defaults=%v signals=%v", d, dp, sg)
	}

	// version nháp dùng: vẫn sửa được nhưng chưa xoá được
	vid := newModel(t, st, "use")
	if err := st.ReplaceGraph(ctx, vid, []store.GraphNode{{Key: "K", NodeType: "CUST_SINK", Params: map[string]any{}}}, nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateNodeType(ctx, "CUST_SINK", store.NodeTypeUpdate{Name: "Cust 3"}); err != nil {
		t.Fatalf("draft use should allow edit: %v", err)
	}
	if err := st.DeleteNodeType(ctx, "CUST_SINK"); !errors.As(err, &lk) {
		t.Fatalf("delete while used: %v", err)
	}
	if usage, ok := lk.Usage.(store.NodeTypeUsage); !ok || len(usage.Versions) != 1 {
		t.Fatalf("delete usage = %#v", lk.Usage)
	}
	// version đã Publish dùng: khoá sửa
	if err := st.Publish(ctx, vid); err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateNodeType(ctx, "CUST_SINK", store.NodeTypeUpdate{Name: "Cust 4"}); !errors.As(err, &lk) {
		t.Fatalf("published use should lock edit: %v", err)
	}
	// hết người dùng thì xoá được
	if err := st.DeleteVersion(ctx, vid, false); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteNodeType(ctx, "CUST_SINK"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.GetNodeTypeDetail(ctx, "CUST_SINK"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("after delete: %v", err)
	}
}

func TestMaterialWriteRules(t *testing.T) {
	st := testfix.Seeded(t, "store_mat_write")
	seededVersion(t, st, "mat") // RAW-01 được dùng ở 2 edge và 2 node
	kg, pcs := "kg", "pcs"
	var lk *store.LockedError

	// đang dùng: tên sửa được; đơn vị khác và xoá thì không
	if err := st.UpdateMaterial(ctx, "RAW-01", "Nguyên liệu", nil); err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateMaterial(ctx, "RAW-01", "Nguyên liệu", &pcs); err != nil { // cùng đơn vị hiện tại: không phải thay đổi
		t.Fatalf("same unit: %v", err)
	}
	if err := st.UpdateMaterial(ctx, "RAW-01", "Nguyên liệu", &kg); !errors.As(err, &lk) {
		t.Fatalf("unit change while used: %v", err)
	}
	if err := st.DeleteMaterial(ctx, "RAW-01"); !errors.As(err, &lk) {
		t.Fatalf("delete while used: %v", err)
	}
	if usage, ok := lk.Usage.(map[string]int); !ok || usage["edges"] != 2 || usage["nodes"] != 2 {
		t.Fatalf("usage = %#v", lk.Usage)
	}
	if d, _ := st.GetMaterialDetail(ctx, "RAW-01"); d.Name != "Nguyên liệu" || d.Unit != "pcs" {
		t.Fatalf("detail = %+v", d)
	}

	// chưa dùng: sửa và xoá tự do
	if _, err := st.CreateMaterial(ctx, store.Material{Code: "FREE", Name: "F"}); err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateMaterial(ctx, "FREE", "F2", &kg); err != nil {
		t.Fatal(err)
	}
	if d, _ := st.GetMaterialDetail(ctx, "FREE"); d.Name != "F2" || d.Unit != "kg" {
		t.Fatalf("free detail = %+v", d)
	}
	if err := st.DeleteMaterial(ctx, "FREE"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.GetMaterialDetail(ctx, "FREE"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("after delete: %v", err)
	}

	// chỉ được tham chiếu bằng chuỗi mã trong JSON tham số node (không edge nào) vẫn là đang dùng
	if _, err := st.CreateMaterial(ctx, store.Material{Code: "JSON_ONLY", Name: "J"}); err != nil {
		t.Fatal(err)
	}
	vid := newModel(t, st, "jsononly")
	nodes := []store.GraphNode{{Key: "D", NodeType: "SHIP_DOCK", Params: map[string]any{
		"demand": []any{map[string]any{"kind": "TAKT", "material": "JSON_ONLY", "takt": 60.0}}}}}
	if err := st.ReplaceGraph(ctx, vid, nodes, nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteMaterial(ctx, "JSON_ONLY"); !errors.As(err, &lk) {
		t.Fatalf("json-only reference must block delete: %v", err)
	}
	if usage := lk.Usage.(map[string]int); usage["nodes"] != 1 || usage["edges"] != 0 {
		t.Fatalf("json-only usage = %v", usage)
	}

	if err := st.UpdateMaterial(ctx, "NOPE", "x", nil); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown update: %v", err)
	}
	if err := st.DeleteMaterial(ctx, "NOPE"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown delete: %v", err)
	}
}
