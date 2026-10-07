package contracts

import (
	"encoding/json"

	"github.com/kaizenflow/api/internal/store"
)

type IOContract struct {
	Inputs  map[string]float64 `json:"inputs"`
	Outputs map[string]float64 `json:"outputs"`
}

type ContractsMeta struct {
	WarehouseCapacities map[string]map[string]float64 `json:"warehouse_capacities"`
	ProcessIOContracts  map[string]*IOContract        `json:"process_io_contracts"`
}

func SynthesizeGraphContracts(nodes []store.GraphNode) ContractsMeta {
	out := ContractsMeta{
		WarehouseCapacities: map[string]map[string]float64{},
		ProcessIOContracts:  map[string]*IOContract{},
	}
	for _, n := range nodes {
		switch n.Archetype {
		case "STORAGE":
			caps := synthesizeStorage(n)
			if len(caps) > 0 {
				out.WarehouseCapacities[n.Key] = caps
			}
		case "PROCESS":
			io := synthesizeProcess(n)
			if io != nil {
				out.ProcessIOContracts[n.Key] = io
			}
		}
	}
	return out
}

func synthesizeStorage(n store.GraphNode) map[string]float64 {
	caps := map[string]float64{}
	var scalarCap float64
	if v, ok := asFloat(n.Params["capacity"]); ok && v > 0 {
		scalarCap = v
	}
	stock, _ := n.Params["stock"].([]any)
	for _, item := range stock {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		sku, _ := m["material"].(string)
		if sku == "" {
			continue
		}
		if mx, ok := asFloat(m["max"]); ok && mx > 0 {
			caps[sku] = mx
			continue
		}
		if scalarCap > 0 {
			caps[sku] = scalarCap
		}
	}
	return caps
}

func synthesizeProcess(n store.GraphNode) *IOContract {
	recipes, _ := n.Params["recipes"].([]any)
	if len(recipes) == 0 {
		return nil
	}
	inSum := map[string]float64{}
	outSum := map[string]float64{}
	for _, r := range recipes {
		rm, ok := r.(map[string]any)
		if !ok {
			continue
		}
		inputs, _ := rm["inputs"].([]any)
		for _, line := range inputs {
			lm, ok := line.(map[string]any)
			if !ok {
				continue
			}
			mat, _ := lm["material"].(string)
			if mat == "" {
				continue
			}
			q, _ := asFloat(lm["qty"])
			inSum[mat] += q
		}
		outputs, _ := rm["outputs"].([]any)
		for _, line := range outputs {
			lm, ok := line.(map[string]any)
			if !ok {
				continue
			}
			mat, _ := lm["material"].(string)
			if mat == "" {
				continue
			}
			q, _ := asFloat(lm["qty"])
			outSum[mat] += q
		}
	}
	if len(inSum) == 0 && len(outSum) == 0 {
		return nil
	}
	return &IOContract{Inputs: inSum, Outputs: outSum}
}

func asFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case float32:
		return float64(x), true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case int32:
		return float64(x), true
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	}
	return 0, false
}
