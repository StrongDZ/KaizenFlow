package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gauge-twin/edge/decode"
	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

func f64p(v float64) *float64 { return &v }

func testDial(t *testing.T) *decode.Gauge {
	t.Helper()
	cfg, err := ParseConfig([]byte(draftConfig))
	if err != nil {
		t.Fatal(err)
	}
	g, err := decode.NewGauge(cfg.GetGauges()[0])
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func TestJudgeDialWithinToleranceOfFullScale(t *testing.T) {
	rules := DefaultAcceptanceRules() // 2% of the 200 bar range: 4 bar
	for _, tc := range []struct {
		read   float64
		passed bool
	}{{100, true}, {103.9, true}, {104.5, false}, {95, false}} {
		s := AcceptanceSample{Truth: 100}
		judge(&s, testDial(t), GaugePreview{Value: f64p(tc.read), Quality: 0.9}, rules)
		if s.Passed != tc.passed || s.Tolerance != 4 || s.FullScale != 200 || !s.QualityOK {
			t.Errorf("read %v: %+v", tc.read, s)
		}
		if !tc.passed && !strings.Contains(s.Reason, "lệch") {
			t.Errorf("read %v: a failed sample says by how much: %q", tc.read, s.Reason)
		}
	}
}

func TestJudgeDigitsMustMatchAndUnreadableFails(t *testing.T) {
	seg7, err := decode.NewGauge(&gaugev1.Gauge{GaugeId: "V", Type: decode.TypeSeg7, Roi: []int32{0, 0, 96, 48},
		Calib: &gaugev1.Calib{Digits: u32p(4), DecimalPos: u32p(3)}})
	if err != nil {
		t.Fatal(err)
	}
	rules := DefaultAcceptanceRules()
	// One decimal: 220.5 typed as 220.5 passes, the next step does not.
	right, wrong := AcceptanceSample{Truth: 220.5}, AcceptanceSample{Truth: 220.5}
	judge(&right, seg7, GaugePreview{Value: f64p(220.5), Quality: 0.5}, rules)
	judge(&wrong, seg7, GaugePreview{Value: f64p(220.6), Quality: 0.9}, rules)
	if !right.Passed || right.QualityOK || wrong.Passed {
		t.Errorf("right %+v wrong %+v", right, wrong)
	}
	unread := AcceptanceSample{Truth: 220.5}
	judge(&unread, seg7, GaugePreview{Flags: []string{"FLAG_GLARE"}}, rules)
	if unread.Passed || unread.Value != nil || !strings.Contains(unread.Reason, "FLAG_GLARE") {
		t.Errorf("unreadable: %+v", unread)
	}
}

func u32p(v uint32) *uint32 { return &v }

func TestVerdictNeedsEnoughPassingSamplesAndNoFailure(t *testing.T) {
	rules := DefaultAcceptanceRules()
	sample := func(gauge string, ts int64, passed, qualityOK bool) AcceptanceSample {
		return AcceptanceSample{GaugeID: gauge, TsMs: ts, Passed: passed, QualityOK: qualityOK}
	}
	got := SummariseAcceptance([]AcceptanceSample{
		sample("B", 3, true, true), sample("A", 2, true, true), sample("A", 1, true, false), sample("A", 3, true, true),
		sample("C", 1, true, true), sample("C", 2, false, true), sample("C", 3, true, true), sample("C", 4, true, true),
	}, rules)
	if len(got) != 3 || got[0].GaugeID != "A" || got[1].GaugeID != "B" || got[2].GaugeID != "C" {
		t.Fatalf("gauges: %+v", got)
	}
	a, b, c := got[0], got[1], got[2]
	if a.Verdict != VerdictAccepted || a.Passed != 3 || a.LowQuality != 1 || a.Samples[0].TsMs != 1 {
		t.Errorf("A: %+v", a)
	}
	if b.Verdict != VerdictIncomplete || b.Needed != 2 {
		t.Errorf("B: %+v", b)
	}
	// One wrong reading rejects the gauge however many are right.
	if c.Verdict != VerdictRejected || c.Failed != 1 || c.Passed != 3 {
		t.Errorf("C: %+v", c)
	}
}

func acceptanceMux(t *testing.T, previewURL, dir string) *http.ServeMux {
	t.Helper()
	mux := http.NewServeMux()
	c := NewCommissioning(newMemStore(), previewURL)
	a := NewAcceptance(c, NewDirSampleStore(dir), DefaultAcceptanceRules())
	tick := int64(1_700_000_000_000)
	a.now = func() time.Time { tick += 1000; return time.UnixMilli(tick) }
	a.Register(mux)
	return mux
}

func do(t *testing.T, mux http.Handler, method, path, body string) (int, map[string]any, []byte) {
	t.Helper()
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(method, path, strings.NewReader(body)))
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out, rec.Body.Bytes()
}

func TestAcceptanceRecordsSamplesWithTheirFrameAndGivesAVerdict(t *testing.T) {
	var calls []map[string]any
	preview := fakePreview(t, &calls)
	defer preview.Close()
	dir := t.TempDir()
	mux := acceptanceMux(t, preview.URL, dir)
	frame := base64.StdEncoding.EncodeToString([]byte("jpeg-bytes"))
	// The fake preview always reads 100 bar (needle straight up).
	body := func(truth string) string {
		return `{"config": ` + draftConfig + `, "gauge_id": "DIAL", "truth": ` + truth + `, "frame_jpeg": "` + frame + `"}`
	}

	var out map[string]any
	for i, truth := range []string{"100", "101.5", "99"} {
		code, got, _ := do(t, mux, http.MethodPost, "/v1/commissioning/acceptance", body(truth))
		if code != http.StatusOK {
			t.Fatalf("sample %d: status %d: %v", i, code, got)
		}
		out = got
	}
	sample := out["sample"].(map[string]any)
	if sample["passed"] != true || sample["value"].(float64) < 99.5 || sample["full_scale"].(float64) != 200 {
		t.Errorf("sample: %v", sample)
	}
	gauge := out["gauges"].([]any)[0].(map[string]any)
	if gauge["verdict"] != VerdictAccepted || gauge["passed"].(float64) != 3 {
		t.Errorf("after three right samples: %v", gauge)
	}

	// A fourth sample 10 bar off (5% of the range) rejects the gauge.
	_, out, _ = do(t, mux, http.MethodPost, "/v1/commissioning/acceptance", body("110"))
	gauge = out["gauges"].([]any)[0].(map[string]any)
	if out["sample"].(map[string]any)["passed"] != false || gauge["verdict"] != VerdictRejected {
		t.Errorf("after a wrong sample: %v", out)
	}

	// Every sample is on disk with its frame, and the frame can be fetched.
	records, _ := filepath.Glob(filepath.Join(dir, "M1", "DIAL", "*.json"))
	frames, _ := filepath.Glob(filepath.Join(dir, "M1", "DIAL", "*.jpg"))
	if len(records) != 4 || len(frames) != 4 {
		t.Fatalf("stored %d records and %d frames", len(records), len(frames))
	}
	id := strings.TrimSuffix(filepath.Base(frames[0]), ".jpg")
	code, _, raw := do(t, mux, http.MethodGet, "/v1/commissioning/acceptance/M1/DIAL/"+id+".jpg", "")
	if code != http.StatusOK || string(raw) != "jpeg-bytes" {
		t.Errorf("frame: status %d body %q", code, raw)
	}

	// Listing gives the same state; clearing starts the gauge over.
	_, out, _ = do(t, mux, http.MethodGet, "/v1/commissioning/acceptance/M1", "")
	if len(out["gauges"].([]any)[0].(map[string]any)["samples"].([]any)) != 4 {
		t.Errorf("list: %v", out)
	}
	code, out, _ = do(t, mux, http.MethodDelete, "/v1/commissioning/acceptance/M1/DIAL", "")
	if code != http.StatusOK || len(out["gauges"].([]any)) != 0 {
		t.Errorf("clear: %d %v", code, out)
	}
	if _, err := os.Stat(filepath.Join(dir, "M1", "DIAL")); !os.IsNotExist(err) {
		t.Errorf("samples still on disk: %v", err)
	}
}

func TestAcceptanceTakesAFreshFrameWhenNoneIsSent(t *testing.T) {
	var calls []map[string]any
	preview := fakePreview(t, &calls)
	defer preview.Close()
	dir := t.TempDir()
	mux := acceptanceMux(t, preview.URL, dir)

	code, out, _ := do(t, mux, http.MethodPost, "/v1/commissioning/acceptance",
		`{"config": `+draftConfig+`, "gauge_id": "DIAL", "truth": 100}`)

	if code != http.StatusOK || out["sample"].(map[string]any)["passed"] != true {
		t.Fatalf("status %d: %v", code, out)
	}
	// "BBBB" is the frame the fake preview-svc grabbed from the camera.
	frames, _ := filepath.Glob(filepath.Join(dir, "M1", "DIAL", "*.jpg"))
	raw, _ := os.ReadFile(frames[0])
	want, _ := base64.StdEncoding.DecodeString("BBBB")
	if string(raw) != string(want) {
		t.Errorf("kept frame %q, want the camera frame", raw)
	}
}

func TestAcceptanceRejectsBadRequestsAndPathsOutsideTheStore(t *testing.T) {
	var calls []map[string]any
	preview := fakePreview(t, &calls)
	defer preview.Close()
	mux := acceptanceMux(t, preview.URL, t.TempDir())
	for name, body := range map[string]string{
		"no truth":       `{"config": ` + draftConfig + `, "gauge_id": "DIAL"}`,
		"unknown gauge":  `{"config": ` + draftConfig + `, "gauge_id": "NOPE", "truth": 1}`,
		"gauge in draft": `{"config": ` + draftConfig + `, "gauge_id": "DRAFT", "truth": 1}`,
		"no roi result":  `{"config": ` + draftConfig + `, "gauge_id": "AWAY", "truth": 1, "frame_jpeg": "QUJD"}`,
	} {
		if code, out, _ := do(t, mux, http.MethodPost, "/v1/commissioning/acceptance", body); code != http.StatusBadRequest {
			t.Errorf("%s: status %d: %v", name, code, out)
		}
	}
	if code, _, _ := do(t, mux, http.MethodGet, "/v1/commissioning/acceptance/M1/DIAL/..%2F..%2Fsecret", ""); code != http.StatusNotFound {
		t.Errorf("path outside the store: status %d", code)
	}
	store := NewDirSampleStore(t.TempDir())
	if err := store.Save(context.Background(), AcceptanceSample{ID: "1", MachineID: "../x", GaugeID: "G"}, nil); err == nil {
		t.Error("a machine id with a path separator must be refused")
	}
}

func TestAccuracyReport(t *testing.T) {
	errOf := func(v float64) *float64 { return &v }
	samples := []AcceptanceSample{
		{MachineID: "M1", GaugeID: "P", Type: "analog_dial", Passed: true, QualityOK: true, Error: errOf(0.06), FullScale: 6},
		{MachineID: "M1", GaugeID: "P", Type: "analog_dial", Passed: true, QualityOK: false, Error: errOf(-0.12), FullScale: 6},
		{MachineID: "M2", GaugeID: "T", Type: "seg7", Passed: true, QualityOK: true},
		{MachineID: "M2", GaugeID: "T", Type: "seg7", Passed: false, QualityOK: true},
	}
	r := Accuracy(samples)
	if r.Samples != 4 || len(r.ByType) != 2 || len(r.ByGauge) != 2 {
		t.Fatalf("report: %+v", r)
	}
	dial, display := r.ByType[0], r.ByType[1]
	if dial.Type != "analog_dial" || dial.Passed != 2 || dial.LowQuality != 1 || math.Abs(*dial.MeanErrorPct-1.5) > 1e-9 {
		t.Errorf("dial: %+v", dial)
	}
	if display.PassRate != 0.5 || display.MeanErrorPct != nil {
		t.Errorf("display: %+v", display)
	}
	// Ten out of ten proves about 72%, not 100%.
	if lb := wilsonLower(10, 10); math.Abs(lb-0.722) > 0.001 {
		t.Errorf("wilson 10/10: %v", lb)
	}
	if lb := wilsonLower(0, 0); lb != 0 {
		t.Errorf("wilson 0/0: %v", lb)
	}
}
