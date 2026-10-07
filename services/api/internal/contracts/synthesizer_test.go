package contracts

import (
	"testing"

	"github.com/kaizenflow/api/internal/store"
)

// TR-1.1: Graph cũ chỉ có capacity scalar, stock[i].max thiếu
// → synthesize trả {sku: capacity} và meta có warehouse_capacities[node_key]
func TestSynthesizeStorageScalarCapacity(t *testing.T) {
	nodes := []store.GraphNode{
		{
			Key:       "wh1",
			Archetype: "STORAGE",
			Params: map[string]any{
				"capacity": 1000.0,
				"stock": []any{
					map[string]any{"material": "SKU_A", "initial": 50.0},
					map[string]any{"material": "SKU_B", "initial": 120.0},
				},
			},
		},
	}
	meta := SynthesizeGraphContracts(nodes)
	wh, ok := meta.WarehouseCapacities["wh1"]
	if !ok {
		t.Fatalf("expected warehouse_capacities[wh1] to exist")
	}
	if len(wh) != 2 {
		t.Fatalf("expected 2 sku entries, got %d", len(wh))
	}
	if wh["SKU_A"] != 1000 {
		t.Errorf("wh1.SKU_A capacity: want 1000, got %v", wh["SKU_A"])
	}
	if wh["SKU_B"] != 1000 {
		t.Errorf("wh1.SKU_B capacity: want 1000, got %v", wh["SKU_B"])
	}
}

// TR-1.1 bổ sung: stock[i].max có định nghĩa → ưu tiên max hơn scalar
func TestSynthesizeStorageStockMaxOverridesScalar(t *testing.T) {
	nodes := []store.GraphNode{
		{
			Key:       "wh1",
			Archetype: "STORAGE",
			Params: map[string]any{
				"capacity": 1000.0,
				"stock": []any{
					map[string]any{"material": "SKU_A", "initial": 50.0, "max": 300.0},
					map[string]any{"material": "SKU_B", "initial": 120.0},
				},
			},
		},
	}
	meta := SynthesizeGraphContracts(nodes)
	wh := meta.WarehouseCapacities["wh1"]
	if wh["SKU_A"] != 300 {
		t.Errorf("SKU_A: want 300 (stock.max), got %v", wh["SKU_A"])
	}
	if wh["SKU_B"] != 1000 {
		t.Errorf("SKU_B: want 1000 (fallback scalar), got %v", wh["SKU_B"])
	}
}

// TR-1.2: Graph 2 recipes process → process_io_contracts[node_key].inputs[A] = sum 2 inputs[A]
// và outputs khớp.
func TestSynthesizeProcessTwoRecipes(t *testing.T) {
	nodes := []store.GraphNode{
		{
			Key:       "p1",
			Archetype: "PROCESS",
			Params: map[string]any{
				"recipes": []any{
					map[string]any{
						"inputs": []any{
							map[string]any{"material": "A", "qty": 2.0},
							map[string]any{"material": "B", "qty": 1.0},
						},
						"outputs": []any{
							map[string]any{"material": "C", "qty": 1.0},
						},
					},
					map[string]any{
						"inputs": []any{
							map[string]any{"material": "A", "qty": 3.0},
							map[string]any{"material": "D", "qty": 5.0},
						},
						"outputs": []any{
							map[string]any{"material": "C", "qty": 2.0},
							map[string]any{"material": "E", "qty": 1.0},
						},
					},
				},
			},
		},
	}
	meta := SynthesizeGraphContracts(nodes)
	io, ok := meta.ProcessIOContracts["p1"]
	if !ok {
		t.Fatalf("expected process_io_contracts[p1] to exist")
	}
	if io.Inputs["A"] != 5.0 {
		t.Errorf("p1 inputs[A]: want 5.0 (=2+3), got %v", io.Inputs["A"])
	}
	if io.Inputs["B"] != 1.0 {
		t.Errorf("p1 inputs[B]: want 1.0, got %v", io.Inputs["B"])
	}
	if io.Inputs["D"] != 5.0 {
		t.Errorf("p1 inputs[D]: want 5.0, got %v", io.Inputs["D"])
	}
	if io.Outputs["C"] != 3.0 {
		t.Errorf("p1 outputs[C]: want 3.0 (=1+2), got %v", io.Outputs["C"])
	}
	if io.Outputs["E"] != 1.0 {
		t.Errorf("p1 outputs[E]: want 1.0, got %v", io.Outputs["E"])
	}
}

// TR-1.3: Backward compat - graph cũ thiếu hết các field → không panic, trả về empty maps
func TestSynthesizeBackwardCompatEmpty(t *testing.T) {
	nodes := []store.GraphNode{
		{
			Key:       "old_wh",
			Archetype: "STORAGE",
			Params:    map[string]any{},
		},
		{
			Key:       "old_proc",
			Archetype: "PROCESS",
			Params:    map[string]any{},
		},
		{
			Key:       "src",
			Archetype: "SOURCE",
			Params:    map[string]any{"lots": []any{map[string]any{"material": "X", "qty": 1.0}}},
		},
	}
	meta := SynthesizeGraphContracts(nodes)
	if meta.WarehouseCapacities == nil {
		t.Error("WarehouseCapacities should be initialized map, not nil")
	}
	if meta.ProcessIOContracts == nil {
		t.Error("ProcessIOContracts should be initialized map, not nil")
	}
	if _, hasOld := meta.WarehouseCapacities["old_wh"]; hasOld {
		t.Error("old_wh (empty params) should not appear in warehouse_capacities")
	}
	if _, hasOldP := meta.ProcessIOContracts["old_proc"]; hasOldP {
		t.Error("old_proc (empty params) should not appear in process_io_contracts")
	}
}

// TR-1.3 edge case: stock[i] là item không hợp lệ (thiếu material), bỏ qua không panic
func TestSynthesizeStorageInvalidStockIgnored(t *testing.T) {
	nodes := []store.GraphNode{
		{
			Key:       "wh1",
			Archetype: "STORAGE",
			Params: map[string]any{
				"capacity": 500.0,
				"stock": []any{
					map[string]any{"initial": 10.0},
					"not-an-object",
					map[string]any{"material": "GOOD", "initial": 5.0},
				},
			},
		},
	}
	meta := SynthesizeGraphContracts(nodes)
	wh := meta.WarehouseCapacities["wh1"]
	if len(wh) != 1 {
		t.Fatalf("want 1 valid stock entry, got %d: %v", len(wh), wh)
	}
	if wh["GOOD"] != 500 {
		t.Errorf("GOOD want 500, got %v", wh["GOOD"])
	}
}
