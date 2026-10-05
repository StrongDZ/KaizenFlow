package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A dial whose quad is the 256-pixel square at the frame origin, so frame
// and rectified coordinates coincide. The scale runs clockwise over 270
// degrees from bottom-left (0) over the top (100) to bottom-right (200).
const draftConfig = `{
  "machine_id": "M1", "plant": "P1", "line": "L1", "window_sec": 1,
  "camera": {"url": "rtsp://cam/1", "sample_fps": 2},
  "gauges": [
    {"gauge_id": "DIAL", "type": "analog_dial", "unit": "bar", "roi": [0, 0, 256, 256],
     "quad": [[0, 0], [256, 0], [256, 256], [0, 256]], "rect_size": 256,
     "calib": {"center": [128, 128], "min_pt": [28, 228], "max_pt": [228, 228], "min_val": 0, "max_val": 200, "sweep": "cw", "scale": "linear"}},
    {"gauge_id": "DRAFT", "type": "analog_dial", "roi": [10, 10, 50, 50], "calib": {"center": [1, 1]}},
    {"gauge_id": "AWAY", "type": "seg7", "roi": [5000, 10, 50, 20], "calib": {"digits": 2, "decimal_pos": 2, "color": "lcd"}}
  ]
}`

// fakePreview stands in for preview-svc: the dial tip points straight up.
func fakePreview(t *testing.T, got *[]map[string]any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		*got = append(*got, map[string]any{"path": r.URL.Path, "body": body})
		switch r.URL.Path {
		case "/v1/frame":
			if body["url"] == "rtsp://down" {
				w.WriteHeader(http.StatusBadGateway)
				_, _ = io.WriteString(w, `{"error": "cannot open rtsp://down"}`)
				return
			}
			_, _ = io.WriteString(w, `{"frame_jpeg": "AAAA", "width": 640, "height": 480}`)
		case "/v1/infer":
			out := `{"frame_result": {"camera_id": "M1", "frame_ts_ms": "1700000000000", "rois": [{"gauge_id": "DIAL",
				"keypoints": [{"x": 128, "y": 128}, {"x": 28, "y": 228}, {"x": 228, "y": 228}, {"x": 128, "y": 28}, {"x": 128, "y": 28}],
				"kp_conf": [0.9, 0.9, 0.9, 0.9, 0.9], "sharpness": 300, "glare_ratio": 0}]}`
			if body["frame_jpeg"] == "" {
				out += `, "frame_jpeg": "BBBB"`
			}
			_, _ = io.WriteString(w, out+"}")
		case "/v1/rectify":
			_, _ = io.WriteString(w, `{"image_jpeg": "CCCC"}`)
		}
	}))
}

func commissioningMux(t *testing.T, store Store, previewURL string) *http.ServeMux {
	t.Helper()
	mux := http.NewServeMux()
	NewCommissioning(store, previewURL).Register(mux)
	return mux
}

func post(t *testing.T, mux http.Handler, path, body string) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, strings.NewReader(body)))
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestPreviewDecodesWithTheEdgeDecoder(t *testing.T) {
	var calls []map[string]any
	preview := fakePreview(t, &calls)
	defer preview.Close()
	mux := commissioningMux(t, newMemStore(), preview.URL)

	code, out := post(t, mux, "/v1/commissioning/preview", `{"config": `+draftConfig+`, "frame_jpeg": "FRAME"}`)

	if code != http.StatusOK {
		t.Fatalf("status %d: %v", code, out)
	}
	if out["frame_jpeg"] != "" {
		t.Errorf("the caller's frame must not be sent back: %v", out["frame_jpeg"])
	}
	gauges := out["gauges"].([]any)
	dial := gauges[0].(map[string]any)
	if v, ok := dial["value"].(float64); !ok || math.Abs(v-100) > 0.5 {
		t.Errorf("dial reading %v, want 100 (needle straight up)", dial["value"])
	}
	if dial["unit"] != "bar" || dial["quality"].(float64) <= 0 || len(dial["keypoints"].([]any)) != 5 {
		t.Errorf("dial preview: %v", dial)
	}
	// A gauge still being set up reports why it cannot be read, the others still read.
	if draft := gauges[1].(map[string]any); !strings.Contains(draft["error"].(string), "calib") {
		t.Errorf("incomplete gauge: %v", draft)
	}
	if away := gauges[2].(map[string]any); away["error"] != "roi outside the frame" {
		t.Errorf("gauge without a roi result: %v", away)
	}
	// The draft config and the frame went to preview-svc unchanged.
	sent := calls[0]["body"].(map[string]any)
	if calls[0]["path"] != "/v1/infer" || sent["frame_jpeg"] != "FRAME" || sent["config"].(map[string]any)["machine_id"] != "M1" {
		t.Errorf("request to preview-svc: %v", calls[0])
	}
}

func TestLivePreviewReturnsTheFreshFrame(t *testing.T) {
	var calls []map[string]any
	preview := fakePreview(t, &calls)
	defer preview.Close()
	code, out := post(t, commissioningMux(t, newMemStore(), preview.URL), "/v1/commissioning/preview", `{"config": `+draftConfig+`}`)
	if code != http.StatusOK || out["frame_jpeg"] != "BBBB" {
		t.Errorf("status %d, frame %v", code, out["frame_jpeg"])
	}
}

func TestFrameUsesTheStoredCameraAndReportsCameraFailures(t *testing.T) {
	var calls []map[string]any
	preview := fakePreview(t, &calls)
	defer preview.Close()
	store := newMemStore()
	if _, err := store.Put(context.Background(), "M1", "P1", "L1", []byte(draftConfig)); err != nil {
		t.Fatal(err)
	}
	mux := commissioningMux(t, store, preview.URL)

	code, out := post(t, mux, "/v1/commissioning/frame", `{"machine_id": "M1"}`)
	if code != http.StatusOK || out["frame_jpeg"] != "AAAA" {
		t.Fatalf("status %d: %v", code, out)
	}
	if url := calls[0]["body"].(map[string]any)["url"]; url != "rtsp://cam/1" {
		t.Errorf("camera url sent: %v", url)
	}
	if code, _ := post(t, mux, "/v1/commissioning/frame", `{"machine_id": "NOPE"}`); code != http.StatusNotFound {
		t.Errorf("unknown machine: %d", code)
	}
	if code, out := post(t, mux, "/v1/commissioning/frame", `{"url": "rtsp://down"}`); code != http.StatusBadGateway || out["error"] != "cannot open rtsp://down" {
		t.Errorf("camera down: %d %v", code, out)
	}
	if code, _ := post(t, mux, "/v1/commissioning/frame", `{}`); code != http.StatusBadRequest {
		t.Errorf("no camera: %d", code)
	}
	if code, _ := post(t, mux, "/v1/commissioning/rectify", `{"frame_jpeg": "AAAA", "quad": []}`); code != http.StatusOK {
		t.Errorf("rectify: %d", code)
	}
}

func TestPreviewWithoutPreviewServiceIsUnavailable(t *testing.T) {
	mux := commissioningMux(t, newMemStore(), "http://127.0.0.1:1")
	if code, _ := post(t, mux, "/v1/commissioning/preview", `{"config": `+draftConfig+`, "frame_jpeg": "F"}`); code != http.StatusServiceUnavailable {
		t.Errorf("status %d, want 503", code)
	}
	if code, _ := post(t, mux, "/v1/commissioning/preview", `{"config": {"bogus": 1}}`); code != http.StatusBadRequest {
		t.Errorf("invalid draft: %d", code)
	}
}

func TestThePageIsServed(t *testing.T) {
	mux := commissioningMux(t, newMemStore(), "http://unused")
	for path, want := range map[string]string{"/commissioning/": "Commissioning", "/commissioning/app.js": "commissioning/preview"} {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusOK || !bytes.Contains(rec.Body.Bytes(), []byte(want)) {
			t.Errorf("%s: %d", path, rec.Code)
		}
	}
}
