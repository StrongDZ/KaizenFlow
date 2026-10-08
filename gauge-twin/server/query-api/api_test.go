package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// ---------------------------------------------------------------- fakes ----

type seriesCall struct {
	machine, gauge string
	since          time.Time
	bucket         time.Duration
}

type memStore struct {
	stations []StationRow
	latest   map[GaugeKey]Reading
	edges    map[string]EdgeRow
	points   []Point
	err      error
	series   []seriesCall
	history  []HistoryPoint
	asked    []historyCall
}

type historyCall struct {
	machine, gauge string
	from, to       time.Time
	bucket         time.Duration
	source         string
}

func (m *memStore) History(_ context.Context, machine, gauge string, from, to time.Time, bucket time.Duration, source string) ([]HistoryPoint, error) {
	m.asked = append(m.asked, historyCall{machine, gauge, from, to, bucket, source})
	return m.history, m.err
}

func (m *memStore) Stations(_ context.Context, machineID string) ([]StationRow, error) {
	if m.err != nil {
		return nil, m.err
	}
	var out []StationRow
	for _, s := range m.stations {
		if machineID == "" || s.MachineID == machineID {
			out = append(out, s)
		}
	}
	return out, nil
}

func (m *memStore) Latest(context.Context, time.Time) (map[GaugeKey]Reading, error) {
	return m.latest, m.err
}

func (m *memStore) Edges(context.Context) (map[string]EdgeRow, error) { return m.edges, m.err }

func (m *memStore) Series(_ context.Context, machine, gauge string, since time.Time, bucket time.Duration) ([]Point, error) {
	m.series = append(m.series, seriesCall{machine, gauge, since, bucket})
	return m.points, m.err
}

func (m *memStore) Ping(context.Context) error { return m.err }

var testNow = time.Date(2026, 10, 6, 3, 0, 0, 0, time.UTC)

func gaugeConfig(id, kind, unit string, roi ...float64) GaugeConfig {
	return GaugeConfig{GaugeID: id, Type: kind, Unit: unit, ROI: roi}
}

func newTestStore() *memStore {
	ammeter := gaugeConfig("AMMETER", "seg7", "A", 514, 671, 182, 108)
	ammeter.Rules.Max = ptr(28.0)
	ammeter.CameraID = "side" // the ammeter is on a second camera
	return &memStore{
		stations: []StationRow{
			{MachineID: "machine_001", Plant: "SIM", Line: "L01", ConfigVersion: 32,
				Cameras: []CameraRef{{URL: "rtsp://cam/machine_001"}, {ID: "side", URL: "rtsp://cam/side"}},
				Gauges:  []GaugeConfig{gaugeConfig("OIL_TEMP", "analog_dial", "degC", 1406, 207, 270, 296), ammeter}},
			{MachineID: "machine_002", Plant: "SIM", Line: "L01", ConfigVersion: 1,
				Gauges: []GaugeConfig{gaugeConfig("VOLTMETER", "seg7", "V", 10, 20, 30, 40)}},
		},
		latest: map[GaugeKey]Reading{
			{"machine_001", "OIL_TEMP"}: {TS: testNow.Add(-time.Second), Value: ptr(122.2), VMin: ptr(122.0), VMax: ptr(122.4),
				NFrames: ptr(int32(2)), Quality: ptr(float32(0.99))},
			{"machine_001", "AMMETER"}: {TS: testNow.Add(-time.Second), Value: ptr(29.8), Quality: ptr(float32(0.44)), Flags: []int16{4}},
		},
		edges: map[string]EdgeRow{"machine_001": {EdgeID: "edge-0001", Status: "online", LastSeen: ptr(testNow)}},
	}
}

func newTestServerWithLive(t *testing.T, store Store, live *LiveFrames) *httptest.Server {
	t.Helper()
	api := NewAPI(store, "", "*", 30*time.Second, 10*time.Minute, func() time.Time { return testNow },
		prometheus.NewRegistry(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	api.live = live
	mux := http.NewServeMux()
	api.Register(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func newTestServer(t *testing.T, store Store, previewURL string) *httptest.Server {
	t.Helper()
	api := NewAPI(store, previewURL, "*", 30*time.Second, 10*time.Minute, func() time.Time { return testNow },
		prometheus.NewRegistry(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	mux := http.NewServeMux()
	api.Register(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func get(t *testing.T, url string, out any) *http.Response {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			t.Fatalf("%s: answer is not JSON: %v", url, err)
		}
	}
	return resp
}

func wantError(t *testing.T, url string, code int, message string) {
	t.Helper()
	var body apiError
	if resp := get(t, url, &body); resp.StatusCode != code || body.Error != message {
		t.Errorf("%s: got %d %q, want %d %q", url, resp.StatusCode, body.Error, code, message)
	}
}

// ---------------------------------------------------------------- tests ----

func TestListStations(t *testing.T) {
	srv := newTestServer(t, newTestStore(), "")
	var got []stationView
	resp := get(t, srv.URL+"/v1/live/stations", &got)
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("got %d, CORS %q", resp.StatusCode, resp.Header.Get("Access-Control-Allow-Origin"))
	}
	if len(got) != 2 || got[0].MachineID != "machine_001" || got[1].MachineID != "machine_002" {
		t.Fatalf("stations: %+v", got)
	}

	first := got[0]
	if first.State != StateAlarm || first.Plant != "SIM" || first.Line != "L01" || first.ConfigVersion != 32 {
		t.Errorf("station: %+v", first)
	}
	if first.Edge == nil || first.Edge.EdgeID != "edge-0001" || first.Edge.Status != "online" {
		t.Errorf("edge: %+v", first.Edge)
	}
	if len(first.Cameras) != 2 || first.Cameras[0] != "" || first.Cameras[1] != "side" {
		t.Errorf("cameras: %q", first.Cameras)
	}
	oil, ammeter := first.Gauges[0], first.Gauges[1]
	if oil.CameraID != "" || ammeter.CameraID != "side" {
		t.Errorf("camera of the gauges: %q, %q", oil.CameraID, ammeter.CameraID)
	}
	if oil.State != StateOK || oil.Value == nil || *oil.Value != 122.2 || *oil.VMin != 122.0 || *oil.NFrames != 2 ||
		oil.TS == nil || len(oil.ROI) != 4 || oil.Unit != "degC" || oil.Type != "analog_dial" {
		t.Errorf("OIL_TEMP: %+v", oil)
	}
	if ammeter.State != StateAlarm || len(ammeter.Flags) != 1 || ammeter.Flags[0] != "FLAG_OUT_OF_RANGE" ||
		ammeter.Max == nil || *ammeter.Max != 28 || ammeter.Min != nil {
		t.Errorf("AMMETER: %+v", ammeter)
	}

	second := got[1]
	if second.State != StateOffline || second.Edge != nil || second.Cameras == nil || len(second.Cameras) != 0 {
		t.Errorf("station without readings: %+v", second)
	}
	if g := second.Gauges[0]; g.State != StateStale || g.Value != nil || g.TS != nil || g.Flags == nil {
		t.Errorf("gauge without reading: %+v", g)
	}
}

func TestGetStation(t *testing.T) {
	srv := newTestServer(t, newTestStore(), "")
	var got stationView
	if resp := get(t, srv.URL+"/v1/live/stations/machine_001", &got); resp.StatusCode != http.StatusOK ||
		got.MachineID != "machine_001" || len(got.Gauges) != 2 {
		t.Errorf("got %d %+v", resp.StatusCode, got)
	}
	wantError(t, srv.URL+"/v1/live/stations/unknown", http.StatusNotFound, "station not found")
}

func TestSeries(t *testing.T) {
	store := newTestStore()
	store.points = []Point{{TS: testNow.Add(-time.Minute), Value: ptr(1.5), Quality: ptr(float32(0.9))}}
	srv := newTestServer(t, store, "")
	cases := []struct {
		query  string
		since  time.Duration
		bucket time.Duration
	}{
		{"gauge=OIL_TEMP", 15 * time.Minute, 3 * time.Second},
		{"gauge=OIL_TEMP&minutes=0", time.Minute, time.Second},
		{"gauge=OIL_TEMP&minutes=5", 5 * time.Minute, time.Second},
		{"gauge=OIL_TEMP&minutes=9999", 240 * time.Minute, 48 * time.Second},
	}
	for i, c := range cases {
		var got seriesView
		resp := get(t, srv.URL+"/v1/stations/machine_001/series?"+c.query, &got)
		if resp.StatusCode != http.StatusOK || len(got.Points) != 1 || *got.Points[0].Value != 1.5 || got.GaugeID != "OIL_TEMP" {
			t.Fatalf("%s: got %d %+v", c.query, resp.StatusCode, got)
		}
		call := store.series[i]
		if call.machine != "machine_001" || call.gauge != "OIL_TEMP" || !call.since.Equal(testNow.Add(-c.since)) || call.bucket != c.bucket {
			t.Errorf("%s: store asked %+v, want since -%s bucket %s", c.query, call, c.since, c.bucket)
		}
	}
	wantError(t, srv.URL+"/v1/stations/machine_001/series", http.StatusBadRequest, "gauge is required")
	wantError(t, srv.URL+"/v1/stations/machine_001/series?gauge=X&minutes=abc", http.StatusBadRequest, "minutes must be an integer")
}

func TestSeriesWithoutPointsIsAnEmptyList(t *testing.T) {
	srv := newTestServer(t, newTestStore(), "")
	resp, err := http.Get(srv.URL + "/v1/stations/machine_001/series?gauge=OIL_TEMP")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var got map[string]json.RawMessage
	if err := json.Unmarshal(raw, &got); err != nil || string(got["points"]) != "[]" {
		t.Errorf("got %s, want points []", raw)
	}
}

func TestFrame(t *testing.T) {
	var asked map[string]string
	fail := false
	preview := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail {
			http.Error(w, `{"error":"camera unreachable"}`, http.StatusInternalServerError)
			return
		}
		if r.Method != http.MethodPost || r.URL.Path != "/v1/frame" {
			t.Errorf("preview asked %s %s", r.Method, r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&asked)
		_, _ = w.Write([]byte(`{"frame_jpeg":"abcd","width":1920,"height":1080}`))
	}))
	srv := newTestServer(t, newTestStore(), preview.URL)

	var got map[string]any
	if resp := get(t, srv.URL+"/v1/stations/machine_001/frame", &got); resp.StatusCode != http.StatusOK ||
		got["frame_jpeg"] != "abcd" || got["width"] != float64(1920) {
		t.Errorf("got %d %v", resp.StatusCode, got)
	}
	if asked["url"] != "rtsp://cam/machine_001" {
		t.Errorf("preview asked for %q", asked["url"])
	}

	// A second camera of the station is asked for by its id.
	get(t, srv.URL+"/v1/stations/machine_001/frame?camera=side", &got)
	if asked["url"] != "rtsp://cam/side" {
		t.Errorf("preview asked for %q, want the side camera", asked["url"])
	}

	wantError(t, srv.URL+"/v1/stations/unknown/frame", http.StatusNotFound, "station not found")
	wantError(t, srv.URL+"/v1/stations/machine_002/frame", http.StatusNotFound, "station has no such camera")
	wantError(t, srv.URL+"/v1/stations/machine_001/frame?camera=back", http.StatusNotFound, "station has no such camera")

	// A frame pulled recently enough is answered without asking the camera again.
	asked = nil
	get(t, srv.URL+"/v1/stations/machine_001/frame?camera=side&max_age=600", &got)
	if asked != nil || got["frame_jpeg"] != "abcd" {
		t.Errorf("kept frame: preview asked %v, got %v", asked, got)
	}
	get(t, srv.URL+"/v1/stations/machine_001/frame?camera=side", &got)
	if asked["url"] != "rtsp://cam/side" {
		t.Errorf("without max_age the camera is asked again, got %v", asked)
	}
	wantError(t, srv.URL+"/v1/stations/machine_001/frame?max_age=soon", http.StatusBadRequest, "max_age must be a number of seconds")

	fail = true
	wantError(t, srv.URL+"/v1/stations/machine_001/frame", http.StatusBadGateway, "camera unreachable")
	preview.Close()
	if resp := get(t, srv.URL+"/v1/stations/machine_001/frame", nil); resp.StatusCode != http.StatusBadGateway {
		t.Errorf("preview down: got %d, want 502", resp.StatusCode)
	}
}

func TestWarmStillsPullsEveryCameraOnce(t *testing.T) {
	var mu sync.Mutex
	asked := map[string]int{}
	preview := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		asked[body["url"]]++
		mu.Unlock()
		_, _ = w.Write([]byte(`{"frame_jpeg":"abcd","width":1920,"height":1080}`))
	}))
	defer preview.Close()
	store := newTestStore()
	// A second machine on the side camera of the first one.
	store.stations = append(store.stations, StationRow{MachineID: "machine_003", Cameras: []CameraRef{{ID: "side", URL: "rtsp://cam/side"}}})
	api := NewAPI(store, preview.URL, "*", 30*time.Second, 10*time.Minute, func() time.Time { return testNow }, prometheus.NewRegistry(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	api.warmStills(context.Background(), time.Minute)
	api.warmStills(context.Background(), time.Minute) // still fresh: nothing is pulled
	if len(asked) != 2 || asked["rtsp://cam/machine_001"] != 1 || asked["rtsp://cam/side"] != 1 {
		t.Errorf("cameras asked: %v, want the two cameras once each", asked)
	}
}

func TestStoreErrorIsInternal(t *testing.T) {
	store := newTestStore()
	store.err = errors.New("connection refused")
	srv := newTestServer(t, store, "")
	for _, path := range []string{"/v1/live/stations", "/v1/live/stations/machine_001", "/v1/stations/machine_001/series?gauge=X"} {
		wantError(t, srv.URL+path, http.StatusInternalServerError, "internal error")
	}
}
