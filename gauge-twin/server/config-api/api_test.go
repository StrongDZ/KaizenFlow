package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// ---------------------------------------------------------------- fakes ----

type memStore struct {
	mu   sync.Mutex
	rows map[string]Stored
}

func newMemStore() *memStore { return &memStore{rows: map[string]Stored{}} }

func (m *memStore) Put(_ context.Context, machineID, _, _ string, config []byte) (Stored, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	version := m.rows[machineID].ConfigVersion + 1
	var doc map[string]any
	_ = json.Unmarshal(config, &doc)
	doc["config_version"] = version
	withVersion, _ := json.Marshal(doc)
	row := Stored{MachineID: machineID, ConfigVersion: version, PublishedVersion: m.rows[machineID].PublishedVersion,
		Config: withVersion, UpdatedAt: time.Now()}
	m.rows[machineID] = row
	return row, nil
}

func (m *memStore) Get(_ context.Context, machineID string) (Stored, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	row, ok := m.rows[machineID]
	if !ok {
		return Stored{}, ErrNotFound
	}
	return row, nil
}

func (m *memStore) List(context.Context) ([]Stored, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Stored, 0, len(m.rows))
	for _, row := range m.rows {
		out = append(out, row)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].MachineID < out[j].MachineID })
	return out, nil
}

func (m *memStore) Delete(_ context.Context, machineID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.rows[machineID]; !ok {
		return ErrNotFound
	}
	delete(m.rows, machineID)
	return nil
}

func (m *memStore) Unpublished(ctx context.Context) ([]Stored, error) {
	all, _ := m.List(ctx)
	var out []Stored
	for _, row := range all {
		if row.PublishedVersion < row.ConfigVersion {
			out = append(out, row)
		}
	}
	return out, nil
}

func (m *memStore) MarkPublished(_ context.Context, machineID string, version uint32) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if row, ok := m.rows[machineID]; ok && row.PublishedVersion < version && row.ConfigVersion >= version {
		row.PublishedVersion = version
		m.rows[machineID] = row
	}
	return nil
}

func (m *memStore) Ping(context.Context) error { return nil }

type fakeBroker struct {
	mu       sync.Mutex
	down     bool
	retained map[string][]byte
}

func (b *fakeBroker) PublishRetained(_ context.Context, topic string, payload []byte) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.down {
		return errors.New("broker unreachable")
	}
	if len(payload) == 0 {
		delete(b.retained, topic)
	} else {
		b.retained[topic] = append([]byte(nil), payload...)
	}
	return nil
}

func (b *fakeBroker) get(topic string) []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.retained[topic]
}

func (b *fakeBroker) setDown(down bool) {
	b.mu.Lock()
	b.down = down
	b.mu.Unlock()
}

// -------------------------------------------------------------- harness ----

type harness struct {
	server    *httptest.Server
	store     *memStore
	broker    *fakeBroker
	publisher *Publisher
	discovery *Discovery
	edges     *memEdges
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	registry := prometheus.NewRegistry()
	store, broker := newMemStore(), &fakeBroker{retained: map[string][]byte{}}
	publisher := NewPublisher(store, broker, "denso", time.Hour, registry, logger)
	mux := http.NewServeMux()
	api := NewAPI(store, broker, publisher, "denso", registry, logger)
	api.cameras = &memCameras{rows: map[string]Camera{}}
	api.Register(mux)
	NewCameras(api.cameras, store, publisher, api).Register(mux)
	discovery := NewDiscovery(newMemDiscovery(), api.cameras, store, api)
	discovery.Register(mux)
	edgeStore := &memEdges{lists: map[string][]string{}}
	edges := NewEdges(edgeStore, store, broker, "denso", api)
	api.edges = edges
	publisher.AlsoRepublish = edges.PublishAll
	edges.Register(mux)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return &harness{server, store, broker, publisher, discovery, edgeStore}
}

func (h *harness) do(t *testing.T, method, path string, body []byte) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(method, h.server.URL+path, bytes.NewReader(body))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatalf("response is not JSON: %s", raw)
		}
	}
	return resp.StatusCode, out
}

const configPath = "/v1/stations/STAMPING_PRESS_01"
const topic = "denso/DENSO_HN/L03/STAMPING_PRESS_01/config"

// specConfig is the station config of SPEC section 3.1, quad as [[x, y], ...].
func specConfig(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile("testdata/spec_station_config.json")
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// ----------------------------------------------------------------- tests ----

func TestPutStoresPublishesAndIncrementsTheVersion(t *testing.T) {
	h := newHarness(t)

	code, body := h.do(t, http.MethodPut, configPath, specConfig(t))
	if code != http.StatusOK || body["config_version"].(float64) != 1 {
		t.Fatalf("first put: %d %v", code, body)
	}
	h.publisher.Sync(context.Background())

	var published map[string]any
	if err := json.Unmarshal(h.broker.get(topic), &published); err != nil {
		t.Fatalf("nothing retained on %s", topic)
	}
	// The client sent version 7; the server assigns its own.
	if published["config_version"].(float64) != 1 || published["machine_id"] != "STAMPING_PRESS_01" {
		t.Errorf("published: %v", published)
	}
	// The spec's [[x, y]] quad is stored in the proto form the edge parses.
	quad := published["gauges"].([]any)[0].(map[string]any)["quad"].([]any)
	if first := quad[0].(map[string]any); first["x"].(float64) != 818 || first["y"].(float64) != 350 {
		t.Errorf("quad: %v", quad)
	}
	if _, err := ParseConfig(h.broker.get(topic)); err != nil {
		t.Errorf("published config does not parse: %v", err)
	}

	code, body = h.do(t, http.MethodPut, configPath, specConfig(t))
	if code != http.StatusOK || body["config_version"].(float64) != 2 || body["published_version"].(float64) != 1 {
		t.Fatalf("second put: %d %v", code, body)
	}
	h.publisher.Sync(context.Background())
	code, body = h.do(t, http.MethodGet, configPath, nil)
	if code != http.StatusOK || body["config_version"].(float64) != 2 || body["published_version"].(float64) != 2 {
		t.Errorf("get: %d %v", code, body)
	}
	if !strings.Contains(string(h.broker.get(topic)), `"config_version":2`) {
		t.Error("version 2 was not published")
	}
}

func TestBrokerOutageDelaysPublishingButLosesNothing(t *testing.T) {
	h := newHarness(t)
	h.broker.setDown(true)

	code, _ := h.do(t, http.MethodPut, configPath, specConfig(t))
	if code != http.StatusOK {
		t.Fatalf("put must succeed while the broker is down: %d", code)
	}
	h.publisher.Sync(context.Background())
	if _, body := h.do(t, http.MethodGet, configPath, nil); body["published_version"].(float64) != 0 {
		t.Fatalf("marked published although the broker was down: %v", body)
	}

	h.broker.setDown(false)
	h.publisher.Sync(context.Background())
	if _, body := h.do(t, http.MethodGet, configPath, nil); body["published_version"].(float64) != 1 || h.broker.get(topic) == nil {
		t.Errorf("not published after the broker came back: %v", body)
	}
}

func TestRepublishRestoresConfigsTheBrokerLost(t *testing.T) {
	h := newHarness(t)
	if code, _ := h.do(t, http.MethodPut, configPath, specConfig(t)); code != http.StatusOK {
		t.Fatal(code)
	}
	h.publisher.Sync(context.Background())
	// The broker restarts without its data: the database still says published.
	h.broker.mu.Lock()
	h.broker.retained = map[string][]byte{}
	h.broker.mu.Unlock()
	h.publisher.Sync(context.Background())
	if h.broker.get(topic) != nil {
		t.Fatal("Sync publishes pending configs only; the test needs a lost one")
	}
	h.publisher.Republish(context.Background())
	if h.broker.get(topic) == nil {
		t.Error("config not published again")
	}
}

func TestInvalidConfigsAreRejectedWithDetails(t *testing.T) {
	h := newHarness(t)
	mutate := func(edit func(map[string]any)) []byte {
		var doc map[string]any
		_ = json.Unmarshal(specConfig(t), &doc)
		edit(doc)
		out, _ := json.Marshal(doc)
		return out
	}
	gauge := func(doc map[string]any, i int) map[string]any { return doc["gauges"].([]any)[i].(map[string]any) }

	cases := map[string][]byte{
		"type":        mutate(func(d map[string]any) { gauge(d, 0)["type"] = "sundial" }),
		"sweep":       mutate(func(d map[string]any) { gauge(d, 0)["calib"].(map[string]any)["sweep"] = "sideways" }),
		"scale":       mutate(func(d map[string]any) { gauge(d, 0)["calib"].(map[string]any)["scale"] = "log" }),
		"color":       mutate(func(d map[string]any) { gauge(d, 1)["calib"].(map[string]any)["color"] = "purple" }),
		"quad":        mutate(func(d map[string]any) { gauge(d, 0)["quad"] = []any{[]any{1, 2}, []any{3, 4}} }),
		"roi":         mutate(func(d map[string]any) { gauge(d, 0)["roi"] = []any{1, 2, 3} }),
		"duplicate":   mutate(func(d map[string]any) { gauge(d, 1)["gauge_id"] = "MAIN_PRESSURE" }),
		"plant":       mutate(func(d map[string]any) { d["plant"] = "DENSO/HN" }),
		"window_sec":  mutate(func(d map[string]any) { d["window_sec"] = 0 }),
		"unknown key": mutate(func(d map[string]any) { d["windw_sec"] = 1 }),
		"machine_id":  mutate(func(d map[string]any) { d["machine_id"] = "ANOTHER_MACHINE" }),
		"not json":    []byte("{"),
	}
	for name, body := range cases {
		code, resp := h.do(t, http.MethodPut, configPath, body)
		if code != http.StatusBadRequest || resp["error"] == "" {
			t.Errorf("%s: got %d %v", name, code, resp)
		}
	}
	if code, _ := h.do(t, http.MethodGet, configPath, nil); code != http.StatusNotFound {
		t.Errorf("an invalid config was stored: %d", code)
	}
}

func TestListGetAndDelete(t *testing.T) {
	h := newHarness(t)
	h.do(t, http.MethodPut, configPath, specConfig(t))
	h.publisher.Sync(context.Background())

	code, body := h.do(t, http.MethodGet, "/v1/stations", nil)
	stations := body["stations"].([]any)
	if code != http.StatusOK || len(stations) != 1 || stations[0].(map[string]any)["config"].(map[string]any)["plant"] != "DENSO_HN" {
		t.Fatalf("list: %d %v", code, body)
	}

	// The broker is down: nothing may be deleted, or the retained config would be orphaned.
	h.broker.setDown(true)
	if code, _ := h.do(t, http.MethodDelete, configPath, nil); code != http.StatusServiceUnavailable {
		t.Errorf("delete with broker down: %d", code)
	}
	if code, _ := h.do(t, http.MethodGet, configPath, nil); code != http.StatusOK {
		t.Error("config was deleted although MQTT could not be cleared")
	}

	h.broker.setDown(false)
	if code, _ := h.do(t, http.MethodDelete, configPath, nil); code != http.StatusNoContent {
		t.Errorf("delete: %d", code)
	}
	if h.broker.get(topic) != nil {
		t.Error("retained config not cleared")
	}
	for _, method := range []string{http.MethodGet, http.MethodDelete} {
		if code, _ := h.do(t, method, configPath, nil); code != http.StatusNotFound {
			t.Errorf("%s after delete: %d", method, code)
		}
	}
}

func TestValidateAcceptsTheSpecExampleAndBothQuadForms(t *testing.T) {
	cfg, err := ParseConfig(specConfig(t))
	if err != nil {
		t.Fatal(err)
	}
	if problems := Validate(cfg); len(problems) != 0 {
		t.Fatalf("spec example rejected: %v", problems)
	}
	if len(cfg.GetGauges()[0].GetQuad()) != 4 || cfg.GetGauges()[0].GetQuad()[2].GetX() != 1062 {
		t.Errorf("quad: %v", cfg.GetGauges()[0].GetQuad())
	}
	proto := strings.Replace(string(specConfig(t)), "[[818, 350], [1066, 356], [1062, 598], [822, 592]]",
		`[{"x": 818, "y": 350}, {"x": 1066, "y": 356}, {"x": 1062, "y": 598}, {"x": 822, "y": 592}]`, 1)
	if _, err := ParseConfig([]byte(proto)); err != nil {
		t.Errorf("proto form rejected: %v", err)
	}
}
