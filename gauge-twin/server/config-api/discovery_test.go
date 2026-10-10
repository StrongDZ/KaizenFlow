package main

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"sync"
	"testing"
	"time"
)

// memDiscovery applies scans the way the SQL of PgDiscoveryStore does.
type memDiscovery struct {
	mu        sync.Mutex
	next      int64
	rows      map[int64]Candidate
	scans     map[string]CameraScan
	sightings map[GaugeRef]time.Time
}

func newMemDiscovery() *memDiscovery {
	return &memDiscovery{rows: map[int64]Candidate{}, scans: map[string]CameraScan{}, sightings: map[GaugeRef]time.Time{}}
}

func (m *memDiscovery) Candidates(_ context.Context, cameraID string) ([]Candidate, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Candidate{}
	for _, c := range m.rows {
		if cameraID == "" || c.CameraID == cameraID {
			out = append(out, c)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (m *memDiscovery) ApplyScan(_ context.Context, scan CameraScan, plan scanPlan) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	at := scan.ScannedAt
	m.scans[scan.CameraID] = scan
	for _, g := range plan.Sighted {
		m.sightings[g] = at
	}
	for id, d := range plan.Updates {
		c := m.rows[id]
		c.Seen++
		c.LastSeen = at
		c.Score = (c.Score*float32(c.Seen-1) + d.Score) / float32(c.Seen)
		if c.Status == candidatePending {
			c.ROI, c.Type, c.Hint = d.ROI, d.Type, d.Hint
			if d.CropJPEG != nil {
				c.CropJPEG = d.CropJPEG
			}
		}
		m.rows[id] = c
	}
	for _, d := range plan.Inserts {
		m.next++
		m.rows[m.next] = Candidate{ID: m.next, CameraID: scan.CameraID, ROI: d.ROI, Type: d.Type, Score: d.Score, Hint: d.Hint,
			CropJPEG: d.CropJPEG, Seen: 1, FirstSeen: at, LastSeen: at, Status: candidatePending}
	}
	for _, id := range plan.Reopened {
		c := m.rows[id]
		if c.Status == candidateAccepted {
			c.Status, c.MachineID, c.GaugeID, c.DecidedAt = candidatePending, nil, nil, nil
			m.rows[id] = c
		}
	}
	for id, g := range plan.Accepted {
		c := m.rows[id]
		if c.Status == candidatePending {
			c.Status, c.MachineID, c.GaugeID, c.DecidedAt = candidateAccepted, &g.MachineID, &g.GaugeID, &at
			m.rows[id] = c
		}
	}
	return nil
}

func (m *memDiscovery) SetCandidateStatus(_ context.Context, id int64, status string) (Candidate, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.rows[id]
	if !ok {
		return Candidate{}, ErrCandidateNotFound
	}
	c.Status, c.MachineID, c.GaugeID = status, nil, nil
	m.rows[id] = c
	return c, nil
}

func (m *memDiscovery) Scans(context.Context) ([]CameraScan, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []CameraScan{}
	for _, s := range m.scans {
		out = append(out, s)
	}
	return out, nil
}

func (m *memDiscovery) Sightings(context.Context) ([]Sighting, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Sighting{}
	for g, t := range m.sightings {
		out = append(out, Sighting{g, t})
	}
	return out, nil
}

func TestSameObject(t *testing.T) {
	cases := []struct {
		name string
		a, b []int32
		want bool
	}{
		{"identical", []int32{0, 0, 100, 100}, []int32{0, 0, 100, 100}, true},
		{"dial face inside its declared tile", []int32{60, 40, 520, 560}, []int32{0, 0, 640, 640}, true},
		{"display bezel around declared digits", []int32{100, 200, 300, 140}, []int32{130, 230, 240, 80}, true},
		{"neighbours side by side", []int32{0, 0, 100, 100}, []int32{120, 0, 100, 100}, false},
		{"a nut on the rim of a dial", []int32{560, 0, 80, 80}, []int32{0, 0, 640, 640}, false},
		{"far too large", []int32{0, 0, 1000, 1000}, []int32{480, 480, 40, 40}, false},
		{"malformed", []int32{0, 0, 10}, []int32{0, 0, 10, 10}, false},
	}
	for _, c := range cases {
		if got := sameObject(c.a, c.b); got != c.want {
			t.Errorf("%s: got %v", c.name, got)
		}
	}
}

func TestPlanScan(t *testing.T) {
	declared := []declaredGauge{{GaugeRef{"M1", "OIL"}, []int32{0, 0, 640, 640}}}
	existing := []Candidate{
		{ID: 7, ROI: []int32{700, 100, 200, 200}, Status: candidatePending},
		{ID: 8, ROI: []int32{1000, 400, 100, 60}, Status: candidateIgnored},
		// A pending candidate on which a gauge has been declared since.
		{ID: 9, ROI: []int32{50, 50, 540, 540}, Status: candidatePending},
		// An accepted one whose gauge was removed from its machine.
		{ID: 10, ROI: []int32{1200, 600, 60, 60}, Status: candidateAccepted},
	}
	dets := []Detection{
		{ROI: []int32{60, 40, 520, 560}, Type: "analog_dial", Score: 0.5},   // the declared dial
		{ROI: []int32{690, 110, 210, 190}, Type: "analog_dial", Score: 0.3}, // candidate 7 again
		{ROI: []int32{705, 95, 195, 205}, Type: "analog_dial", Score: 0.4},  // and once more, better
		{ROI: []int32{1005, 405, 95, 55}, Type: "seg7", Score: 0.2},         // the ignored one
		{ROI: []int32{100, 900, 300, 100}, Type: "seg7", Score: 0.3},        // new
		{ROI: []int32{110, 905, 280, 90}, Type: "seg7", Score: 0.25},        // the same new one
	}
	plan := planScan(dets, declared, existing)
	if len(plan.Sighted) != 1 || plan.Sighted[0] != (GaugeRef{"M1", "OIL"}) {
		t.Errorf("sighted: %v", plan.Sighted)
	}
	if len(plan.Updates) != 2 || plan.Updates[7].Score != 0.4 || plan.Updates[8].Type != "seg7" {
		t.Errorf("updates: %+v", plan.Updates)
	}
	if len(plan.Inserts) != 1 || plan.Inserts[0].Score != 0.3 {
		t.Errorf("inserts: %+v", plan.Inserts)
	}
	if len(plan.Accepted) != 1 || plan.Accepted[9] != (GaugeRef{"M1", "OIL"}) {
		t.Errorf("accepted: %+v", plan.Accepted)
	}
	if len(plan.Reopened) != 1 || plan.Reopened[0] != 10 {
		t.Errorf("reopened: %v", plan.Reopened)
	}
}

func TestSightState(t *testing.T) {
	scan := time.Date(2026, 10, 10, 8, 0, 0, 0, time.UTC)
	recent, old := scan.Add(-5*time.Minute), scan.Add(-time.Hour)
	for want, c := range map[string]struct{ seen, scanned *time.Time }{
		sightUnscanned: {&recent, nil},
		sightNever:     {nil, &scan},
		sightSeen:      {&recent, &scan},
		sightLost:      {&old, &scan},
	} {
		if got := sightState(c.seen, c.scanned, 15*time.Minute); got != want {
			t.Errorf("got %s, want %s", got, want)
		}
	}
}

func TestDiscoveryFlow(t *testing.T) {
	h := newHarness(t)
	now := time.Date(2026, 10, 10, 8, 0, 0, 0, time.UTC)
	d := h.discovery
	d.now = func() time.Time { return now }
	put := func(path string, body string) {
		t.Helper()
		if code, out := h.do(t, http.MethodPut, path, []byte(body)); code != http.StatusOK {
			t.Fatalf("PUT %s: %d %v", path, code, out)
		}
	}
	put("/v1/cameras/cam-1", `{"name": "Tủ 1", "url": "rtsp://cam/1", "sample_fps": 2}`)
	put("/v1/stations/M1", `{"machine_id": "M1", "plant": "P", "line": "L", "window_sec": 1,
	  "gauges": [{"gauge_id": "VOLT", "type": "seg7", "unit": "V", "roi": [130, 230, 240, 80], "camera_id": "cam-1",
	              "calib": {"digits": 4, "decimal_pos": 3, "color": "red_led"}}]}`)

	scan := func(dets string) map[string]any {
		t.Helper()
		code, out := h.do(t, http.MethodPost, "/v1/discovery/scans", []byte(`{"camera_id": "cam-1", "width": 1280, "height": 720, "detections": `+dets+`}`))
		if code != http.StatusOK {
			t.Fatalf("scan: %d %v", code, out)
		}
		now = now.Add(5 * time.Minute)
		return out
	}
	pending := func() []any {
		t.Helper()
		code, out := h.do(t, http.MethodGet, "/v1/discovery/candidates?camera_id=cam-1", nil)
		if code != http.StatusOK {
			t.Fatalf("list: %d %v", code, out)
		}
		return out["candidates"].([]any)
	}
	dial := `{"roi": [700, 100, 200, 200], "type": "analog_dial", "score": 0.4, "hint": {"center": [128, 128]}, "crop_jpeg": "AQID"}`
	// A label next to the display: found every time, but with a weak score.
	label := `{"roi": [1000, 500, 70, 60], "type": "seg7", "score": 0.22}`
	bezel := `{"roi": [100, 200, 300, 140], "type": "seg7", "score": 0.5}`

	if out := scan(`[` + dial + `, ` + bezel + `, ` + label + `]`); out["new"] != float64(2) || out["sighted"] != float64(1) {
		t.Errorf("first scan: %v", out)
	}
	// Found once: not proposed yet.
	if got := pending(); len(got) != 0 {
		t.Fatalf("after one scan: %v", got)
	}
	scan(`[` + dial + `, ` + label + `]`)
	scan(`[` + dial + `, ` + label + `]`)
	got := pending()
	if len(got) != 1 {
		t.Fatalf("after three scans: %v", got)
	}
	c := got[0].(map[string]any)
	if c["seen"] != float64(3) || c["type"] != "analog_dial" || c["crop_jpeg"] != "AQID" || c["hint"].(map[string]any)["center"] == nil {
		t.Errorf("candidate: %v", c)
	}
	id := strconvID(c["candidate_id"])

	// Ignored: listed under ignored, not pending, and kept out by later scans.
	if code, out := h.do(t, http.MethodPost, "/v1/discovery/candidates/"+id+"/ignore", nil); code != http.StatusOK || out["status"] != candidateIgnored {
		t.Fatalf("ignore: %d %v", code, out)
	}
	scan(`[` + dial + `]`)
	if got := pending(); len(got) != 0 {
		t.Errorf("ignored candidate proposed again: %v", got)
	}
	if code, out := h.do(t, http.MethodGet, "/v1/discovery/candidates?status=ignored", nil); code != http.StatusOK || len(out["candidates"].([]any)) != 1 {
		t.Errorf("ignored list: %d %v", code, out)
	}
	if code, _ := h.do(t, http.MethodPost, "/v1/discovery/candidates/"+id+"/restore", nil); code != http.StatusOK {
		t.Fatalf("restore: %d", code)
	}

	// The person saves the dial as a gauge: no longer pending at once, accepted at the next scan.
	put("/v1/stations/M1", `{"machine_id": "M1", "plant": "P", "line": "L", "window_sec": 1,
	  "gauges": [{"gauge_id": "VOLT", "type": "seg7", "unit": "V", "roi": [130, 230, 240, 80], "camera_id": "cam-1",
	              "calib": {"digits": 4, "decimal_pos": 3, "color": "red_led"}},
	             {"gauge_id": "PRESS", "type": "analog_dial", "unit": "bar", "roi": [700, 100, 200, 200], "camera_id": "cam-1",
	              "calib": {"center": [128, 128], "min_pt": [60, 200], "max_pt": [196, 200], "min_val": 0, "max_val": 6, "sweep": "cw", "scale": "linear"}}]}`)
	if got := pending(); len(got) != 0 {
		t.Errorf("declared candidate still pending: %v", got)
	}
	if out := scan(`[` + dial + `]`); out["accepted"] != float64(1) || out["sighted"] != float64(1) {
		t.Errorf("scan after saving: %v", out)
	}
	code, out := h.do(t, http.MethodGet, "/v1/discovery/candidates?status=accepted", nil)
	accepted := out["candidates"].([]any)
	if code != http.StatusOK || len(accepted) != 1 || accepted[0].(map[string]any)["gauge_id"] != "PRESS" {
		t.Errorf("accepted: %d %v", code, out)
	}

	// The person removes PRESS from the machine: the dial is proposed again.
	put("/v1/stations/M1", `{"machine_id": "M1", "plant": "P", "line": "L", "window_sec": 1,
	  "gauges": [{"gauge_id": "VOLT", "type": "seg7", "unit": "V", "roi": [130, 230, 240, 80], "camera_id": "cam-1",
	              "calib": {"digits": 4, "decimal_pos": 3, "color": "red_led"}}]}`)
	if out := scan(`[` + dial + `]`); out["reopened"] != float64(1) {
		t.Errorf("scan after removing the gauge: %v", out)
	}
	if got := pending(); len(got) != 1 || got[0].(map[string]any)["gauge_id"] != nil {
		t.Errorf("removed gauge not proposed again: %v", got)
	}
	put("/v1/stations/M1", `{"machine_id": "M1", "plant": "P", "line": "L", "window_sec": 1,
	  "gauges": [{"gauge_id": "VOLT", "type": "seg7", "unit": "V", "roi": [130, 230, 240, 80], "camera_id": "cam-1",
	              "calib": {"digits": 4, "decimal_pos": 3, "color": "red_led"}},
	             {"gauge_id": "PRESS", "type": "analog_dial", "unit": "bar", "roi": [700, 100, 200, 200], "camera_id": "cam-1",
	              "calib": {"center": [128, 128], "min_pt": [60, 200], "max_pt": [196, 200], "min_val": 0, "max_val": 6, "sweep": "cw", "scale": "linear"}}]}`)

	// VOLT was seen in the first scan only; PRESS just now.
	now = now.Add(20 * time.Minute)
	scan(`[` + dial + `]`)
	code, out = h.do(t, http.MethodGet, "/v1/discovery/gauges", nil)
	states := map[string]string{}
	for _, g := range out["gauges"].([]any) {
		m := g.(map[string]any)
		states[m["gauge_id"].(string)] = m["state"].(string)
	}
	if code != http.StatusOK || states["VOLT"] != sightLost || states["PRESS"] != sightSeen {
		t.Errorf("sight states: %d %v", code, states)
	}
}

func TestDiscoveryRefusesBadScans(t *testing.T) {
	h := newHarness(t)
	if code, _ := h.do(t, http.MethodPut, "/v1/cameras/cam-1", []byte(`{"url": "rtsp://cam/1", "sample_fps": 2}`)); code != http.StatusOK {
		t.Fatal(code)
	}
	for body, want := range map[string]int{
		`{"camera_id": "nope", "width": 100, "height": 100, "detections": []}`:                                                       http.StatusNotFound,
		`{"camera_id": "cam-1", "width": 0, "height": 100, "detections": []}`:                                                        http.StatusBadRequest,
		`{"camera_id": "cam-1", "width": 100, "height": 100, "detections": [{"roi": [90, 90, 20, 20], "type": "seg7", "score": 1}]}`: http.StatusBadRequest,
		`{"camera_id": "cam-1", "width": 100, "height": 100, "detections": [{"roi": [0, 0, 20, 20], "type": "radar", "score": 1}]}`:  http.StatusBadRequest,
		`not json`: http.StatusBadRequest,
	} {
		if code, out := h.do(t, http.MethodPost, "/v1/discovery/scans", []byte(body)); code != want {
			t.Errorf("%s: got %d %v, want %d", body, code, out, want)
		}
	}
	if code, _ := h.do(t, http.MethodGet, "/v1/discovery/candidates?status=maybe", nil); code != http.StatusBadRequest {
		t.Errorf("unknown status: %d", code)
	}
	if code, _ := h.do(t, http.MethodPost, "/v1/discovery/candidates/42/ignore", nil); code != http.StatusNotFound {
		t.Errorf("unknown candidate: %d", code)
	}
	if code, _ := h.do(t, http.MethodPost, "/v1/discovery/candidates/x/ignore", nil); code != http.StatusBadRequest {
		t.Errorf("bad candidate id: %d", code)
	}
}

func strconvID(v any) string {
	raw, _ := json.Marshal(v)
	return string(raw)
}
