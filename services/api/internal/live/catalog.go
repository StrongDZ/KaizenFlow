package live

import (
	"fmt"
	"strings"
)

// SignalDef là một tín hiệu chuẩn mà node/edge có thể được ghép. Kind: number | text | fleet.
type SignalDef struct {
	Name  string `json:"name"`
	Label string `json:"label"`
	Kind  string `json:"kind"`
}

func stockMaterials(params map[string]any) []string {
	var out []string
	list, _ := params["stock"].([]any)
	for _, raw := range list {
		if m, ok := raw.(map[string]any); ok {
			if code, ok := m["material"].(string); ok && code != "" {
				out = append(out, code)
			}
		}
	}
	return out
}

// SignalsFor trả các tín hiệu chuẩn của một node theo archetype (params là tham số hiệu lực, dùng để biết vật tư trong kho).
func SignalsFor(archetype string, params map[string]any) []SignalDef {
	switch archetype {
	case "PROCESS":
		return []SignalDef{
			{"state", "Trạng thái máy", "text"},
			{"count_in", "Số lượt đã nhận vật tư", "number"},
			{"count_ok", "Số sản phẩm đạt", "number"},
			{"count_ng", "Số sản phẩm lỗi", "number"},
			{"vibration", "Độ rung", "number"},
		}
	case "STORAGE":
		var out []SignalDef
		for _, m := range stockMaterials(params) {
			out = append(out, SignalDef{"level:" + m, fmt.Sprintf("Tồn %s", m), "number"})
		}
		return out
	case "SOURCE":
		return []SignalDef{{"arrived", "Số đã nhập về", "number"}}
	case "SINK":
		return []SignalDef{
			{"demand", "Nhu cầu tích luỹ", "number"},
			{"fulfilled", "Số đã giao", "number"},
			{"backorder", "Nợ đơn", "number"},
		}
	case "RESOURCE_POOL":
		out := []SignalDef{{"busy", "Số đang bận", "number"}, {"queue_len", "Số lượt đang chờ", "number"}}
		if kind, _ := params["kind"].(string); kind == "AGV" || kind == "TUGGER" || kind == "FORKLIFT" {
			out = append(out, SignalDef{SignalFleet, "Vị trí từng xe", "fleet"})
		}
		return out
	}
	return nil
}

// EdgeSignals trả các tín hiệu chuẩn của một edge; trip_s (thời gian một chuyến) chỉ có với edge chạy bằng xe.
func EdgeSignals(mode string) []SignalDef {
	out := []SignalDef{{"in_transit", "Số đang trên đường", "number"}, {"moved", "Tổng số đã chuyển", "number"}}
	if mode == "POOL" {
		out = append(out, SignalDef{"trip_s", "Thời gian một chuyến (giây)", "number"})
	}
	return out
}

// ValidSignal: tín hiệu có hợp lệ cho node này không. Kho chấp nhận mọi `level:<vật tư>`, vì vật tư có thể thêm sau.
func ValidSignal(archetype string, params map[string]any, name string) bool {
	if archetype == "STORAGE" {
		return strings.HasPrefix(name, "level:") && len(name) > len("level:")
	}
	for _, d := range SignalsFor(archetype, params) {
		if d.Name == name {
			return true
		}
	}
	return false
}
