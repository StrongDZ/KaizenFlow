package fmcg

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/kaizenflow/api/internal/resolve"
	"github.com/kaizenflow/api/internal/store"
)

const (
	ProviderProjectM = "project_m"
	projectMBridge   = "scripts/project_m_bridge.py"
)

type projectMProvider struct{}

type projectMRequest struct {
	ProjectRoot string               `json:"project_root"`
	Items       []projectMRequestRow `json:"items"`
}

type projectMRequestRow struct {
	ID           string  `json:"id"`
	SKU          int     `json:"sku_id"`
	HorizonWeeks float64 `json:"horizon_weeks"`
}

type projectMResponse struct {
	Items []projectMResponseRow `json:"items"`
}

type projectMResponseRow struct {
	ID          string    `json:"id"`
	SKU         int       `json:"sku_id"`
	Backend     string    `json:"backend"`
	UsedML      bool      `json:"used_ml"`
	Preds       []float64 `json:"preds"`
	HistoryMean float64   `json:"history_mean"`
	Brand       string    `json:"brand"`
	ABCCategory string    `json:"abc_category"`
	Error       string    `json:"error"`
}

func init() {
	RegisterNowcastProvider(projectMProvider{})
}

func (projectMProvider) Name() string { return ProviderProjectM }

func (projectMProvider) BuildNowcast(ctx context.Context, req BuildRequest) (BuildResult, error) {
	if req.Graph == nil || req.Graph.ModelKey != ModelKey {
		return BuildResult{}, nil
	}
	projectRoot, err := resolveProjectMRoot()
	if err != nil {
		return BuildResult{}, err
	}
	bridgePath, err := resolveBridgePath()
	if err != nil {
		return BuildResult{}, err
	}
	pythonBin := strings.TrimSpace(os.Getenv("KF_PROJECT_M_PYTHON"))
	if pythonBin == "" {
		pythonBin = "python3"
	}
	hours := int(math.Ceil(req.HorizonS / 3600))
	if hours < 1 {
		hours = 1
	}
	upstream := incomingStorageFeeds(req.Graph, req.Types, req.Levels)
	paramsByNode := map[string]map[string]any{}
	nameByNode := map[string]string{}
	caseFactorByMaterial := map[string]float64{}
	requests := []projectMRequestRow{}
	contextByKey := map[string]struct {
		subject string
		label   string
		material string
		demand  map[string]any
		feed    storageFeed
		liveObs Observation
		params  map[string]any
	}{}
	for _, n := range req.Graph.Nodes {
		t, ok := req.Types[n.NodeType]
		if !ok {
			continue
		}
		p, err := resolve.MergeNodeParams(t, n)
		if err != nil {
			return BuildResult{}, &resolve.IssueError{Key: n.Key, Msg: err.Error()}
		}
		paramsByNode[n.Key] = p
		nameByNode[n.Key] = firstNonEmpty(n.Name, t.Name, n.Key)
		collectCaseFactors(caseFactorByMaterial, p)
	}
	for _, n := range req.Graph.Nodes {
		t, ok := req.Types[n.NodeType]
		if !ok || t.Archetype != "SINK" {
			continue
		}
		params := paramsByNode[n.Key]
		rawDemands, _ := params["demand"].([]any)
		for _, raw := range rawDemands {
			d, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			material, _ := d["material"].(string)
			if !strings.HasPrefix(material, "CASE-") {
				continue
			}
			skuID, ok := materialToSKU(material)
			if !ok {
				continue
			}
			key := n.Key + "|" + material
			contextByKey[key] = struct {
				subject string
				label   string
				material string
				demand  map[string]any
				feed    storageFeed
				liveObs Observation
				params  map[string]any
			}{
				subject: n.Key,
				label:   nameByNode[n.Key],
				material: material,
				demand:  d,
				feed:    upstream[n.Key][material],
				liveObs: req.Observations[n.Key],
				params:  params,
			}
			requests = append(requests, projectMRequestRow{ID: key, SKU: skuID, HorizonWeeks: math.Ceil(float64(hours) / (24 * 7))})
		}
	}
	if len(requests) == 0 {
		return BuildResult{}, nil
	}
	predictions, err := runProjectMBridge(ctx, pythonBin, bridgePath, projectMRequest{ProjectRoot: projectRoot, Items: requests})
	if err != nil {
		return BuildResult{}, err
	}
	overrides := []map[string]any{}
	series := []map[string]any{}
	notes := []string{}
	replenishment := []map[string]any{}
	for _, n := range req.Graph.Nodes {
		t, ok := req.Types[n.NodeType]
		if !ok || t.Archetype != "SINK" {
			continue
		}
		params := paramsByNode[n.Key]
		rawDemands, _ := params["demand"].([]any)
		nextDemands := make([]any, 0, len(rawDemands))
		for _, raw := range rawDemands {
			d, ok := raw.(map[string]any)
			if !ok {
				nextDemands = append(nextDemands, raw)
				continue
			}
			material, _ := d["material"].(string)
			key := n.Key + "|" + material
			pred, ok := predictions[key]
			if !ok {
				nextDemands = append(nextDemands, d)
				continue
			}
			ctxRow := contextByKey[key]
			weeklyCase := divideAll(pred.Preds, math.Max(1, caseFactorByMaterial[material]))
			hourlyBase := expandWeeklyPredictions(req.Now, hours, weeklyCase)
			localBasePerHour := baselinePerHour(ctxRow.demand)
			historyCaseWeekly := pred.HistoryMean / math.Max(1, caseFactorByMaterial[material])
			projectMultiplier := 1.0
			if historyCaseWeekly > 0 {
				projectMultiplier = clamp(mean(weeklyCase)/historyCaseWeekly, 0.35, 3.0)
			}
			basePerHour := localBasePerHour * projectMultiplier
			if basePerHour <= 0 {
				basePerHour = mean(hourlyBase)
			}
			feed := ctxRow.feed
			stock := feed.Stock
			recent, liveBasis := effectiveRecent(ctxRow.liveObs)
			blend, source, liveBasis, pressure, preCoverage := chooseBlend(basePerHour, ctxRow.liveObs, stock)
			hourlyRate := scaleProfile(hourlyBase, blend, req.Now)
			if len(hourlyRate) == 0 {
				hourlyRate = forecastCurve(req.Now, hours, blend)
			}
			nextDemands = append(nextDemands, map[string]any{
				"kind":        "FORECAST",
				"material":    material,
				"hourly_rate": hourlyRate,
			})
			row := map[string]any{
				"subject":              n.Key,
				"label":                nameByNode[n.Key],
				"material":             material,
				"source":               "project_m+" + source,
				"provider":             ProviderProjectM,
				"project_m_backend":    pred.Backend,
				"project_m_used_ml":    pred.UsedML,
				"sku_id":               float64(pred.SKU),
				"brand":                pred.Brand,
				"abc_category":         pred.ABCCategory,
				"units_per_case":       round(math.Max(1, caseFactorByMaterial[material]), 2),
				"local_baseline_per_hour": round(localBasePerHour, 2),
				"project_m_multiplier": round(projectMultiplier, 2),
				"baseline_per_hour":    round(basePerHour, 2),
				"blend_per_hour":       round(blend, 2),
				"hourly_rate":          hourlyRate,
				"project_m_weekly_raw": pred.Preds,
				"project_m_weekly_case": weeklyCase,
			}
			if preCoverage > 0 {
				row["pre_coverage_hours"] = round(preCoverage, 1)
			}
			if pressure > 0 {
				row["coverage_pressure"] = round(pressure, 2)
			}
			if recent > 0 {
				row["recent_per_hour"] = round(recent, 2)
				row["live_basis"] = firstNonEmpty(liveBasis, ctxRow.liveObs.Basis)
				row["live_window_hours"] = round(ctxRow.liveObs.WindowHours, 2)
				row["live_samples"] = ctxRow.liveObs.Samples
				if ctxRow.liveObs.DemandPerHour > 0 {
					row["demand_per_hour"] = round(ctxRow.liveObs.DemandPerHour, 2)
				}
				if ctxRow.liveObs.FulfilledPerHour > 0 {
					row["fulfilled_per_hour"] = round(ctxRow.liveObs.FulfilledPerHour, 2)
				}
				if ctxRow.liveObs.BackorderPerHour != 0 {
					row["backorder_per_hour"] = round(ctxRow.liveObs.BackorderPerHour, 2)
				}
			}
			if stock > 0 && blend > 0 {
				coverage := stock / blend
				row["coverage_hours"] = round(coverage, 1)
			}
			notes = append(notes, buildProjectMNote(row, liveBasis))
			if blend > 0 {
				targetStock := blend * targetCoverageH
				deficitQty := math.Max(0, targetStock-stock)
				priority, score := replenishPriority(pressure, preCoverage, ctxRow.liveObs.BackorderPerHour)
				if deficitQty > 0 && (pressure >= 0.2 || ctxRow.liveObs.BackorderPerHour > 0.5) {
					sources := append([]string(nil), feed.Sources...)
					action := map[string]any{
						"subject":               n.Key,
						"label":                 nameByNode[n.Key],
						"material":              material,
						"priority":              priority,
						"priority_score":        round(score, 1),
						"source":                "project_m+" + source,
						"provider":              ProviderProjectM,
						"project_m_backend":     pred.Backend,
						"project_m_used_ml":     pred.UsedML,
						"sku_id":                float64(pred.SKU),
						"stock":                 round(stock, 1),
						"target_stock":          round(targetStock, 1),
						"recommended_replenish": round(deficitQty, 1),
						"pre_coverage_hours":    round(preCoverage, 1),
						"projected_coverage_h":  round(stock/blend, 1),
						"coverage_pressure":     round(pressure, 2),
						"backorder_per_hour":    round(ctxRow.liveObs.BackorderPerHour, 2),
						"live_basis":            firstNonEmpty(liveBasis, ctxRow.liveObs.Basis),
						"upstream_sources":      sources,
						"estimated_recovery_h":  round(deficitQty/blend, 1),
						"severity":              prioritySeverity(priority),
					}
					if len(sources) > 0 {
						sourceNode := sources[0]
						cfg := stockConfig(paramsByNode[sourceNode])
						override := storageOverrideValue(cfg, req.Levels[sourceNode], material, deficitQty)
						action["candidates"] = []any{
							replenishCandidate(1, sourceNode, material, override, deficitQty, score, pressure),
						}
						action["upstream_label"] = nameByNode[sourceNode]
					}
					action["reason"] = fmt.Sprintf("%s dùng project M (%s) và cần bù %.1f %s để quay về mức phủ %.1f giờ.",
						nameByNode[n.Key], pred.Backend, round(deficitQty, 1), material, targetCoverageH)
					replenishment = append(replenishment, action)
				}
			}
			series = append(series, row)
		}
		overrides = append(overrides, map[string]any{"target": n.Key, "path": "/demand", "value": nextDemands})
	}
	if len(overrides) == 0 {
		return BuildResult{}, nil
	}
	sort.Slice(replenishment, func(i, j int) bool {
		return number(replenishment[i]["priority_score"]) > number(replenishment[j]["priority_score"])
	})
	meta := map[string]any{
		"label":          "Project M Forecast Provider",
		"method":         "PROJECT_M_BIMBO_WEEKLY_TO_HOURLY",
		"provider":       ProviderProjectM,
		"generated_at":   req.Now,
		"lookback_hours": lookbackHours,
		"horizon_hours":  hours,
		"series":         series,
		"notes":          notes,
		"replenishment":  replenishment,
	}
	return BuildResult{Overrides: overrides, Meta: meta}, nil
}

func runProjectMBridge(ctx context.Context, pythonBin, bridgePath string, req projectMRequest) (map[string]projectMResponseRow, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, pythonBin, bridgePath)
	cmd.Stdin = bytes.NewReader(body)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return nil, fmt.Errorf("project M bridge failed: %s", msg)
	}
	var res projectMResponse
	if err := json.Unmarshal(stdout.Bytes(), &res); err != nil {
		return nil, fmt.Errorf("decode project M bridge response: %w", err)
	}
	out := map[string]projectMResponseRow{}
	for _, item := range res.Items {
		if item.Error != "" {
			return nil, fmt.Errorf("project M forecast error for %s: %s", item.ID, item.Error)
		}
		out[item.ID] = item
	}
	return out, nil
}

func resolveProjectMRoot() (string, error) {
	if v := strings.TrimSpace(os.Getenv("KF_PROJECT_M_ROOT")); v != "" {
		if dirExists(v) {
			return v, nil
		}
		return "", fmt.Errorf("KF_PROJECT_M_ROOT not found: %s", v)
	}
	if home, err := os.UserHomeDir(); err == nil {
		candidate := filepath.Join(home, "Desktop", "M")
		if dirExists(candidate) {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("project M root not found; set KF_PROJECT_M_ROOT")
}

func resolveBridgePath() (string, error) {
	if v := strings.TrimSpace(os.Getenv("KF_PROJECT_M_BRIDGE")); v != "" {
		if fileExists(v) {
			return v, nil
		}
		return "", fmt.Errorf("KF_PROJECT_M_BRIDGE not found: %s", v)
	}
	if wd, err := os.Getwd(); err == nil {
		dir := wd
		for {
			candidate := filepath.Join(dir, projectMBridge)
			if fileExists(candidate) {
				return candidate, nil
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return "", fmt.Errorf("project M bridge not found; set KF_PROJECT_M_BRIDGE")
}

func materialToSKU(material string) (int, bool) {
	if v := strings.TrimSpace(material); v != "" {
		i := strings.LastIndex(v, "-")
		if i >= 0 && i+1 < len(v) {
			n, err := strconv.Atoi(strings.TrimLeft(v[i+1:], "0"))
			if err == nil && n > 0 {
				return n, true
			}
		}
	}
	return 0, false
}

func collectCaseFactors(out map[string]float64, params map[string]any) {
	rawRecipes, _ := params["recipes"].([]any)
	for _, raw := range rawRecipes {
		recipe, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		inputs := anyMaps(recipe["inputs"])
		outputs := anyMaps(recipe["outputs"])
		if len(inputs) == 0 || len(outputs) == 0 {
			continue
		}
		inQty := number(inputs[0]["qty"])
		if inQty <= 0 {
			continue
		}
		for _, outRow := range outputs {
			material, _ := outRow["material"].(string)
			outQty := number(outRow["qty"])
			if !strings.HasPrefix(material, "CASE-") || outQty <= 0 {
				continue
			}
			if _, exists := out[material]; !exists {
				out[material] = inQty / outQty
			}
		}
	}
}

func anyMaps(v any) []map[string]any {
	raw, _ := v.([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		m, ok := item.(map[string]any)
		if ok {
			out = append(out, m)
		}
	}
	return out
}

func divideAll(values []float64, divisor float64) []float64 {
	if len(values) == 0 {
		return nil
	}
	if divisor <= 0 {
		divisor = 1
	}
	out := make([]float64, len(values))
	for i, v := range values {
		out[i] = v / divisor
	}
	return out
}

func expandWeeklyPredictions(start time.Time, hours int, weekly []float64) []float64 {
	if hours < 1 || len(weekly) == 0 {
		return nil
	}
	out := make([]float64, hours)
	for week := 0; week*168 < hours && week < len(weekly); week++ {
		from := week * 168
		to := (week + 1) * 168
		if to > hours {
			to = hours
		}
		weights := make([]float64, to-from)
		sum := 0.0
		for i := from; i < to; i++ {
			t := start.Add(time.Duration(i) * time.Hour)
			w := weekdayWeights[int(t.Weekday())] * hourWeights[t.Hour()]
			weights[i-from] = w
			sum += w
		}
		if sum <= 0 {
			sum = float64(len(weights))
			for i := range weights {
				weights[i] = 1
			}
		}
		total := math.Max(0, weekly[week])
		for i := from; i < to; i++ {
			out[i] = total * weights[i-from] / sum
		}
	}
	return out
}

func scaleProfile(base []float64, targetMean float64, start time.Time) []float64 {
	if len(base) == 0 {
		return nil
	}
	currentMean := mean(base)
	if currentMean <= 0 {
		return forecastCurve(start, len(base), targetMean)
	}
	scale := targetMean / currentMean
	out := make([]float64, len(base))
	for i, v := range base {
		out[i] = math.Max(0, v*scale)
	}
	return out
}

func mean(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sum := 0.0
	for _, v := range values {
		sum += v
	}
	return sum / float64(len(values))
}

func buildProjectMNote(row map[string]any, liveBasis string) string {
	msg := fmt.Sprintf("%v dùng project M (%v) cho %v: %.1f case/h.",
		row["label"], row["project_m_backend"], row["material"], number(row["blend_per_hour"]))
	if row["coverage_hours"] != nil {
		msg = fmt.Sprintf("%s Tồn phủ %.1f giờ.", strings.TrimSuffix(msg, "."), number(row["coverage_hours"]))
	}
	if liveBasis != "" {
		msg += " Live basis: " + liveBasis + "."
	}
	if row["coverage_pressure"] != nil {
		msg += fmt.Sprintf(" Coverage pressure %.0f%%.", round(number(row["coverage_pressure"])*100, 0))
	}
	return msg
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}
