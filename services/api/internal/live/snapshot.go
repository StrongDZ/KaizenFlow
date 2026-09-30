package live

import (
	"fmt"
	"math"
	"sort"
	"strings"
)

// DefaultRepairS: thời gian sửa giả định (giây) cho máy đang hỏng mà mô hình không khai MTTR.
const DefaultRepairS = 1800.0

// NodeInfo là node với tham số hiệu lực (đã gộp mặc định của loại node).
type NodeInfo struct {
	Key       string
	Archetype string
	Params    map[string]any
}

// SnapshotOut là điểm xuất phát của một dự báo dựng từ trạng thái live, biểu diễn bằng overrides và injections thường
// của scenario để nhìn thấy, sửa và chạy lại được như mọi scenario khác.
type SnapshotOut struct {
	Overrides  []map[string]any
	Injections []map[string]any
	Notes      []string
	Levels     map[string]map[string]float64
	Down       map[string]float64
}

func cloneMap(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// BuildSnapshot: tồn kho theo tín hiệu `level:<vật tư>` thay cho `stock[].initial` của từng kho; máy đang DOWN thành
// `planned_stop` từ giây 0 trong thời gian sửa (MTTR trung bình của máy, mặc định DefaultRepairS).
// Hàng đang chờ trong máy và trên xe không có trong dữ liệu live nên được giả định rỗng.
func BuildSnapshot(nodes []NodeInfo, levels map[string]map[string]float64, states map[string]string) SnapshotOut {
	out := SnapshotOut{Levels: map[string]map[string]float64{}, Down: map[string]float64{}}
	for _, n := range nodes {
		switch n.Archetype {
		case "STORAGE":
			live := levels[n.Key]
			if len(live) == 0 {
				continue
			}
			var list []any
			seen := map[string]bool{}
			if cur, ok := n.Params["stock"].([]any); ok {
				for _, raw := range cur {
					entry, ok := raw.(map[string]any)
					if !ok {
						continue
					}
					e := cloneMap(entry)
					mat, _ := e["material"].(string)
					seen[mat] = true
					if lv, ok := live[mat]; ok {
						e["initial"] = math.Max(0, lv)
						out.note(n.Key, mat, lv)
						out.setLevel(n.Key, mat, lv)
					}
					list = append(list, e)
				}
			}
			mats := make([]string, 0, len(live))
			for m := range live {
				if !seen[m] {
					mats = append(mats, m)
				}
			}
			sort.Strings(mats)
			for _, m := range mats {
				list = append(list, map[string]any{"material": m, "initial": math.Max(0, live[m])})
				out.note(n.Key, m, live[m])
				out.setLevel(n.Key, m, live[m])
			}
			out.Overrides = append(out.Overrides, map[string]any{"target": n.Key, "path": "/stock", "value": list})
		case "PROCESS":
			if states[n.Key] != "DOWN" {
				continue
			}
			dur := DefaultRepairS
			if m, ok := DistMean(n.Params["mttr"]); ok && m > 0 {
				dur = m
			}
			out.Injections = append(out.Injections, map[string]any{"target": n.Key, "kind": "planned_stop", "at_s": 0.0, "duration_s": dur})
			out.Down[n.Key] = dur
			out.Notes = append(out.Notes, fmt.Sprintf("Máy %s đang hỏng, giả định sửa xong sau %s", n.Key, fmtDuration(dur)))
		}
	}
	if len(out.Overrides)+len(out.Injections) > 0 {
		out.Notes = append(out.Notes, "Hàng đang chờ trong máy và trên xe không có trong dữ liệu live nên được giả định rỗng.")
	}
	return out
}

func (o *SnapshotOut) note(node, mat string, lv float64) {
	o.Notes = append(o.Notes, fmt.Sprintf("Tồn %s · %s = %s", node, mat, trimFloat(math.Max(0, lv))))
}

func (o *SnapshotOut) setLevel(node, mat string, lv float64) {
	if o.Levels[node] == nil {
		o.Levels[node] = map[string]float64{}
	}
	o.Levels[node][mat] = math.Max(0, lv)
}

func trimFloat(v float64) string {
	s := fmt.Sprintf("%.1f", v)
	return strings.TrimSuffix(s, ".0")
}

func fmtDuration(s float64) string {
	if s >= 3600 {
		return fmt.Sprintf("%s giờ", trimFloat(s/3600))
	}
	return fmt.Sprintf("%s phút", trimFloat(s/60))
}

// DistMean là trung bình của một phân phối theo JSON contract (cùng luật với sim `dists.mean_of`).
func DistMean(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case map[string]any:
		get := func(name string) (float64, bool) {
			for _, k := range []string{name, name + "_s"} {
				if f, ok := x[k].(float64); ok {
					return f, true
				}
			}
			return 0, false
		}
		kind, _ := x["dist"].(string)
		switch kind {
		case "const":
			return get("value")
		case "norm", "normal", "exp", "lognorm":
			return get("mean")
		case "tri":
			a, ok1 := get("min")
			c, ok2 := get("mode")
			b, ok3 := get("max")
			return (a + c + b) / 3, ok1 && ok2 && ok3
		case "uniform":
			a, ok1 := get("min")
			b, ok2 := get("max")
			return (a + b) / 2, ok1 && ok2
		case "weibull":
			k, ok1 := get("shape")
			l, ok2 := get("scale")
			return l * math.Gamma(1+1/k), ok1 && ok2 && k > 0
		}
	}
	return 0, false
}
