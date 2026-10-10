package main

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"sync"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

type memEdges struct {
	mu    sync.Mutex
	lists map[string][]string
	nodes []EdgeNode
}

func (m *memEdges) Assignments(context.Context) (map[string][]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := map[string][]string{}
	for k, v := range m.lists {
		out[k] = append([]string{}, v...)
	}
	return out, nil
}

func (m *memEdges) SetAssignments(_ context.Context, lists map[string][]string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for k, v := range lists {
		m.lists[k] = append([]string{}, v...)
	}
	return nil
}

func (m *memEdges) Nodes(context.Context) ([]EdgeNode, error) { return m.nodes, nil }

func edgeHarness(t *testing.T) (*harness, *memEdges) {
	t.Helper()
	h := newHarness(t)
	return h, h.edges
}

func published(t *testing.T, h *harness, edge string) []string {
	t.Helper()
	raw := h.broker.get("denso/edges/" + edge + "/assignment")
	if raw == nil {
		return nil
	}
	var as gaugev1.EdgeAssignment
	if err := protojson.Unmarshal(raw, &as); err != nil {
		t.Fatal(err)
	}
	out := []string{}
	for _, m := range as.GetMachines() {
		out = append(out, m.GetPlant()+"/"+m.GetLine()+"/"+m.GetMachineId())
	}
	sort.Strings(out)
	return out
}

func TestEdgeAssignmentFlow(t *testing.T) {
	h, edges := edgeHarness(t)
	put := func(path, body string) (int, map[string]any) {
		t.Helper()
		return h.do(t, http.MethodPut, path, []byte(body))
	}
	if code, _ := put("/v1/cameras/cam-1", `{"url": "rtsp://cam/1", "sample_fps": 2}`); code != http.StatusOK {
		t.Fatal(code)
	}
	if code, _ := put("/v1/cameras/cam-2", `{"url": "rtsp://cam/2", "sample_fps": 2}`); code != http.StatusOK {
		t.Fatal(code)
	}
	if code, _ := put("/v1/stations/M1", string(stationOn("M1", "cam-1"))); code != http.StatusOK {
		t.Fatal(code)
	}
	if code, _ := put("/v1/stations/M3", string(stationOn("M3", "cam-2"))); code != http.StatusOK {
		t.Fatal(code)
	}
	// No edge yet: both wait.
	code, out := h.do(t, http.MethodGet, "/v1/edges", nil)
	if code != http.StatusOK || len(out["edges"].([]any)) != 0 || len(out["unassigned"].([]any)) != 2 {
		t.Fatalf("before any assignment: %d %v", code, out)
	}

	// A person assigns M1 to edge-1; an unknown machine is refused.
	if code, out := put("/v1/edges/edge-1", `{"machine_ids": ["M1", "GHOST"]}`); code != http.StatusBadRequest {
		t.Errorf("unknown machine: %d %v", code, out)
	}
	if code, out := put("/v1/edges/edge-1", `{"machine_ids": ["M1"]}`); code != http.StatusOK {
		t.Fatalf("assign: %d %v", code, out)
	}
	if got := published(t, h, "edge-1"); len(got) != 1 || got[0] != "DENSO_HN/L03/M1" {
		t.Errorf("published: %v", got)
	}

	// A new machine on the camera edge-1 reads goes to edge-1 by itself.
	if code, _ := put("/v1/stations/M2", string(stationOn("M2", "cam-1"))); code != http.StatusOK {
		t.Fatal(code)
	}
	if got := published(t, h, "edge-1"); len(got) != 2 {
		t.Errorf("after the new machine on cam-1: %v", got)
	}
	// With one edge only, a machine on another camera goes there too.
	if code, _ := put("/v1/stations/M4", string(stationOn("M4", "cam-2"))); code != http.StatusOK {
		t.Fatal(code)
	}
	if got := published(t, h, "edge-1"); len(got) != 3 {
		t.Errorf("single edge: %v", got)
	}

	// Moving M2 to edge-2 takes it off edge-1.
	if code, out := put("/v1/edges/edge-2", `{"machine_ids": ["M2"]}`); code != http.StatusOK {
		t.Fatalf("move: %d %v", code, out)
	}
	if one, two := published(t, h, "edge-1"), published(t, h, "edge-2"); len(one) != 2 || len(two) != 1 {
		t.Errorf("after the move: edge-1 %v edge-2 %v", one, two)
	}

	// A deleted machine leaves its edge.
	if code, _ := h.do(t, http.MethodDelete, "/v1/stations/M2", nil); code != http.StatusNoContent {
		t.Fatal(code)
	}
	if got := published(t, h, "edge-2"); len(got) != 0 {
		t.Errorf("deleted machine still assigned: %v", got)
	}

	// The list shows both edges and the machine nobody took (M3 was saved before any edge existed).
	_, out = h.do(t, http.MethodGet, "/v1/edges", nil)
	raw, _ := json.Marshal(out)
	var view struct {
		Edges []struct {
			EdgeID   string   `json:"edge_id"`
			Machines []string `json:"machines"`
		} `json:"edges"`
		Unassigned []string `json:"unassigned"`
	}
	_ = json.Unmarshal(raw, &view)
	if len(view.Edges) != 2 || len(view.Unassigned) != 1 || view.Unassigned[0] != "M3" {
		t.Errorf("list: %s", raw)
	}

	// The broker loses its retained messages: the republish restores the assignments.
	h.broker.mu.Lock()
	h.broker.retained = map[string][]byte{}
	h.broker.mu.Unlock()
	h.publisher.Republish(context.Background())
	if got := published(t, h, "edge-1"); len(got) != 2 {
		t.Errorf("after republish: %v", got)
	}
	_ = edges
}
