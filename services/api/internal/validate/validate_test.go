package validate_test

import (
	"strings"
	"testing"

	"github.com/kaizenflow/api/internal/store"
	"github.com/kaizenflow/api/internal/testfix"
	"github.com/kaizenflow/api/internal/validate"
)

func proc(key, in, out string) store.GraphNode {
	return store.GraphNode{Key: key, NodeType: "PACKING", Archetype: "PROCESS", Params: map[string]any{
		"recipes": []any{map[string]any{"inputs": []any{map[string]any{"material": in, "qty": 1.0}},
			"outputs": []any{map[string]any{"material": out, "qty": 1.0}}}}}}
}

func TestGraphReturnsOnlyErrors(t *testing.T) {
	v := validate.New()
	if got := v.Graph(testfix.MiniGraph(), testfix.Types()); len(got) != 0 {
		t.Fatalf("đồ thị mẫu chỉ có cảnh báo, không được trả lỗi: %v", got)
	}
	g := testfix.MiniGraph()
	g.Nodes = g.Nodes[1:2]
	g.Edges = nil
	got := v.Graph(g, testfix.Types())
	if len(got) != 2 {
		t.Fatalf("thiếu Nguồn và Đích phải ra 2 lỗi, được %v", got)
	}
	for _, i := range got {
		if i.Severity != validate.SevError || !strings.Contains(i.Message, "Nguồn") && !strings.Contains(i.Message, "Đích") {
			t.Fatalf("issue = %+v", i)
		}
	}
}

func TestDefaultParamsIgnoreTopLevelRequiredButCheckTypes(t *testing.T) {
	v := validate.New()
	types := testfix.Types()
	if got := v.DefaultParams(types["DOCK_IN"], map[string]any{"assumed": true, "arrivals": map[string]any{"interarrival": 60.0}}); len(got) != 0 {
		t.Fatalf("missing required `lots` must be fine in defaults: %v", got)
	}
	if got := v.DefaultParams(types["DOCK_IN"], nil); len(got) != 0 {
		t.Fatalf("nil defaults: %v", got)
	}
	got := v.DefaultParams(types["RACK_WAREHOUSE"], map[string]any{"capacity": -5.0})
	if len(got) != 1 || got[0].Key != "default_params" {
		t.Fatalf("negative capacity: %v", got)
	}
	// `required` lồng trong items vẫn được giữ: một lô thiếu qty là sai
	got = v.DefaultParams(types["DOCK_IN"], map[string]any{"lots": []any{map[string]any{"material": "RAW-01"}}})
	if len(got) != 1 || got[0].Key != "default_params" {
		t.Fatalf("lot without qty: %v", got)
	}
}
