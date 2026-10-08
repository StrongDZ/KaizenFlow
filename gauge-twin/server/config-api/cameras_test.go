package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

type memCameras struct {
	mu   sync.Mutex
	rows map[string]Camera
}

func (m *memCameras) PutCamera(_ context.Context, c Camera) (Camera, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c.UpdatedAt = time.Now()
	m.rows[c.CameraID] = c
	return c, nil
}

func (m *memCameras) GetCamera(_ context.Context, id string) (Camera, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.rows[id]
	if !ok {
		return Camera{}, ErrCameraNotFound
	}
	return c, nil
}

func (m *memCameras) ListCameras(context.Context) ([]Camera, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Camera, 0, len(m.rows))
	for _, c := range m.rows {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CameraID < out[j].CameraID })
	return out, nil
}

func (m *memCameras) DeleteCamera(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.rows[id]; !ok {
		return ErrCameraNotFound
	}
	delete(m.rows, id)
	return nil
}

// cameraHarness is the station API with a camera registry next to it.
func cameraHarness(t *testing.T) *harness {
	t.Helper()
	h := newHarness(t)
	return h
}

// stationOn is a station whose only gauge is on a camera of the registry and
// that has no default camera.
func stationOn(machine, camera string) []byte {
	return []byte(`{"machine_id": "` + machine + `", "plant": "DENSO_HN", "line": "L03", "window_sec": 1,
	  "gauges": [{"gauge_id": "VOLTMETER", "type": "seg7", "unit": "V", "roi": [10, 20, 180, 64], "camera_id": "` + camera + `",
	              "calib": {"digits": 4, "decimal_pos": 3, "color": "red_led"}}]}`)
}

func storedCameras(t *testing.T, h *harness, machine string) []map[string]any {
	t.Helper()
	code, body := h.do(t, http.MethodGet, "/v1/stations/"+machine, nil)
	if code != http.StatusOK {
		t.Fatalf("GET station %s: %d %v", machine, code, body)
	}
	raw, _ := body["config"].(map[string]any)["cameras"].([]any)
	out := make([]map[string]any, len(raw))
	for i, c := range raw {
		out[i] = c.(map[string]any)
	}
	return out
}

func TestCameraRegistry(t *testing.T) {
	h := cameraHarness(t)

	code, body := h.do(t, http.MethodPut, "/v1/cameras/cab-l03-front", []byte(`{"name": "Tủ điện L03", "location": "phía trước", "url": "rtsp://10.1.3.21/s1", "sample_fps": 2}`))
	if code != http.StatusOK || body["camera_id"] != "cab-l03-front" || body["name"] != "Tủ điện L03" {
		t.Fatalf("PUT camera: %d %v", code, body)
	}
	for name, bad := range map[string]string{
		"no url":      `{"sample_fps": 2}`,
		"bad rate":    `{"url": "rtsp://x", "sample_fps": 0}`,
		"not JSON":    `{`,
		"long name":   `{"url": "rtsp://x", "sample_fps": 2, "name": "` + strings.Repeat("x", 121) + `"}`,
		"rate too hi": `{"url": "rtsp://x", "sample_fps": 31}`,
	} {
		if code, _ := h.do(t, http.MethodPut, "/v1/cameras/other", []byte(bad)); code != http.StatusBadRequest {
			t.Errorf("%s: got %d, want 400", name, code)
		}
	}
	if code, _ := h.do(t, http.MethodPut, "/v1/cameras/bad%20id", []byte(`{"url": "rtsp://x", "sample_fps": 2}`)); code != http.StatusBadRequest {
		t.Errorf("an ID with a space: got %d, want 400", code)
	}

	// Two machines put a gauge on the same camera.
	for _, machine := range []string{"PRESS_01", "PRESS_02"} {
		if code, body := h.do(t, http.MethodPut, "/v1/stations/"+machine, stationOn(machine, "cab-l03-front")); code != http.StatusOK {
			t.Fatalf("PUT station %s: %d %v", machine, code, body)
		}
		cams := storedCameras(t, h, machine)
		if len(cams) != 1 || cams[0]["camera_id"] != "cab-l03-front" || cams[0]["url"] != "rtsp://10.1.3.21/s1" || cams[0]["sample_fps"] != float64(2) {
			t.Errorf("%s: the stored config does not carry the camera of the registry: %v", machine, cams)
		}
	}

	code, body = h.do(t, http.MethodGet, "/v1/cameras", nil)
	list, _ := body["cameras"].([]any)
	if code != http.StatusOK || len(list) != 1 {
		t.Fatalf("GET cameras: %d %v", code, body)
	}
	machines, _ := json.Marshal(list[0].(map[string]any)["machines"])
	if got := string(machines); !strings.Contains(got, `"PRESS_01"`) || !strings.Contains(got, `"PRESS_02"`) || !strings.Contains(got, `"gauges":1`) {
		t.Errorf("the camera does not list the machines on it: %s", got)
	}

	if code, _ := h.do(t, http.MethodDelete, "/v1/cameras/cab-l03-front", nil); code != http.StatusConflict {
		t.Errorf("deleting a camera in use: got %d, want 409", code)
	}
}

func TestChangingACameraGivesItsStationsANewConfig(t *testing.T) {
	h := cameraHarness(t)
	h.do(t, http.MethodPut, "/v1/cameras/cam-a", []byte(`{"url": "rtsp://old", "sample_fps": 2}`))
	h.do(t, http.MethodPut, "/v1/cameras/cam-b", []byte(`{"url": "rtsp://b", "sample_fps": 2}`))
	h.do(t, http.MethodPut, "/v1/stations/PRESS_01", stationOn("PRESS_01", "cam-a"))
	h.do(t, http.MethodPut, "/v1/stations/PRESS_02", stationOn("PRESS_02", "cam-b"))

	if code, body := h.do(t, http.MethodPut, "/v1/cameras/cam-a", []byte(`{"url": "rtsp://new", "sample_fps": 5}`)); code != http.StatusOK {
		t.Fatalf("PUT camera: %d %v", code, body)
	}
	_, first := h.do(t, http.MethodGet, "/v1/stations/PRESS_01", nil)
	if cams := storedCameras(t, h, "PRESS_01"); first["config_version"] != float64(2) || cams[0]["url"] != "rtsp://new" || cams[0]["sample_fps"] != float64(5) {
		t.Errorf("the station on the changed camera: version %v, cameras %v", first["config_version"], cams)
	}
	if _, other := h.do(t, http.MethodGet, "/v1/stations/PRESS_02", nil); other["config_version"] != float64(1) {
		t.Errorf("a station on another camera got version %v", other["config_version"])
	}

	// Saving the same camera again changes nothing.
	h.do(t, http.MethodPut, "/v1/cameras/cam-a", []byte(`{"url": "rtsp://new", "sample_fps": 5, "name": "renamed"}`))
	if _, again := h.do(t, http.MethodGet, "/v1/stations/PRESS_01", nil); again["config_version"] != float64(2) {
		t.Errorf("renaming a camera bumped the station to version %v", again["config_version"])
	}
}

func TestStationOnAnUnknownCameraIsRejectedAndUnusedCamerasAreDropped(t *testing.T) {
	h := cameraHarness(t)
	if code, body := h.do(t, http.MethodPut, "/v1/stations/PRESS_01", stationOn("PRESS_01", "nowhere")); code != http.StatusBadRequest {
		t.Errorf("got %d %v, want 400", code, body)
	}
	// A camera defined in the config itself still works, and one no gauge is on is not stored.
	inline := strings.Replace(string(stationOn("PRESS_01", "own")), `"window_sec": 1,`,
		`"window_sec": 1, "cameras": [{"camera_id": "own", "url": "rtsp://own", "sample_fps": 2}, {"camera_id": "spare", "url": "rtsp://spare", "sample_fps": 2}],`, 1)
	if code, body := h.do(t, http.MethodPut, "/v1/stations/PRESS_01", []byte(inline)); code != http.StatusOK {
		t.Fatalf("got %d %v", code, body)
	}
	if cams := storedCameras(t, h, "PRESS_01"); len(cams) != 1 || cams[0]["camera_id"] != "own" {
		t.Errorf("cameras: %v", cams)
	}
	if code, _ := h.do(t, http.MethodDelete, "/v1/cameras/unknown", nil); code != http.StatusNotFound {
		t.Errorf("deleting an unknown camera: got %d, want 404", code)
	}
}

func TestCORSOnlyAnswersTheConfiguredOrigin(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	call := func(h http.Handler, method, origin string) *http.Response {
		req := httptest.NewRequest(method, "/v1/cameras", nil)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Result()
	}
	h := withCORS("http://localhost:5173", inner)
	if resp := call(h, http.MethodGet, "http://localhost:5173"); resp.Header.Get("Access-Control-Allow-Origin") != "http://localhost:5173" || resp.StatusCode != http.StatusTeapot {
		t.Errorf("the web origin: %d %v", resp.StatusCode, resp.Header)
	}
	if resp := call(h, http.MethodOptions, "http://localhost:5173"); resp.StatusCode != http.StatusNoContent || !strings.Contains(resp.Header.Get("Access-Control-Allow-Methods"), "PUT") {
		t.Errorf("preflight: %d %v", resp.StatusCode, resp.Header)
	}
	if resp := call(h, http.MethodGet, "http://evil.example"); resp.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Error("another origin was allowed")
	}
	if resp := call(withCORS("", inner), http.MethodGet, "http://localhost:5173"); resp.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Error("CORS answered although no origin is configured")
	}
}
