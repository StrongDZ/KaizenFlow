package fmcg

import (
	"context"
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/kaizenflow/api/internal/simapi"
	"github.com/kaizenflow/api/internal/store"
)

type BenchmarkReport struct {
	Provider         string    `json:"provider"`
	LatencyMs        float64   `json:"latency_ms"`
	RecordsPerS      float64   `json:"records_per_s"`
	NonBlockingP95Ms float64   `json:"non_blocking_p95_ms"`
	Rating           string    `json:"rating"`
	Notes            []string  `json:"notes"`
}

func RunBenchmark(ctx context.Context, provider NowcastProvider, entries []simapi.WarehouseSeriesEntry, rounds int) (BenchmarkReport, error) {
	if rounds <= 0 {
		rounds = 10
	}
	if provider == nil {
		provider = DefaultNowcastProvider()
	}

	report := BenchmarkReport{
		Provider: provider.Name(),
		Notes:    []string{},
	}

	nEntries := len(entries)
	report.Notes = append(report.Notes, fmt.Sprintf("input_records=%d", nEntries))

	if nEntries == 0 {
		return report, fmt.Errorf("warehouse_series_log is empty")
	}

	type groupKey struct {
		NodeKey string
		SKU     string
	}
	groups := map[groupKey][]simapi.WarehouseSeriesEntry{}
	for _, e := range entries {
		k := groupKey{NodeKey: e.NodeKey, SKU: e.SKU}
		groups[k] = append(groups[k], e)
	}
	nSKU := len(groups)
	report.Notes = append(report.Notes, fmt.Sprintf("groups=%d (node_key+sku unique)", nSKU))

	sortedKeys := make([]groupKey, 0, nSKU)
	for k := range groups {
		sortedKeys = append(sortedKeys, k)
	}
	sort.Slice(sortedKeys, func(i, j int) bool {
		if sortedKeys[i].NodeKey != sortedKeys[j].NodeKey {
			return sortedKeys[i].NodeKey < sortedKeys[j].NodeKey
		}
		return sortedKeys[i].SKU < sortedKeys[j].SKU
	})

	levels := map[string]map[string]float64{}
	observations := map[string]Observation{}
	nodeKeysSeen := map[string]bool{}
	skuSeen := map[string]bool{}
	for _, k := range sortedKeys {
		rows := groups[k]
		if len(rows) == 0 {
			continue
		}
		if levels[k.NodeKey] == nil {
			levels[k.NodeKey] = map[string]float64{}
		}
		sort.Slice(rows, func(i, j int) bool { return rows[i].TsS < rows[j].TsS })
		last := rows[len(rows)-1]
		levels[k.NodeKey][k.SKU] = last.Level
		nodeKeysSeen[k.NodeKey] = true
		skuSeen[k.SKU] = true

		sum := 0.0
		count := 0
		prevLevel := 0.0
		first := true
		prevTs := 0.0
		demandRate := 0.0
		fulfilledRate := 0.0
		backorderRate := 0.0
		for _, r := range rows {
			sum += r.Level
			count++
			if !first {
				dt := r.TsS - prevTs
				if dt > 0 {
					dl := prevLevel - r.Level
					perHour := (dl / dt) * 3600.0
					if perHour > 0 {
						demandRate = perHour
						fulfilledRate = perHour
					} else if perHour < 0 {
						backorderRate = -perHour
					}
				}
			} else {
				first = false
			}
			prevLevel = r.Level
			prevTs = r.TsS
		}
		meanLevel := 0.0
		if count > 0 {
			meanLevel = sum / float64(count)
		}
		windowH := 0.0
		if len(rows) >= 2 {
			windowH = (rows[len(rows)-1].TsS - rows[0].TsS) / 3600.0
		}
		_ = meanLevel
		observations[k.NodeKey] = Observation{
			DemandPerHour:    demandRate,
			FulfilledPerHour: fulfilledRate,
			BackorderPerHour: backorderRate,
			RecentPerHour:    math.Max(demandRate, fulfilledRate),
			Basis:            "benchmark_series",
			Samples:          count,
			WindowHours:      windowH,
		}
	}

	report.Notes = append(report.Notes, fmt.Sprintf("nodes=%d skus=%d", len(nodeKeysSeen), len(skuSeen)))

	nodeList := make([]string, 0, len(nodeKeysSeen))
	for nk := range nodeKeysSeen {
		nodeList = append(nodeList, nk)
	}
	sort.Strings(nodeList)
	skuList := make([]string, 0, len(skuSeen))
	for sk := range skuSeen {
		skuList = append(skuList, sk)
	}
	sort.Strings(skuList)

	nodes := []store.GraphNode{}
	for _, nk := range nodeList {
		nodeStock := []map[string]any{}
		if lv, ok := levels[nk]; ok {
			keys := make([]string, 0, len(lv))
			for sk := range lv {
				keys = append(keys, sk)
			}
			sort.Strings(keys)
			for _, sk := range keys {
				nodeStock = append(nodeStock, map[string]any{
					"material": sk,
					"initial":  lv[sk],
					"max":      math.Max(1, lv[sk]*2),
				})
			}
		}
		demandList := []map[string]any{}
		for _, sk := range skuList {
			demandList = append(demandList, map[string]any{
				"kind":    "TAKT",
				"material": sk,
				"qty":     1.0,
				"takt":    map[string]any{"mean": 3600.0},
			})
		}
		nodes = append(nodes, store.GraphNode{
			Key:      nk,
			NodeType: "SINK_DEFAULT",
			Params: map[string]any{
				"stock":  nodeStock,
				"demand": demandList,
			},
		})
	}

	edges := []store.GraphEdge{}
	for idx, nk := range nodeList {
		upstream := fmt.Sprintf("STG_%d", idx)
		nodes = append(nodes, store.GraphNode{
			Key:      upstream,
			NodeType: "STORAGE_DEFAULT",
			Params: map[string]any{
				"stock": func() []map[string]any {
					out := []map[string]any{}
					for _, sk := range skuList {
						out = append(out, map[string]any{
							"material": sk,
							"initial":  10000.0,
							"max":      50000.0,
						})
					}
					return out
				}(),
			},
		})
		for _, sk := range skuList {
			edges = append(edges, store.GraphEdge{
				Key:      fmt.Sprintf("%s>%s:%s", upstream, nk, sk),
				Src:      upstream,
				Dst:      nk,
				Material: sk,
				Params: map[string]any{
					"qty":          1.0,
					"lead_time_s":  3600.0,
				},
			})
		}
	}

	types := map[string]store.NodeType{
		"SINK_DEFAULT": {
			Code:      "SINK_DEFAULT",
			Name:      "Sink",
			Archetype: "SINK",
		},
		"STORAGE_DEFAULT": {
			Code:      "STORAGE_DEFAULT",
			Name:      "Storage",
			Archetype: "STORAGE",
		},
	}

	graph := &store.Graph{
		ModelKey: ModelKey,
		Nodes:    nodes,
		Edges:    edges,
		Settings: map[string]any{},
	}

	horizonS := 168.0 * 3600.0
	now := time.Now()

	baseReq := BuildRequest{
		Graph:        graph,
		Types:        types,
		Levels:       levels,
		Observations: observations,
		Now:          now,
		HorizonS:     horizonS,
	}

	tryBuild := func(p NowcastProvider, req BuildRequest) (BuildResult, error) {
		return p.BuildNowcast(ctx, req)
	}

	activeProvider := provider
	if _, err := tryBuild(activeProvider, baseReq); err != nil {
		if activeProvider.Name() == ProviderProjectM {
			hybrid := DefaultNowcastProvider()
			report.Notes = append(report.Notes, fmt.Sprintf("project_m failed (%v); fallback %s", err, hybrid.Name()))
			activeProvider = hybrid
		}
	}
	report.Provider = activeProvider.Name()

	_, err := tryBuild(activeProvider, baseReq)
	if err != nil {
		return report, err
	}

	roundTimes := make([]float64, 0, rounds)
	var totalTime time.Duration = 0
	for i := 0; i < rounds; i++ {
		reqI := baseReq
		reqI.Now = now.Add(time.Duration(i) * time.Second)
		start := time.Now()
		_, err := tryBuild(activeProvider, reqI)
		elapsed := time.Since(start)
		if err != nil {
			return report, err
		}
		roundTimes = append(roundTimes, float64(elapsed.Microseconds())/1000.0)
		totalTime += elapsed
	}

	report.LatencyMs = float64(totalTime.Microseconds()) / 1000.0
	if report.LatencyMs > 0 {
		report.RecordsPerS = (float64(nEntries) * float64(rounds) * 1000.0) / report.LatencyMs
	}

	p95 := percentile95(roundTimes)
	report.NonBlockingP95Ms = p95

	meanLatency := 0.0
	if len(roundTimes) > 0 {
		sum := 0.0
		for _, rt := range roundTimes {
			sum += rt
		}
		meanLatency = sum / float64(len(roundTimes))
	}
	report.Notes = append(report.Notes, fmt.Sprintf("rounds=%d mean_round_ms=%.2f", rounds, meanLatency))

	goodLatency := report.LatencyMs < 3000.0
	goodP95 := meanLatency == 0.0 ||
		meanLatency < 0.5 ||
		(meanLatency > 0.0 && (p95/meanLatency) < 1.20)

	switch {
	case goodLatency && goodP95:
		report.Rating = "TỐT"
	case !goodLatency && !goodP95:
		report.Rating = "RỦI RO CAO"
	default:
		report.Rating = "CẦN CẢI THIỆN"
	}
	report.Notes = append(report.Notes, fmt.Sprintf("latency_ok=%v p95_ok=%v (p95/mean=%.2f%%)",
		goodLatency, goodP95, func() float64 {
			if meanLatency > 0 {
				return (p95 / meanLatency) * 100
			}
			return 0
		}()))

	return report, nil
}

func percentile95(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	cp := make([]float64, len(values))
	copy(cp, values)
	sort.Float64s(cp)
	n := len(cp)
	idx := int(math.Ceil(0.95 * float64(n)))
	if idx < 1 {
		idx = 1
	}
	if idx > n {
		idx = n
	}
	return cp[idx-1]
}
