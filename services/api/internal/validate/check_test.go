package validate_test

import (
	"strings"
	"testing"

	"github.com/kaizenflow/api/internal/store"
	"github.com/kaizenflow/api/internal/testfix"
	"github.com/kaizenflow/api/internal/validate"
)

var libMaterials = []string{"RAW-01", "PART", "SUB_OK", "SUB_NG", "BOX"}

func check(g *store.Graph, mats []string) validate.Report {
	return validate.New().Check(validate.CheckInput{Graph: g, Types: testfix.Types(), Materials: mats})
}

func find(t *testing.T, r validate.Report, code, key string) validate.Issue {
	t.Helper()
	for _, i := range r.Issues {
		if i.Code == code && (key == "" || i.Key == key) {
			return i
		}
	}
	t.Fatalf("không có luật %s (key %q) trong %+v", code, key, r.Issues)
	return validate.Issue{}
}

func absent(t *testing.T, r validate.Report, code string) {
	t.Helper()
	for _, i := range r.Issues {
		if i.Code == code {
			t.Fatalf("không được báo %s: %+v", code, i)
		}
	}
}

func TestMiniGraphHasNoErrors(t *testing.T) {
	r := check(testfix.MiniGraph(), libMaterials)
	if !r.OK {
		t.Fatalf("OK = false, issues = %+v", r.Issues)
	}
	for _, i := range r.Issues {
		if i.Severity == validate.SevError {
			t.Fatalf("lỗi ngoài ý muốn: %+v", i)
		}
	}
}

func TestSeverityAndOKSemantics(t *testing.T) {
	g := testfix.MiniGraph() // kho S chưa khai báo vật tư: chỉ là cảnh báo
	r := check(g, libMaterials)
	w := find(t, r, "storage_no_stock", "S")
	if w.Severity != validate.SevWarning {
		t.Fatalf("storage_no_stock phải là cảnh báo: %+v", w)
	}
	if !r.OK {
		t.Fatal("cảnh báo không được làm OK=false")
	}
	g.Nodes = g.Nodes[1:2]
	g.Edges = nil
	r = check(g, libMaterials)
	if r.OK {
		t.Fatal("thiếu Nguồn và Đích phải là lỗi")
	}
}

func TestNeedsSourceAndSinkMessagesAreVietnamese(t *testing.T) {
	g := testfix.MiniGraph()
	g.Nodes = g.Nodes[1:2]
	g.Edges = nil
	r := check(g, libMaterials)
	src := find(t, r, "no_source", "model")
	find(t, r, "no_sink", "model")
	if !strings.Contains(src.Message, "Nguồn") {
		t.Fatalf("thông điệp phải bằng tiếng Việt: %q", src.Message)
	}
}

func TestMaterialUnknownWithSuggestion(t *testing.T) {
	g := testfix.MiniGraph()
	g.Edges[0].Material = "RAW01"
	i := find(t, check(g, libMaterials), "material_unknown", "SRC>S")
	if !strings.Contains(i.Message, "RAW01") || !strings.Contains(i.Message, "RAW-01") {
		t.Fatalf("phải nêu mã sai và gợi ý đúng: %q", i.Message)
	}
	if i.Severity != validate.SevError {
		t.Fatalf("severity = %q", i.Severity)
	}
}

func TestMaterialUnknownInNodeParams(t *testing.T) {
	g := testfix.MiniGraph()
	g.Nodes[0].Params = map[string]any{"lots": []any{map[string]any{"material": "ZZZ-99", "qty": 10.0}}}
	i := find(t, check(g, libMaterials), "material_unknown", "SRC")
	if !strings.Contains(i.Message, "ZZZ-99") {
		t.Fatalf("thông điệp: %q", i.Message)
	}
	if strings.Contains(i.Message, "Có phải ý bạn") {
		t.Fatalf("không có mã gần giống thì không được gợi ý bừa: %q", i.Message)
	}
}

func TestMaterialCheckSkippedWhenLibraryUnknown(t *testing.T) {
	g := testfix.MiniGraph()
	g.Edges[0].Material = "RAW01"
	absent(t, check(g, nil), "material_unknown")
}

func TestMaterialUnknownReportedOncePerNodeAndCode(t *testing.T) {
	g := testfix.MiniGraph()
	g.Nodes[0].Params = map[string]any{"lots": []any{
		map[string]any{"material": "ZZZ", "qty": 1.0}, map[string]any{"material": "ZZZ", "qty": 2.0}}}
	n := 0
	for _, i := range check(g, libMaterials).Issues {
		if i.Code == "material_unknown" && i.Key == "SRC" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("báo %d lần, muốn 1", n)
	}
}

func TestEdgeRules(t *testing.T) {
	g := testfix.MiniGraph()
	g.Edges[0].Material = ""
	find(t, check(g, libMaterials), "edge_no_material", "SRC>S")

	g = testfix.MiniGraph()
	g.Edges = append(g.Edges, store.GraphEdge{Key: "S>S", Src: "S", Dst: "S", Material: "RAW-01", Params: map[string]any{}})
	find(t, check(g, libMaterials), "edge_self", "S>S")

	g = testfix.MiniGraph()
	g.Edges = append(g.Edges, store.GraphEdge{Key: "SRC>S#2", Src: "SRC", Dst: "S", Material: "RAW-01", Params: map[string]any{}})
	find(t, check(g, libMaterials), "edge_duplicate", "SRC>S#2")

	g = testfix.MiniGraph()
	g.Edges = append(g.Edges, store.GraphEdge{Key: "S>NOPE", Src: "S", Dst: "NOPE", Material: "RAW-01", Params: map[string]any{}})
	find(t, check(g, libMaterials), "edge_dangling", "S>NOPE")

	g = testfix.MiniGraph()
	g.Edges = append(g.Edges, store.GraphEdge{Key: "S>TUG", Src: "S", Dst: "TUG", Material: "RAW-01", Params: map[string]any{}})
	find(t, check(g, libMaterials), "edge_pool_node", "S>TUG")
}

func TestPoolAndHookRules(t *testing.T) {
	g := testfix.MiniGraph()
	g.Edges[1].Params = map[string]any{"mode": "POOL", "pool": "NOPE"}
	find(t, check(g, libMaterials), "pool_invalid", "S>OUT")

	g = testfix.MiniGraph()
	g.Edges[1].Params = map[string]any{"mode": "POOL", "pool": "TUG", "hook_pool": "TUG"}
	find(t, check(g, libMaterials), "hook_invalid", "S>OUT")
}

func TestInputUnsuppliedNamesNodeAndMaterial(t *testing.T) {
	g := testfix.MiniGraph()
	g.Nodes = append(g.Nodes, proc("P", "PART", "BOX"))
	i := find(t, check(g, libMaterials), "input_unsupplied", "P")
	if !strings.Contains(i.Message, "PART") {
		t.Fatalf("phải nêu vật tư thiếu: %q", i.Message)
	}
}

func TestCheckCycleWithoutStorage(t *testing.T) {
	g := testfix.MiniGraph()
	g.Nodes = append(g.Nodes, proc("P1", "X", "X"), proc("P2", "X", "X"))
	g.Edges = append(g.Edges,
		store.GraphEdge{Key: "P1>P2", Src: "P1", Dst: "P2", Material: "X", Params: map[string]any{}},
		store.GraphEdge{Key: "P2>P1", Src: "P2", Dst: "P1", Material: "X", Params: map[string]any{}})
	find(t, check(g, libMaterials), "cycle_no_storage", "P1")
}

func TestParamsSchemaViolation(t *testing.T) {
	g := testfix.MiniGraph()
	g.Nodes[1].Params = map[string]any{"capacity": -1.0}
	i := find(t, check(g, libMaterials), "params_schema", "S")
	if !strings.Contains(i.Message, "capacity") {
		t.Fatalf("phải nêu trường sai: %q", i.Message)
	}
}

func TestUnknownNodeType(t *testing.T) {
	g := testfix.MiniGraph()
	g.Nodes[1].NodeType = "GONE"
	find(t, check(g, libMaterials), "unknown_type", "S")
}

func TestWarnings(t *testing.T) {
	g := testfix.MiniGraph()
	g.Nodes = append(g.Nodes, store.GraphNode{Key: "LONE", NodeType: "RACK_WAREHOUSE", Params: map[string]any{}})
	find(t, check(g, libMaterials), "node_isolated", "LONE")

	g = testfix.MiniGraph()
	g.Nodes[2].Params = map[string]any{} // Đích không có nhu cầu
	find(t, check(g, libMaterials), "sink_no_demand", "OUT")

	g = testfix.MiniGraph()
	g.Nodes[2].NodeType = "SCRAP" // phế phẩm không tính vào sản lượng nên không cần nhu cầu
	g.Nodes[2].Params = map[string]any{}
	absent(t, check(g, libMaterials), "sink_no_demand")

	g = testfix.MiniGraph()
	g.Nodes = append(g.Nodes, store.GraphNode{Key: "TUG2", NodeType: "TUGGER", Params: map[string]any{}})
	find(t, check(g, libMaterials), "pool_unused", "TUG2")
	absent(t, check(testfix.MiniGraph(), libMaterials), "pool_unused")
}

func TestMaterialUnusedAtDestination(t *testing.T) {
	g := testfix.MiniGraph()
	g.Nodes = append(g.Nodes, proc("P", "PART", "BOX"))
	g.Edges = append(g.Edges, store.GraphEdge{Key: "S>P", Src: "S", Dst: "P", Material: "RAW-01", Params: map[string]any{}})
	find(t, check(g, libMaterials), "material_unused", "S>P")
}

func TestOutputDeadEnd(t *testing.T) {
	g := testfix.MiniGraph()
	g.Nodes = append(g.Nodes, proc("P", "RAW-01", "BOX"))
	g.Edges = append(g.Edges, store.GraphEdge{Key: "S>P", Src: "S", Dst: "P", Material: "RAW-01", Params: map[string]any{}})
	i := find(t, check(g, libMaterials), "output_dead_end", "P")
	if !strings.Contains(i.Message, "BOX") {
		t.Fatalf("phải nêu vật tư ra: %q", i.Message)
	}
}

func inferred(r validate.Report, key, param string) (validate.Inferred, bool) {
	for _, i := range r.Inferred {
		if i.Key == key && i.Param == param {
			return i, true
		}
	}
	return validate.Inferred{}, false
}

func TestInferredCycleFromNodeTypeDefault(t *testing.T) {
	g := testfix.MiniGraph()
	g.Nodes = append(g.Nodes, proc("P", "RAW-01", "BOX"))
	r := check(g, libMaterials)
	got, ok := inferred(r, "P", "cycle")
	if !ok {
		t.Fatalf("thiếu inferred cycle: %+v", r.Inferred)
	}
	if got.Source != "node_type_default" || !strings.Contains(got.Value, "giây") {
		t.Fatalf("inferred = %+v", got)
	}
	absent(t, r, "cycle_unset")
}

func TestInferredCycleUnsetAnywhereIsWarning(t *testing.T) {
	types := testfix.Types()
	pk := types["PACKING"]
	pk.DefaultParams = []byte(`{}`)
	types["PACKING"] = pk
	g := testfix.MiniGraph()
	g.Nodes = append(g.Nodes, proc("P", "RAW-01", "BOX"))
	r := validate.New().Check(validate.CheckInput{Graph: g, Types: types, Materials: libMaterials})
	w := find(t, r, "cycle_unset", "P")
	if w.Severity != validate.SevWarning || !strings.Contains(w.Message, "1 giây") {
		t.Fatalf("cảnh báo = %+v", w)
	}
	got, ok := inferred(r, "P", "cycle")
	if !ok || got.Source != "sim_default" {
		t.Fatalf("inferred = %+v, ok = %v", got, ok)
	}
}

func TestInferredNodeOwnValueNotListed(t *testing.T) {
	g := testfix.MiniGraph()
	p := proc("P", "RAW-01", "BOX")
	p.Params["cycle"] = 30.0
	g.Nodes = append(g.Nodes, p)
	if _, ok := inferred(check(g, libMaterials), "P", "cycle"); ok {
		t.Fatal("node đã tự đặt chu kỳ thì không phải nội suy")
	}
}

func TestInferredStorageCapacity(t *testing.T) {
	r := check(testfix.MiniGraph(), libMaterials)
	got, ok := inferred(r, "S", "capacity")
	if !ok || got.Source != "node_type_default" || got.Value != "2000" {
		t.Fatalf("loại node có mặc định 2000: inferred = %+v, ok = %v", got, ok)
	}
	types := testfix.Types()
	rw := types["RACK_WAREHOUSE"]
	rw.DefaultParams = []byte(`{}`)
	types["RACK_WAREHOUSE"] = rw
	r = validate.New().Check(validate.CheckInput{Graph: testfix.MiniGraph(), Types: types, Materials: libMaterials})
	got, ok = inferred(r, "S", "capacity")
	if !ok || got.Source != "sim_default" || !strings.Contains(got.Value, "không giới hạn") {
		t.Fatalf("không có mặc định: inferred = %+v, ok = %v", got, ok)
	}
}

func TestPoolEdgeTravelUnset(t *testing.T) {
	g := testfix.MiniGraph() // S>OUT chạy bằng xe, chưa đặt travel
	r := check(g, libMaterials)
	w := find(t, r, "travel_unset", "S>OUT")
	if w.Severity != validate.SevWarning || !strings.Contains(w.Message, "0 giây") {
		t.Fatalf("cảnh báo = %+v", w)
	}
	in := validate.CheckInput{Graph: g, Types: testfix.Types(), Materials: libMaterials,
		MapTravel: func(src, dst string) (float64, bool) { return 42, src == "S" && dst == "OUT" }}
	r = validate.New().Check(in)
	got, ok := inferred(r, "S>OUT", "travel")
	if !ok || got.Source != "agv_map" || !strings.Contains(got.Value, "42") {
		t.Fatalf("inferred = %+v, ok = %v", got, ok)
	}
	g.Edges[1].Params["travel"] = map[string]any{"dist": "const", "value": 30.0}
	absent(t, check(g, libMaterials), "travel_unset")
}

func TestPoolEdgeNeedsARouteOnTheMap(t *testing.T) {
	g := testfix.MiniGraph() // S>OUT chạy bằng xe
	run := func(status string) validate.Report {
		return validate.New().Check(validate.CheckInput{Graph: g, Types: testfix.Types(), Materials: libMaterials,
			MapRoute: func(src, dst string) string {
				if src == "S" && dst == "OUT" {
					return status
				}
				return "ok"
			}})
	}
	absent(t, run("ok"), "map_station_missing")
	absent(t, run("ok"), "map_unreachable")
	absent(t, check(g, libMaterials), "map_unreachable") // không có bản đồ thì không có gì để báo

	w := find(t, run("no_station"), "map_station_missing", "S>OUT")
	if w.Severity != validate.SevWarning || !strings.Contains(w.Message, "trạm") {
		t.Fatalf("no_station: %+v", w)
	}
	w = find(t, run("no_path"), "map_unreachable", "S>OUT")
	if w.Severity != validate.SevWarning || !strings.Contains(w.Message, "chờ mãi") {
		t.Fatalf("no_path: %+v", w)
	}
	w = find(t, run("no_return"), "map_unreachable", "S>OUT")
	if !strings.Contains(w.Message, "đường về") {
		t.Fatalf("no_return: %+v", w)
	}
}

func TestIssuesSortedErrorsFirst(t *testing.T) {
	g := testfix.MiniGraph()
	g.Nodes = g.Nodes[1:2]
	g.Edges = nil
	r := check(g, libMaterials)
	seenWarning := false
	for _, i := range r.Issues {
		if i.Severity == validate.SevWarning {
			seenWarning = true
		} else if seenWarning {
			t.Fatalf("lỗi đứng sau cảnh báo: %+v", r.Issues)
		}
	}
}
