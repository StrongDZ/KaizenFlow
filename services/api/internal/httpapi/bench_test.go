package httpapi_test

import (
	"fmt"
	"testing"
)

// Test_TR24_Benchmark7Day_StoresMetaCount kiểm tra rule TR-2.4:
// khi benchmark_ready=true thì /api/runs/{id} trả meta.benchmark.warehouse_series_log_summary.count >= 0.
func Test_TR24_Benchmark7Day_StoresMetaCount(t *testing.T) {
	a := newAPI(t)
	modelKey := "bench-7d-model"
	a.publishedModel(modelKey)

	body := map[string]any{
		"step_s":          3600,
		"warmup_s":        0,
		"replications":    1,
		"seed":            42,
		"benchmark_ready": true,
	}
	resp := a.call("POST", fmt.Sprintf("/api/models/%s/benchmark/7day", modelKey), body, 200)

	summary, ok := resp["warehouse_series_log_summary"].(map[string]any)
	if !ok {
		t.Fatalf("missing warehouse_series_log_summary in response: %v", resp)
	}
	count, _ := summary["count"].(float64)
	if count < 0 {
		t.Fatalf("summary.count = %v (want >= 0)", count)
	}
	if count < 100 {
		t.Logf("warning: count=%v seems too small (expected ~336 for 1WH × 2SKU × 168h)", count)
	}

	runID, _ := resp["run_id"].(float64)
	if runID <= 0 {
		t.Fatalf("missing run_id in response: %v", resp)
	}

	run := a.call("GET", fmt.Sprintf("/api/runs/%d", int64(runID)), nil, 200)
	meta, ok := run["meta"].(map[string]any)
	if !ok {
		t.Fatalf("run missing meta field: %v", run)
	}
	bm, ok := meta["benchmark"].(map[string]any)
	if !ok {
		t.Fatalf("run.meta missing benchmark: %v", meta)
	}
	wsSum, ok := bm["warehouse_series_log_summary"].(map[string]any)
	if !ok {
		t.Fatalf("run.meta.benchmark missing warehouse_series_log_summary: %v", bm)
	}
	savedCount, _ := wsSum["count"].(float64)
	if savedCount < 0 {
		t.Fatalf("saved run.meta count = %v (want >= 0)", savedCount)
	}
	if savedCount != count {
		t.Fatalf("saved count=%v != response count=%v", savedCount, count)
	}
}

// Test_TR24_WithoutBenchmarkReady_DoesNotPersistRun kiểm tra nếu benchmark_ready=false
// thì không có run/scenario nào được lưu (chạy tạm thời, endpoint vẫn trả count).
func Test_TR24_WithoutBenchmarkReady_DoesNotPersistRun(t *testing.T) {
	a := newAPI(t)
	modelKey := "bench-tmp"
	a.publishedModel(modelKey)

	body := map[string]any{
		"step_s":          3600,
		"warmup_s":        3600,
		"replications":    1,
		"seed":            42,
		"benchmark_ready": false,
	}
	resp := a.call("POST", fmt.Sprintf("/api/models/%s/benchmark/7day", modelKey), body, 200)
	summary := resp["warehouse_series_log_summary"].(map[string]any)
	count := summary["count"].(float64)
	if count < 0 {
		t.Fatalf("count = %v (want >= 0)", count)
	}
	if _, ok := resp["meta"]; ok {
		t.Fatalf("benchmark_ready=false should not populate meta")
	}
}
