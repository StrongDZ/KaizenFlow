package fmcg

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/kaizenflow/api/internal/resolve"
	"github.com/kaizenflow/api/internal/store"
)

const (
	ModelKey          = "bimbo-fmcg"
	lookbackHours     = 6
	criticalCoverageH = 4.0
	targetCoverageH   = 18.0
	maxCoverageBoost  = 0.18
	extraBacklogBoost = 0.07
)

var (
	weekdayWeights = normalizeWeights([]float64{0.95, 0.98, 1.0, 1.02, 1.07, 1.1, 0.88})
	hourWeights    = normalizeWeights([]float64{
		0.78, 0.72, 0.68, 0.66, 0.7, 0.84, 0.98, 1.08, 1.14, 1.18, 1.12, 1.04,
		0.98, 0.96, 0.98, 1.02, 1.1, 1.22, 1.28, 1.2, 1.08, 0.98, 0.9, 0.84,
	})
)

type Observation struct {
	DemandPerHour    float64
	FulfilledPerHour float64
	BackorderPerHour float64
	RecentPerHour    float64
	Basis            string
	Samples          int
	WindowHours      float64
}

type storageFeed struct {
	Stock   float64
	Sources []string
}

type storageStock struct {
	Material string
	Initial  float64
	Max      float64
}

func normalizeWeights(in []float64) []float64 {
	if len(in) == 0 {
		return nil
	}
	sum := 0.0
	for _, v := range in {
		sum += v
	}
	mean := sum / float64(len(in))
	out := make([]float64, len(in))
	for i, v := range in {
		if mean == 0 {
			out[i] = 1
			continue
		}
		out[i] = v / mean
	}
	return out
}

func number(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case float32:
		return float64(x)
	case int:
		return float64(x)
	case int64:
		return float64(x)
	}
	return 0
}

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func baselinePerHour(d map[string]any) float64 {
	kind, _ := d["kind"].(string)
	switch kind {
	case "", "TAKT":
		takt, _ := d["takt"].(map[string]any)
		meanS := number(takt["mean"])
		if meanS <= 0 {
			return 0
		}
		qty := number(d["qty"])
		if qty <= 0 {
			qty = 1
		}
		return qty * 3600 / meanS
	case "FORECAST":
		raw, _ := d["hourly_rate"].([]any)
		if len(raw) == 0 {
			return 0
		}
		sum := 0.0
		for _, v := range raw {
			sum += number(v)
		}
		return sum / float64(len(raw))
	default:
		return 0
	}
}

func incomingStorageFeeds(g *store.Graph, types map[string]store.NodeType, levels map[string]map[string]float64) map[string]map[string]storageFeed {
	archByNode := map[string]string{}
	for _, n := range g.Nodes {
		if t, ok := types[n.NodeType]; ok {
			archByNode[n.Key] = t.Archetype
		}
	}
	out := map[string]map[string]storageFeed{}
	for _, e := range g.Edges {
		if archByNode[e.Src] != "STORAGE" {
			continue
		}
		if levels[e.Src] == nil {
			continue
		}
		if out[e.Dst] == nil {
			out[e.Dst] = map[string]storageFeed{}
		}
		feed := out[e.Dst][e.Material]
		feed.Stock += levels[e.Src][e.Material]
		if !contains(feed.Sources, e.Src) {
			feed.Sources = append(feed.Sources, e.Src)
		}
		out[e.Dst][e.Material] = feed
	}
	return out
}

func contains(items []string, want string) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}

func stockConfig(p map[string]any) []storageStock {
	raw, _ := p["stock"].([]any)
	out := make([]storageStock, 0, len(raw))
	for _, item := range raw {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		mat, _ := m["material"].(string)
		if mat == "" {
			continue
		}
		out = append(out, storageStock{Material: mat, Initial: number(m["initial"]), Max: number(m["max"])})
	}
	return out
}

func chooseUpstreamSource(sources []string, levelsByNode map[string]map[string]float64, paramsByNode map[string]map[string]any, material string, extraQty float64) (string, float64, bool) {
	bestIdx := -1
	bestRoom := -1.0
	bestHeadroom := 0.0
	for idx, src := range sources {
		cfg := stockConfig(paramsByNode[src])
		cfgByMat := map[string]storageStock{}
		for _, c := range cfg {
			cfgByMat[c.Material] = c
		}
		live := levelsByNode[src]
		if live == nil {
			live = map[string]float64{}
		}
		base := live[material]
		if base == 0 {
			if c, ok := cfgByMat[material]; ok && c.Initial > 0 {
				base = c.Initial
			}
		}
		maxQty := 0.0
		if c, ok := cfgByMat[material]; ok {
			maxQty = c.Max
		}
		current := base
		if current > maxQty && maxQty > 0 {
			maxQty = current
		}
		headroom := math.Max(0, maxQty-current)
		score := current
		if maxQty > 0 {
			score = headroom
		}
		if score > bestRoom || (score == bestRoom && current > 0) {
			if extraQty > 0 && maxQty > 0 && current+extraQty > maxQty {
				continue
			}
			bestIdx = idx
			bestRoom = score
			bestHeadroom = headroom
		}
	}
	if bestIdx < 0 {
		for idx, src := range sources {
			cfg := stockConfig(paramsByNode[src])
			cfgByMat := map[string]storageStock{}
			for _, c := range cfg {
				cfgByMat[c.Material] = c
			}
			live := levelsByNode[src]
			if live == nil {
				live = map[string]float64{}
			}
			base := live[material]
			if base == 0 {
				if c, ok := cfgByMat[material]; ok && c.Initial > 0 {
					base = c.Initial
				}
			}
			maxQty := 0.0
			if c, ok := cfgByMat[material]; ok {
				maxQty = c.Max
			}
			current := base
			if current > maxQty && maxQty > 0 {
				maxQty = current
			}
			headroom := math.Max(0, maxQty-current)
			score := current
			if maxQty > 0 {
				score = headroom
			}
			if score > bestRoom {
				bestIdx = idx
				bestRoom = score
				bestHeadroom = headroom
			}
		}
	}
	if bestIdx < 0 {
		return "", 0, false
	}
	chosen := sources[bestIdx]
	applyQty := extraQty
	if applyQty > 0 {
		applyQty = math.Min(applyQty, math.Max(bestHeadroom, applyQty))
	}
	return chosen, applyQty, true
}

func storageOverrideValue(cfg []storageStock, live map[string]float64, material string, extraQty float64) []any {
	if live == nil {
		live = map[string]float64{}
	}
	out := make([]any, 0, len(cfg)+1)
	seen := map[string]bool{}
	for _, item := range cfg {
		initial := live[item.Material]
		if initial == 0 && item.Initial > 0 {
			initial = item.Initial
		}
		apply := 0.0
		if item.Material == material {
			apply = extraQty
		}
		maxQty := item.Max
		if maxQty <= 0 {
			maxQty = initial + apply
		}
		nextInitial := initial + apply
		if nextInitial > maxQty {
			nextInitial = maxQty
			apply = nextInitial - initial
		}
		if item.Material == material && extraQty > 0 && apply > 0 {
			_ = apply
		}
		out = append(out, map[string]any{"material": item.Material, "initial": round(nextInitial, 1), "max": round(maxQty, 1)})
		seen[item.Material] = true
	}
	if !seen[material] {
		initial := live[material]
		if initial == 0 {
			initial = 0
		}
		nextInitial := initial + extraQty
		out = append(out, map[string]any{"material": material, "initial": round(nextInitial, 1), "max": round(nextInitial, 1)})
	}
	return out
}

func effectiveRecent(obs Observation) (float64, string) {
	backlogLift := math.Max(0, obs.BackorderPerHour)
	candidates := []struct {
		rate  float64
		basis string
	}{
		{obs.DemandPerHour, "demand"},
		{obs.FulfilledPerHour, "fulfilled"},
		{obs.FulfilledPerHour + backlogLift, "fulfilled+backorder"},
	}
	best := candidates[0]
	for _, c := range candidates[1:] {
		if c.rate > best.rate {
			best = c
		}
	}
	if best.rate <= 0 {
		return 0, ""
	}
	return best.rate, best.basis
}

func coveragePressure(stock, refRate float64) (float64, float64) {
	if stock <= 0 || refRate <= 0 {
		return 0, 0
	}
	coverageH := stock / refRate
	switch {
	case coverageH <= criticalCoverageH:
		return 1, coverageH
	case coverageH >= targetCoverageH:
		return 0, coverageH
	default:
		return clamp((targetCoverageH-coverageH)/(targetCoverageH-criticalCoverageH), 0, 1), coverageH
	}
}

func chooseBlend(base float64, obs Observation, stock float64) (float64, string, string, float64, float64) {
	recent, basis := effectiveRecent(obs)
	if base <= 0 && recent > 0 {
		pressure, coverageH := coveragePressure(stock, recent)
		boost := 1 + pressure*maxCoverageBoost
		return recent * boost, "live_only", basis, pressure, coverageH
	}
	if recent <= 0 {
		pressure, coverageH := coveragePressure(stock, base)
		boost := 1 + pressure*(maxCoverageBoost*0.5)
		return base * boost, "calendar_from_takt", "", pressure, coverageH
	}
	recent = clamp(recent, base*0.4, base*2.2)
	pressure, coverageH := coveragePressure(stock, math.Max(base, recent))
	boost := 1 + pressure*maxCoverageBoost
	source := "hybrid_live+takt"
	if obs.BackorderPerHour > 0 {
		boost += pressure * extraBacklogBoost
		source = "hybrid_live_backorder+takt"
	}
	blend := base*0.55 + recent*0.45
	if source == "hybrid_live_backorder+takt" {
		blend = base*0.45 + recent*0.55
	}
	if pressure > 0.01 {
		source += "+coverage"
	}
	return blend * boost, source, basis, pressure, coverageH
}

func replenishPriority(pressure, coverageH, backorderPerHour float64) (string, float64) {
	score := pressure*100 + clamp(backorderPerHour*4, 0, 40)
	switch {
	case coverageH > 0 && coverageH <= criticalCoverageH:
		return "CRITICAL", score + 20
	case pressure >= 0.75 || backorderPerHour >= 4:
		return "HIGH", score + 10
	case pressure >= 0.35 || backorderPerHour >= 1.5:
		return "MEDIUM", score
	default:
		return "LOW", score * 0.5
	}
}

func prioritySeverity(priority string) int {
	switch priority {
	case "CRITICAL":
		return 5
	case "HIGH":
		return 4
	case "MEDIUM":
		return 3
	default:
		return 2
	}
}

func replenishCandidate(rank int, source, material string, stockOverride []any, qty, score, pressure float64) map[string]any {
	return map[string]any{
		"rank": float64(rank),
		"action": map[string]any{
			"type":     "REPLENISH",
			"target":   source,
			"material": material,
			"qty":      round(qty, 1),
			"cost":     round(qty, 1),
			"rop":      round(qty, 1),
		},
		"overrides": []any{
			map[string]any{"target": source, "path": "/stock", "value": stockOverride},
		},
		"injections": nil,
		"delta_kpi": map[string]any{
			"red_minutes": round(math.Max(5, pressure*60), 1),
			"throughput":  round(math.Max(1, qty/24), 1),
		},
		"score": round(score, 2),
	}
}

func forecastCurve(start time.Time, hours int, basePerHour float64) []float64 {
	if hours < 1 {
		hours = 1
	}
	out := make([]float64, hours)
	for i := 0; i < hours; i++ {
		t := start.Add(time.Duration(i) * time.Hour)
		dayMul := weekdayWeights[int(t.Weekday())]
		hourMul := hourWeights[t.Hour()]
		out[i] = math.Max(0, basePerHour*dayMul*hourMul)
	}
	return out
}

func BuildRuntimeNowcast(g *store.Graph, types map[string]store.NodeType, levels map[string]map[string]float64,
	obs map[string]Observation, now time.Time, horizonS float64) ([]map[string]any, map[string]any, error) {
	if g == nil || g.ModelKey != ModelKey {
		return nil, nil, nil
	}
	hours := int(math.Ceil(horizonS / 3600))
	if hours < 1 {
		hours = 1
	}
	upstream := incomingStorageFeeds(g, types, levels)
	paramsByNode := map[string]map[string]any{}
	nameByNode := map[string]string{}
	for _, n := range g.Nodes {
		t, ok := types[n.NodeType]
		if !ok {
			continue
		}
		p, err := resolve.MergeNodeParams(t, n)
		if err != nil {
			return nil, nil, &resolve.IssueError{Key: n.Key, Msg: err.Error()}
		}
		paramsByNode[n.Key] = p
		nameByNode[n.Key] = firstNonEmpty(n.Name, t.Name, n.Key)
	}
	overrides := []map[string]any{}
	series := []map[string]any{}
	notes := []string{}
	replenishment := []map[string]any{}
	for _, n := range g.Nodes {
		t, ok := types[n.NodeType]
		if !ok || t.Archetype != "SINK" {
			continue
		}
		params := paramsByNode[n.Key]
		rawDemands, _ := params["demand"].([]any)
		if len(rawDemands) == 0 {
			continue
		}
		nextDemands := make([]any, 0, len(rawDemands))
		for _, raw := range rawDemands {
			d, ok := raw.(map[string]any)
			if !ok {
				nextDemands = append(nextDemands, raw)
				continue
			}
			material, _ := d["material"].(string)
			if !strings.HasPrefix(material, "CASE-") {
				nextDemands = append(nextDemands, d)
				continue
			}
			base := baselinePerHour(d)
			liveObs := obs[n.Key]
			recent, liveBasis := effectiveRecent(liveObs)
			feed := upstream[n.Key][material]
			stock := feed.Stock
			blend, source, liveBasis, pressure, preCoverage := chooseBlend(base, liveObs, stock)
			rates := forecastCurve(now, hours, blend)
			nextDemands = append(nextDemands, map[string]any{
				"kind":        "FORECAST",
				"material":    material,
				"hourly_rate": rates,
			})
			row := map[string]any{
				"subject":           n.Key,
				"label":             firstNonEmpty(n.Name, t.Name, n.Key),
				"material":          material,
				"source":            source,
				"baseline_per_hour": round(base, 2),
				"blend_per_hour":    round(blend, 2),
				"hourly_rate":       rates,
			}
			if preCoverage > 0 {
				row["pre_coverage_hours"] = round(preCoverage, 1)
			}
			if pressure > 0 {
				row["coverage_pressure"] = round(pressure, 2)
			}
			if recent > 0 {
				row["recent_per_hour"] = round(recent, 2)
				row["live_basis"] = firstNonEmpty(liveBasis, liveObs.Basis)
				row["live_window_hours"] = round(liveObs.WindowHours, 2)
				row["live_samples"] = liveObs.Samples
				if liveObs.DemandPerHour > 0 {
					row["demand_per_hour"] = round(liveObs.DemandPerHour, 2)
				}
				if liveObs.FulfilledPerHour > 0 {
					row["fulfilled_per_hour"] = round(liveObs.FulfilledPerHour, 2)
				}
				if liveObs.BackorderPerHour != 0 {
					row["backorder_per_hour"] = round(liveObs.BackorderPerHour, 2)
				}
			}
			if stock > 0 && blend > 0 {
				coverage := stock / blend
				row["coverage_hours"] = round(coverage, 1)
				msg := fmt.Sprintf("%s dùng booster %s cho %s: %.1f case/h, tồn phủ %.1f giờ.",
					firstNonEmpty(n.Name, t.Name, n.Key), source, material, round(blend, 1), round(coverage, 1))
				if liveBasis != "" {
					msg += " Live basis: " + liveBasis + "."
				}
				if pressure > 0.01 {
					msg += fmt.Sprintf(" Coverage pressure %.0f%% (trước boost %.1f giờ).", round(pressure*100, 0), round(preCoverage, 1))
				}
				notes = append(notes, msg)
			} else {
				msg := fmt.Sprintf("%s dùng booster %s cho %s: %.1f case/h.",
					firstNonEmpty(n.Name, t.Name, n.Key), source, material, round(blend, 1))
				if liveBasis != "" {
					msg += " Live basis: " + liveBasis + "."
				}
				if pressure > 0.01 {
					msg += fmt.Sprintf(" Coverage pressure %.0f%%.", round(pressure*100, 0))
				}
				notes = append(notes, msg)
			}
			if blend > 0 {
				targetStock := blend * targetCoverageH
				deficitQty := math.Max(0, targetStock-stock)
				priority, score := replenishPriority(pressure, preCoverage, liveObs.BackorderPerHour)
				hasShortageSignal := deficitQty > 0 && (pressure >= 0.2 || liveObs.BackorderPerHour > 0.5)
				if deficitQty > 0 && (hasShortageSignal || pressure >= 0.01 || liveObs.BackorderPerHour > 0) {
					sources := append([]string(nil), feed.Sources...)
					projStock := stock
					projCoverage := 0.0
					applyQty := 0.0
					sourceNode := ""
					candidates := make([]any, 0, 1)
					upstreamLabel := ""
					if len(sources) > 0 {
						picked, clipped, ok := chooseUpstreamSource(sources, levels, paramsByNode, material, deficitQty)
						if ok {
							sourceNode = picked
							applyQty = clipped
							if applyQty <= 0 && deficitQty > 0 {
								applyQty = deficitQty
							}
							cfg := stockConfig(paramsByNode[sourceNode])
							override := storageOverrideValue(cfg, levels[sourceNode], material, applyQty)
							candidates = append(candidates, replenishCandidate(1, sourceNode, material, override, applyQty, score, pressure))
							upstreamLabel = nameByNode[sourceNode]
						}
					}
					projStock = stock + applyQty
					if blend > 0 {
						projCoverage = projStock / blend
					}
					finalDeficit := deficitQty
					if applyQty > 0 && applyQty < deficitQty {
						finalDeficit = applyQty
					}
					action := map[string]any{
						"subject":               n.Key,
						"label":                 nameByNode[n.Key],
						"material":              material,
						"priority":              priority,
						"priority_score":        round(score, 1),
						"source":                source,
						"provider":              ProviderHybridRuntime,
						"stock":                 round(stock, 1),
						"target_stock":          round(targetStock, 1),
						"recommended_replenish": round(finalDeficit, 1),
						"pre_coverage_hours":    round(preCoverage, 1),
						"projected_coverage_h":  round(projCoverage, 1),
						"coverage_pressure":     round(pressure, 2),
						"backorder_per_hour":    round(liveObs.BackorderPerHour, 2),
						"live_basis":            firstNonEmpty(liveBasis, liveObs.Basis),
						"upstream_sources":      sources,
						"estimated_recovery_h":  round(finalDeficit/math.Max(1e-9, blend), 1),
						"severity":              prioritySeverity(priority),
						"has_shortage_signal":   hasShortageSignal,
					}
					if len(candidates) > 0 {
						action["candidates"] = candidates
					}
					if upstreamLabel != "" {
						action["upstream_label"] = upstreamLabel
						action["upstream_node"] = sourceNode
						action["planned_replenish_qty"] = round(applyQty, 1)
					}
					reason := fmt.Sprintf("%s cần bù %.1f %s để quay về mức phủ %.1f giờ.",
						nameByNode[n.Key], round(finalDeficit, 1), material, targetCoverageH)
					if preCoverage > 0 {
						reason += fmt.Sprintf(" Hiện chỉ còn %.1f giờ phủ.", round(preCoverage, 1))
					}
					if liveObs.BackorderPerHour > 0 {
						reason += fmt.Sprintf(" Backorder đang tăng %.1f/h.", round(liveObs.BackorderPerHour, 1))
					}
					if sourceNode != "" && applyQty != deficitQty {
						reason += fmt.Sprintf(" Nguồn %s bù tối đa %.1f theo sức chứa.",
							upstreamLabel, round(applyQty, 1))
					}
					action["reason"] = reason
					replenishment = append(replenishment, action)
				}
			}
			series = append(series, row)
		}
		overrides = append(overrides, map[string]any{"target": n.Key, "path": "/demand", "value": nextDemands})
	}
	if len(overrides) == 0 {
		return nil, nil, nil
	}
	sort.Slice(replenishment, func(i, j int) bool {
		return number(replenishment[i]["priority_score"]) > number(replenishment[j]["priority_score"])
	})
	meta := map[string]any{
		"label":          "FMCG Hybrid Runtime Booster",
		"method":         "HYBRID_LIVE_FLOW_BACKORDER",
		"provider":       ProviderHybridRuntime,
		"generated_at":   now,
		"lookback_hours": lookbackHours,
		"horizon_hours":  hours,
		"series":         series,
		"notes":          notes,
		"replenishment":  replenishment,
	}
	return overrides, meta, nil
}

func round(v float64, digits int) float64 {
	p := math.Pow(10, float64(digits))
	return math.Round(v*p) / p
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
