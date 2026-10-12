// Package resolve ghép default_params của loại ⊕ params của thiết bị ⊕ params của node ⊕ overrides
// của scenario thành RunRequest của sim-service.
package resolve

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata" // container alpine không có tzdata

	"github.com/kaizenflow/api/internal/simapi"
	"github.com/kaizenflow/api/internal/store"
)

const (
	// maxRecommendHorizonS: quá chừng này thì không chạy đề xuất (mỗi ứng viên là một lần chạy đầy đủ).
	maxRecommendHorizonS = 12 * 3600
	// maxRawHorizonS: quá chừng này thì không ghi dữ liệu thô (sự kiện, cảm biến) của lần lặp 0.
	maxRawHorizonS = 12 * 3600
	// maxSamples: số điểm lấy mẫu tối đa trên một chuỗi của một lần chạy.
	maxSamples = 400
)

// DefaultTimezone là múi giờ nhà máy khi model_version.settings.timezone trống.
const DefaultTimezone = "Asia/Ho_Chi_Minh"

type ForecastLookup func(ctx context.Context, material, producer string, from, to time.Time) ([]store.DailyPoint, error)

// IssueError là lỗi cấu hình gắn key (node/edge/material/settings/scenario).
type IssueError struct{ Key, Msg string }

func (e *IssueError) Error() string { return e.Key + ": " + e.Msg }

type Options struct {
	// ForValidation: thay demand FORECAST bằng hourly_rate [0] để không cần tra forecast.
	ForValidation bool
}

func decode(raw json.RawMessage) (any, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var v any
	err := json.Unmarshal(raw, &v)
	return v, err
}

func cloneAny(v any) any {
	switch x := v.(type) {
	case map[string]any:
		m := make(map[string]any, len(x))
		for k, vv := range x {
			m[k] = cloneAny(vv)
		}
		return m
	case []any:
		s := make([]any, len(x))
		for i, vv := range x {
			s[i] = cloneAny(vv)
		}
		return s
	default:
		return x
	}
}

func deepMerge(base, over map[string]any) map[string]any {
	out := cloneAny(base).(map[string]any)
	for k, v := range over {
		if bm, ok := out[k].(map[string]any); ok {
			if om, ok := v.(map[string]any); ok {
				out[k] = deepMerge(bm, om)
				continue
			}
		}
		out[k] = cloneAny(v)
	}
	return out
}

// MergeNodeParams trả tham số hiệu lực của một node:
// defaults ⊕ signals/failure_modes của type ⊕ params của thiết bị ⊕ params riêng của node trong sơ đồ.
// Tham số thật của máy nằm ở danh mục Thiết bị (dùng chung cho mọi mô hình); node chỉ override khi cần.
func MergeNodeParams(t store.NodeType, n store.GraphNode) (map[string]any, error) {
	base := map[string]any{}
	if d, err := decode(t.DefaultParams); err != nil {
		return nil, err
	} else if m, ok := d.(map[string]any); ok {
		base = m
	}
	for field, raw := range map[string]json.RawMessage{"signals": t.Signals, "failure_modes": t.FailureModes} {
		v, err := decode(raw)
		if err != nil {
			return nil, err
		}
		if s, ok := v.([]any); ok && len(s) > 0 {
			base[field] = s
		}
	}
	if len(n.AssetParams) > 0 {
		base = deepMerge(base, n.AssetParams)
	}
	params := n.Params
	if params == nil {
		params = map[string]any{}
	}
	return deepMerge(base, params), nil
}

// FreezeNodeParams trả phần phải ghi vào node khi Publish: tham số thiết bị ⊕ override của node.
// Không gộp default của loại vào (loại đã bị khoá sửa khi có version Publish dùng, nên không trôi),
// để node vẫn chỉ chứa những gì thuộc riêng nhà máy này.
func FreezeNodeParams(n store.GraphNode) map[string]any {
	own := n.Params
	if own == nil {
		own = map[string]any{}
	}
	if len(n.AssetParams) == 0 {
		return own
	}
	return deepMerge(n.AssetParams, own)
}

func setPathValue(cur any, parts []string, value any) error {
	part := parts[0]
	last := len(parts) == 1
	switch container := cur.(type) {
	case map[string]any:
		if last {
			container[part] = cloneAny(value)
			return nil
		}
		next, exists := container[part]
		if !exists {
			next = map[string]any{}
			container[part] = next
		}
		switch next.(type) {
		case map[string]any, []any:
			return setPathValue(next, parts[1:], value)
		default:
			return fmt.Errorf("'%s' is not an object or array", part)
		}
	case []any:
		index, err := strconv.Atoi(part)
		if err != nil || index < 0 || index >= len(container) {
			return fmt.Errorf("invalid list index '%s'", part)
		}
		if last {
			container[index] = cloneAny(value)
			return nil
		}
		next := container[index]
		switch next.(type) {
		case map[string]any, []any:
			return setPathValue(next, parts[1:], value)
		default:
			return fmt.Errorf("list item %d is not an object or array", index)
		}
	default:
		return fmt.Errorf("path cannot traverse '%s'", part)
	}
}

func setPath(m map[string]any, path string, value any) error {
	parts := []string{}
	for _, p := range strings.Split(path, "/") {
		if p != "" {
			parts = append(parts, p)
		}
	}
	if len(parts) == 0 {
		return fmt.Errorf("empty path")
	}
	return setPathValue(m, parts, value)
}

func num(v any, def float64) float64 {
	if f, ok := v.(float64); ok {
		return f
	}
	return def
}

func Build(ctx context.Context, g *store.Graph, types map[string]store.NodeType, materials []string,
	sc *store.Scenario, runID int64, simStart time.Time, fc ForecastLookup, opt Options) (*simapi.RunRequest, error) {
	params := map[string]map[string]any{}
	arche := map[string]string{}
	for _, n := range g.Nodes {
		t, ok := types[n.NodeType]
		if !ok {
			return nil, &IssueError{n.Key, "unknown node type '" + n.NodeType + "'"}
		}
		p, err := MergeNodeParams(t, n)
		if err != nil {
			return nil, &IssueError{n.Key, err.Error()}
		}
		params[n.Key] = p
		arche[n.Key] = t.Archetype
	}
	edgeParams := map[string]map[string]any{}
	for _, e := range g.Edges {
		p := map[string]any{}
		if e.Params != nil {
			p = cloneAny(e.Params).(map[string]any)
		}
		edgeParams[e.Key] = p
	}
	for _, o := range sc.Overrides {
		target, _ := o["target"].(string)
		path, _ := o["path"].(string)
		dst, ok := params[target]
		if !ok {
			dst, ok = edgeParams[target]
		}
		if !ok {
			return nil, &IssueError{target, "unknown override target"}
		}
		if err := setPath(dst, path, o["value"]); err != nil {
			return nil, &IssueError{target, "override " + path + ": " + err.Error()}
		}
	}

	settings := g.Settings
	tzName, _ := settings["timezone"].(string)
	if tzName == "" {
		tzName = DefaultTimezone
	}
	loc, err := time.LoadLocation(tzName)
	if err != nil {
		return nil, &IssueError{"settings", "unknown timezone '" + tzName + "'"}
	}
	var profile []float64
	if raw, ok := settings["shift_profile"].([]any); ok {
		if len(raw) != 24 {
			return nil, &IssueError{"settings", "shift_profile needs 24 values"}
		}
		for _, v := range raw {
			profile = append(profile, num(v, 0))
		}
	}

	req := &simapi.RunRequest{RunID: runID, SimStart: simStart, HorizonS: sc.HorizonS, Replications: sc.Replications,
		Nodes: []simapi.Node{}, Pools: []simapi.Pool{}, Edges: []map[string]any{}, Injections: []map[string]any{},
		Recommend: sc.Origin != "RECOMMENDER" && sc.HorizonS <= maxRecommendHorizonS}
	if req.Replications <= 0 {
		req.Replications = 1
	}
	req.Seed = runID
	if sc.Seed != nil {
		req.Seed = *sc.Seed
	}
	for _, m := range materials {
		req.Materials = append(req.Materials, simapi.Material{Code: m})
	}
	for _, n := range g.Nodes {
		p := params[n.Key]
		if arche[n.Key] == "RESOURCE_POOL" {
			kind, _ := p["kind"].(string)
			count := num(p["count"], 0)
			if kind == "" || count < 1 || count != math.Trunc(count) {
				return nil, &IssueError{n.Key, "pool needs kind and integer count >= 1"}
			}
			req.Pools = append(req.Pools, simapi.Pool{Key: n.Key, Kind: kind, Count: int(count), Service: p["service"]})
			continue
		}
		if arche[n.Key] == "SINK" {
			if err := resolveDemand(ctx, n.Key, p, fc, simStart.In(loc), sc.HorizonS, profile, opt); err != nil {
				return nil, err
			}
		}
		req.Nodes = append(req.Nodes, simapi.Node{Key: n.Key, Archetype: arche[n.Key], Params: p})
	}
	for _, e := range g.Edges {
		if e.Material == "" {
			return nil, &IssueError{e.Key, "edge needs a material"}
		}
		m := edgeParams[e.Key]
		m["key"], m["src"], m["dst"], m["material"] = e.Key, e.Src, e.Dst, e.Material
		req.Edges = append(req.Edges, m)
	}
	for _, inj := range sc.Injections {
		req.Injections = append(req.Injections, cloneAny(map[string]any(inj)).(map[string]any))
	}
	switch sc.StartState {
	case "", "WARMUP":
		req.InitialState = simapi.InitialState{Mode: "WARMUP", WarmupS: num(settings["warmup_s"], 3600)}
	case "EMPTY", "LIVE_SNAPSHOT":
		// LIVE_SNAPSHOT: tồn kho và máy hỏng lúc bắt đầu đã nằm trong overrides/injections của scenario, nên không chạy ấm.
		req.InitialState = simapi.InitialState{Mode: "EMPTY"}
	default:
		return nil, &IssueError{"scenario", "start_state " + sc.StartState + " is not supported yet"}
	}
	sampleS := num(settings["sample_s"], 60)
	if minStep := math.Ceil(sc.HorizonS / maxSamples); sampleS < minStep {
		sampleS = minStep // horizon dài: lấy mẫu thưa để số điểm dải dự báo không phình ra
	}
	req.Outputs = simapi.Outputs{RawReps: []int{0}, SampleS: sampleS, Sensors: true}
	if raw, ok := settings["raw_reps"].([]any); ok {
		req.Outputs.RawReps = []int{}
		for _, v := range raw {
			req.Outputs.RawReps = append(req.Outputs.RawReps, int(num(v, 0)))
		}
	}
	if sc.HorizonS > maxRawHorizonS {
		// Lần chạy dài ngày: lần lặp 0 sẽ ghi hàng trăm nghìn sự kiện và tín hiệu cảm biến, tốn nhiều thời gian hơn cả mô phỏng.
		req.Outputs.RawReps, req.Outputs.Sensors = []int{}, false
	}
	return req, nil
}

func dayStart(t time.Time) time.Time {
	y, m, d := t.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, t.Location())
}

func resolveDemand(ctx context.Context, key string, p map[string]any, fc ForecastLookup, simStart time.Time,
	horizonS float64, profile []float64, opt Options) error {
	demands, _ := p["demand"].([]any)
	for i, raw := range demands {
		d, ok := raw.(map[string]any)
		if !ok || d["kind"] != "FORECAST" || d["forecast_ref"] == nil {
			continue
		}
		ref, _ := d["forecast_ref"].(map[string]any)
		producer, _ := ref["producer"].(string)
		material, _ := d["material"].(string)
		delete(d, "forecast_ref")
		if opt.ForValidation {
			d["hourly_rate"] = []float64{0}
			demands[i] = d
			continue
		}
		if fc == nil {
			return &IssueError{key, "forecast demand needs a forecast source"}
		}
		hours := int(math.Ceil(horizonS / 3600))
		if hours < 1 {
			hours = 1
		}
		from := dayStart(simStart)
		to := dayStart(simStart.Add(time.Duration(hours) * time.Hour)).AddDate(0, 0, 1)
		pts, err := fc(ctx, material, producer, from, to)
		if err != nil {
			return err
		}
		byDay := map[string]float64{}
		for _, pt := range pts {
			byDay[pt.Day.In(simStart.Location()).Format("2006-01-02")] = pt.P50
		}
		rates := make([]float64, hours)
		for h := 0; h < hours; h++ {
			t := simStart.Add(time.Duration(h) * time.Hour)
			daily, ok := byDay[t.Format("2006-01-02")]
			if !ok {
				return &IssueError{material, "no forecast (" + producer + ") for " + t.Format("2006-01-02")}
			}
			w := 1.0 / 24
			if profile != nil {
				w = profile[t.Hour()]
			}
			rates[h] = daily * w
		}
		d["hourly_rate"] = rates
		demands[i] = d
	}
	return nil
}
