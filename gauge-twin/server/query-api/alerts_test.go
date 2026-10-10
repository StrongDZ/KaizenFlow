package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

func TestAlertsAreRaisedWhenTheyLastAndClearedWhenGone(t *testing.T) {
	var mu sync.Mutex
	var posted []alertChange
	hook := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var c alertChange
		_ = json.NewDecoder(r.Body).Decode(&c)
		mu.Lock()
		posted = append(posted, c)
		mu.Unlock()
	}))
	defer hook.Close()

	now := testNow
	store := newTestStore()
	// machine_001: OIL_TEMP reads fine, AMMETER above its max of 28.
	store.latest = map[GaugeKey]Reading{
		{"machine_001", "OIL_TEMP"}: {TS: now, Value: ptr(60.0), Quality: ptr(float32(0.9))},
		{"machine_001", "AMMETER"}:  {TS: now, Value: ptr(29.8), Quality: ptr(float32(0.9)), Flags: []int16{4}},
	}
	store.edges = map[string]EdgeRow{"machine_001": {EdgeID: "edge-1", Status: "online"}}
	api := NewAPI(store, "", "*", 30*time.Second, 10*time.Minute, func() time.Time { return now },
		prometheus.NewRegistry(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	al := NewAlerter(api, hook.URL, prometheus.NewRegistry())
	al.now = func() time.Time { return now }
	step := func() []alertChange {
		t.Helper()
		changes, err := al.Step(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		return changes
	}

	if changes := step(); len(changes) != 0 {
		t.Fatalf("raised at once: %+v", changes)
	}
	now = now.Add(61 * time.Second)
	store.latest[GaugeKey{"machine_001", "AMMETER"}] = Reading{TS: now, Value: ptr(29.9), Quality: ptr(float32(0.9)), Flags: []int16{4}}
	store.latest[GaugeKey{"machine_001", "OIL_TEMP"}] = Reading{TS: now, Value: ptr(60.0), Quality: ptr(float32(0.9))}
	changes := step()
	if len(changes) != 1 || changes[0].Status != "firing" || changes[0].Alert.Kind != AlertOutOfRange || changes[0].Alert.GaugeID != "AMMETER" {
		t.Fatalf("after a minute: %+v", changes)
	}
	if open := al.Open(); len(open) != 1 || !open[0].Since.Equal(testNow) || *open[0].Value != 29.9 {
		t.Errorf("open: %+v", open)
	}

	// The value comes back: cleared at the next step.
	store.latest[GaugeKey{"machine_001", "AMMETER"}] = Reading{TS: now, Value: ptr(20.0), Quality: ptr(float32(0.9))}
	if changes := step(); len(changes) != 1 || changes[0].Status != "resolved" {
		t.Fatalf("after the value came back: %+v", changes)
	}

	// The edge goes offline: one critical alert for the edge, none per machine or gauge.
	store.edges["machine_001"] = EdgeRow{EdgeID: "edge-1", Status: "offline"}
	now = now.Add(5 * time.Minute)
	step()
	now = now.Add(61 * time.Second)
	changes = step()
	if len(changes) != 1 || changes[0].Alert.Kind != AlertEdgeOffline || changes[0].Alert.Severity != SeverityCritical ||
		len(changes[0].Alert.Machines) != 1 {
		t.Fatalf("edge offline: %+v", changes)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(posted) != 3 || posted[0].Text == "" || posted[1].Status != "resolved" {
		t.Errorf("posted: %+v", posted)
	}
}

func TestAMachineGoneSilentIsRaisedButOneNeverReportedIsNot(t *testing.T) {
	now := testNow
	store := newTestStore()
	store.latest = map[GaugeKey]Reading{}
	store.edges = map[string]EdgeRow{"machine_001": {EdgeID: "edge-1", Status: "online"}}
	api := NewAPI(store, "", "*", 30*time.Second, 10*time.Minute, func() time.Time { return now },
		prometheus.NewRegistry(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	al := NewAlerter(api, "", prometheus.NewRegistry())
	al.now = func() time.Time { return now }
	_, _ = al.Step(context.Background())
	now = now.Add(2 * time.Minute)
	changes, _ := al.Step(context.Background())
	if len(changes) != 1 || changes[0].Alert.Kind != AlertMachineSilent || changes[0].Alert.MachineID != "machine_001" {
		t.Errorf("got %+v; machine_002 has no edge and must not be raised", changes)
	}
}

func TestAlertsRoute(t *testing.T) {
	srv := newTestServer(t, newTestStore(), "")
	var got alertsView
	if resp := get(t, srv.URL+"/v1/alerts", &got); resp.StatusCode != http.StatusOK || got.Alerts == nil {
		t.Errorf("got %d %+v", resp.StatusCode, got)
	}
}

func TestReadingProblemInWords(t *testing.T) {
	if got := readingProblem([]string{"FLAG_BLUR", "FLAG_GLARE"}); got != "ảnh mờ, bị lóa" {
		t.Errorf("got %q", got)
	}
	if got := readingProblem(nil); got != "độ tin cậy thấp" {
		t.Errorf("got %q", got)
	}
}
