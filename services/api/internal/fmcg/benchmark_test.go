package fmcg

import (
	"context"
	"math"
	"strings"
	"testing"

	"github.com/kaizenflow/api/internal/simapi"
)

func gen168h5SKU() []simapi.WarehouseSeriesEntry {
	skus := []string{"CASE-1001", "CASE-1002", "CASE-1003", "CASE-1004", "CASE-1005"}
	nodes := []string{"WH-A"}
	entries := []simapi.WarehouseSeriesEntry{}
	for _, nk := range nodes {
		for _, sk := range skus {
			level := 500.0
			for h := 0; h < 168; h++ {
				draw := 2.0 + float64(h%7)*0.3
				level = level - draw
				if level < 50 {
					level = 500
				}
				color := "green"
				coverageH := level / math.Max(1, draw)
				if coverageH < 6 {
					color = "red"
				} else if coverageH < 18 {
					color = "yellow"
				}
				entries = append(entries, simapi.WarehouseSeriesEntry{
					TsS:       float64(h) * 3600.0,
					SKU:       sk,
					NodeKey:   nk,
					Level:     level,
					Capacity:  1000,
					CoverageH: coverageH,
					Color:     color,
				})
			}
		}
	}
	return entries
}

func Test_TR31_Benchmark168h5SKU_ReportHasAllRequiredFields(t *testing.T) {
	ctx := context.Background()
	entries := gen168h5SKU()
	wantCount := 1 * 5 * 168
	if len(entries) != wantCount {
		t.Fatalf("entries count: got %d want %d", len(entries), wantCount)
	}
	report, err := RunBenchmark(ctx, nil, entries, 3)
	if err != nil {
		t.Fatalf("RunBenchmark err: %v", err)
	}
	if report.Provider == "" {
		t.Errorf("report.Provider empty")
	}
	if report.Rating == "" {
		t.Errorf("report.Rating empty; want one of TỐT|CẦN CẢI THIỆN|RỦI RO CAO")
	}
	ratingOK := report.Rating == "TỐT" || report.Rating == "CẦN CẢI THIỆN" || report.Rating == "RỦI RO CAO"
	if !ratingOK {
		t.Errorf("report.Rating=%q invalid enum", report.Rating)
	}
	if len(report.Notes) < 3 {
		t.Errorf("report.Notes count=%d; want >=3 (records, groups, nodes/skus)", len(report.Notes))
	}
}

func Test_TR32_MetricsPositiveAndFinite(t *testing.T) {
	ctx := context.Background()
	entries := gen168h5SKU()
	report, err := RunBenchmark(ctx, nil, entries, 3)
	if err != nil {
		t.Fatalf("RunBenchmark err: %v", err)
	}
	if math.IsNaN(report.LatencyMs) || math.IsInf(report.LatencyMs, 0) || report.LatencyMs <= 0 {
		t.Errorf("LatencyMs=%v invalid; want >0 finite", report.LatencyMs)
	}
	if math.IsNaN(report.RecordsPerS) || math.IsInf(report.RecordsPerS, 0) || report.RecordsPerS <= 0 {
		t.Errorf("RecordsPerS=%v invalid; want >0 finite", report.RecordsPerS)
	}
	if math.IsNaN(report.NonBlockingP95Ms) || math.IsInf(report.NonBlockingP95Ms, 0) || report.NonBlockingP95Ms <= 0 {
		t.Errorf("NonBlockingP95Ms=%v invalid; want >0 finite", report.NonBlockingP95Ms)
	}
}

type failingProvider struct{}

func (failingProvider) Name() string { return ProviderProjectM }
func (failingProvider) BuildNowcast(_ context.Context, _ BuildRequest) (BuildResult, error) {
	return BuildResult{}, context.DeadlineExceeded
}

func Test_TR33_FallbackNoPanicWhenProviderFails(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("RunBenchmark panicked: %v", r)
		}
	}()
	ctx := context.Background()
	entries := gen168h5SKU()
	report, err := RunBenchmark(ctx, failingProvider{}, entries, 3)
	if err != nil {
		t.Fatalf("RunBenchmark err: %v (expected fallback)", err)
	}
	if !strings.Contains(report.Provider, ProviderHybridRuntime) {
		t.Errorf("want fallback provider %q; got %q", ProviderHybridRuntime, report.Provider)
	}
	if report.LatencyMs <= 0 || report.RecordsPerS <= 0 || report.NonBlockingP95Ms <= 0 {
		t.Errorf("metrics invalid after fallback: LatencyMs=%.2f RecordsPerS=%.2f P95=%.2f",
			report.LatencyMs, report.RecordsPerS, report.NonBlockingP95Ms)
	}
}

func Test_TR33_NilProviderUsesDefault(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("RunBenchmark panicked with nil provider: %v", r)
		}
	}()
	ctx := context.Background()
	entries := gen168h5SKU()
	report, err := RunBenchmark(ctx, nil, entries, 3)
	if err != nil {
		t.Fatalf("RunBenchmark err: %v", err)
	}
	if report.Provider != ProviderHybridRuntime {
		t.Errorf("nil provider should fallback to %q; got %q", ProviderHybridRuntime, report.Provider)
	}
}
