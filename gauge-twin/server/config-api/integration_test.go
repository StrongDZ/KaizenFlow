//go:build integration

package main

// Integration tests against TimescaleDB (migrated) and EMQX. Run with
// `make test-integration` after `make up && make migrate`.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net"
	"os"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/eclipse/paho.golang/paho"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"google.golang.org/protobuf/encoding/protojson"
)

func testStore(t *testing.T) (*PgStore, *pgxpool.Pool) {
	t.Helper()
	url := os.Getenv("CONFIG_API_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("CONFIG_API_TEST_DATABASE_URL is not set")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return NewPgStore(pool), pool
}

func uniqueMachine(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	id := fmt.Sprintf("ITEST_%d", time.Now().UnixNano())
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM station_config WHERE machine_id = $1`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM machine WHERE machine_id = $1`, id)
	})
	return id
}

// canonical returns the spec config for a machine in the form the API stores.
func canonical(t *testing.T, machineID string) []byte {
	t.Helper()
	var doc map[string]any
	if err := json.Unmarshal(specConfig(t), &doc); err != nil {
		t.Fatal(err)
	}
	doc["machine_id"] = machineID
	raw, _ := json.Marshal(doc)
	cfg, err := ParseConfig(raw)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConfigVersion = 0
	out, err := protojson.MarshalOptions{UseProtoNames: true}.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestIntegrationConcurrentPutsGetDistinctVersions(t *testing.T) {
	store, pool := testStore(t)
	ctx := context.Background()
	machine := uniqueMachine(t, pool)
	config := canonical(t, machine)

	const writers = 20
	versions := make([]int, writers)
	var wg sync.WaitGroup
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			stored, err := store.Put(ctx, machine, "DENSO_HN", "L03", config)
			if err != nil {
				t.Errorf("put %d: %v", i, err)
				return
			}
			versions[i] = int(stored.ConfigVersion)
		}(i)
	}
	wg.Wait()

	sort.Ints(versions)
	for i, v := range versions {
		if v != i+1 {
			t.Fatalf("versions are not 1..%d without repeats: %v", writers, versions)
		}
	}
	final, err := store.Get(ctx, machine)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	_ = json.Unmarshal(final.Config, &doc)
	if final.ConfigVersion != writers || doc["config_version"].(float64) != writers {
		t.Errorf("final version %d, JSON says %v", final.ConfigVersion, doc["config_version"])
	}

	// The gauge view reads straight from the stored config.
	var gauges, viewVersion int
	if err := pool.QueryRow(ctx, `SELECT count(*), max(config_version) FROM gauge WHERE machine_id = $1`, machine).
		Scan(&gauges, &viewVersion); err != nil {
		t.Fatal(err)
	}
	if gauges != 4 || viewVersion != writers {
		t.Errorf("gauge view: %d gauges at version %d", gauges, viewVersion)
	}
}

func TestIntegrationPublishedVersionNeverMovesBackwards(t *testing.T) {
	store, pool := testStore(t)
	ctx := context.Background()
	machine := uniqueMachine(t, pool)
	config := canonical(t, machine)
	for i := 0; i < 3; i++ {
		if _, err := store.Put(ctx, machine, "DENSO_HN", "L03", config); err != nil {
			t.Fatal(err)
		}
	}
	pending := func() bool {
		rows, err := store.Unpublished(ctx)
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range rows {
			if r.MachineID == machine {
				return true
			}
		}
		return false
	}

	if !pending() {
		t.Fatal("a new config must be pending")
	}
	_ = store.MarkPublished(ctx, machine, 3)
	_ = store.MarkPublished(ctx, machine, 2) // a slower replica reporting an older version
	_ = store.MarkPublished(ctx, machine, 9) // a version that does not exist
	stored, _ := store.Get(ctx, machine)
	if stored.PublishedVersion != 3 || pending() {
		t.Errorf("published_version %d, pending %v", stored.PublishedVersion, pending())
	}
	if err := store.Delete(ctx, machine); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(ctx, machine); err != ErrNotFound {
		t.Errorf("after delete: %v", err)
	}
	if err := store.Delete(ctx, machine); err != ErrNotFound {
		t.Errorf("second delete: %v", err)
	}
}

// retained subscribes to a topic and returns its retained payload, or nil.
func retained(t *testing.T, address, topic string) []byte {
	t.Helper()
	conn, err := net.DialTimeout("tcp", address, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	got := make(chan []byte, 1)
	id := fmt.Sprintf("itest-cfg-%d", time.Now().UnixNano())
	client := paho.NewClient(paho.ClientConfig{ClientID: id, Conn: conn,
		OnPublishReceived: []func(paho.PublishReceived) (bool, error){func(pr paho.PublishReceived) (bool, error) {
			select {
			case got <- pr.Packet.Payload:
			default:
			}
			return true, nil
		}}})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := client.Connect(ctx, &paho.Connect{ClientID: id, KeepAlive: 30, CleanStart: true}); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = client.Disconnect(&paho.Disconnect{}) }()
	if _, err := client.Subscribe(ctx, &paho.Subscribe{Subscriptions: []paho.SubscribeOptions{{Topic: topic, QoS: 1}}}); err != nil {
		t.Fatal(err)
	}
	select {
	case payload := <-got:
		return payload
	case <-time.After(1500 * time.Millisecond):
		return nil
	}
}

func TestIntegrationConfigIsRetainedOnTheBrokerAndClearedOnDelete(t *testing.T) {
	store, pool := testStore(t)
	address := os.Getenv("CONFIG_API_TEST_MQTT")
	if address == "" {
		t.Skip("CONFIG_API_TEST_MQTT is not set")
	}
	ctx := context.Background()
	machine := uniqueMachine(t, pool)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	broker := newMQTTBroker(address, "itest-config-api-"+machine)
	publisher := NewPublisher(store, broker, "denso", time.Hour, prometheus.NewRegistry(), logger)
	topic := "denso/DENSO_HN/L03/" + machine + "/config"

	if _, err := store.Put(ctx, machine, "DENSO_HN", "L03", canonical(t, machine)); err != nil {
		t.Fatal(err)
	}
	publisher.Sync(ctx)

	payload := retained(t, address, topic)
	if payload == nil {
		t.Fatal("no retained config on the broker")
	}
	cfg, err := ParseConfig(payload)
	if err != nil || cfg.GetConfigVersion() != 1 || cfg.GetMachineId() != machine || len(cfg.GetGauges()) != 4 {
		t.Fatalf("retained config: %v %v", cfg, err)
	}
	if stored, _ := store.Get(ctx, machine); stored.PublishedVersion != 1 {
		t.Errorf("published_version: %d", stored.PublishedVersion)
	}

	if err := broker.PublishRetained(ctx, topic, nil); err != nil {
		t.Fatal(err)
	}
	if payload := retained(t, address, topic); payload != nil {
		t.Errorf("retained config still there after clearing: %d bytes", len(payload))
	}
}

func TestIntegrationDiscoveryStore(t *testing.T) {
	_, pool := testStore(t)
	store := NewPgDiscoveryStore(pool)
	ctx := context.Background()
	camera := fmt.Sprintf("itest-cam-%d", time.Now().UnixNano())
	gauge := GaugeRef{MachineID: camera, GaugeID: "OIL"}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM gauge_candidate WHERE camera_id = $1`, camera)
		_, _ = pool.Exec(ctx, `DELETE FROM camera_scan WHERE camera_id = $1`, camera)
		_, _ = pool.Exec(ctx, `DELETE FROM gauge_sighting WHERE machine_id = $1`, camera)
	})
	at := time.Now().UTC().Truncate(time.Second)
	scan := CameraScan{CameraID: camera, ScannedAt: at, Width: 1280, Height: 720, Detections: 2}
	det := Detection{ROI: []int32{10, 20, 300, 200}, Type: "analog_dial", Score: 0.3, Hint: json.RawMessage(`{"center": [128, 128]}`), CropJPEG: []byte{1, 2, 3}}
	if err := store.ApplyScan(ctx, scan, scanPlan{Sighted: []GaugeRef{gauge}, Inserts: []Detection{det}}); err != nil {
		t.Fatal(err)
	}
	got, err := store.Candidates(ctx, camera)
	if err != nil || len(got) != 1 {
		t.Fatalf("got %+v, %v", got, err)
	}
	c := got[0]
	if c.Status != candidatePending || c.Seen != 1 || c.Type != "analog_dial" || string(c.CropJPEG) != "\x01\x02\x03" || !c.FirstSeen.Equal(at) {
		t.Errorf("inserted: %+v", c)
	}

	// Found again with a better score and a new region; ignored afterwards, then found again: only the count moves.
	later := at.Add(5 * time.Minute)
	moved := Detection{ROI: []int32{12, 22, 300, 200}, Type: "analog_dial", Score: 0.5, Hint: json.RawMessage(`{}`)}
	if err := store.ApplyScan(ctx, CameraScan{CameraID: camera, ScannedAt: later, Width: 1280, Height: 720}, scanPlan{Updates: map[int64]Detection{c.ID: moved}}); err != nil {
		t.Fatal(err)
	}
	if c, err = store.SetCandidateStatus(ctx, c.ID, candidateIgnored); err != nil || c.Status != candidateIgnored || c.DecidedAt == nil {
		t.Fatalf("ignore: %+v, %v", c, err)
	}
	moved.ROI = []int32{500, 500, 10, 10}
	if err := store.ApplyScan(ctx, CameraScan{CameraID: camera, ScannedAt: later.Add(time.Minute), Width: 1280, Height: 720}, scanPlan{Updates: map[int64]Detection{c.ID: moved}}); err != nil {
		t.Fatal(err)
	}
	got, _ = store.Candidates(ctx, camera)
	// Mean score: (0.3 + 0.5) / 2, then (0.4 * 2 + 0.5) / 3.
	if c := got[0]; c.Seen != 3 || math.Abs(float64(c.Score)-1.3/3) > 1e-4 || c.ROI[0] != 12 || string(c.CropJPEG) != "\x01\x02\x03" || c.Status != candidateIgnored {
		t.Errorf("after two more scans: %+v", c)
	}

	// Restored, then accepted when a gauge is declared on it.
	if _, err := store.SetCandidateStatus(ctx, c.ID, candidatePending); err != nil {
		t.Fatal(err)
	}
	if err := store.ApplyScan(ctx, CameraScan{CameraID: camera, ScannedAt: later.Add(2 * time.Minute), Width: 1280, Height: 720}, scanPlan{Accepted: map[int64]GaugeRef{c.ID: gauge}}); err != nil {
		t.Fatal(err)
	}
	got, _ = store.Candidates(ctx, camera)
	if c := got[0]; c.Status != candidateAccepted || c.GaugeID == nil || *c.GaugeID != "OIL" {
		t.Errorf("accepted: %+v", c)
	}
	// Its gauge removed: back to pending.
	if err := store.ApplyScan(ctx, CameraScan{CameraID: camera, ScannedAt: later.Add(3 * time.Minute), Width: 1280, Height: 720}, scanPlan{Reopened: []int64{c.ID}}); err != nil {
		t.Fatal(err)
	}
	got, _ = store.Candidates(ctx, camera)
	if c := got[0]; c.Status != candidatePending || c.GaugeID != nil || c.DecidedAt != nil {
		t.Errorf("reopened: %+v", c)
	}
	if _, err := store.SetCandidateStatus(ctx, 1<<62, candidateIgnored); !errors.Is(err, ErrCandidateNotFound) {
		t.Errorf("unknown candidate: %v", err)
	}

	scans, err := store.Scans(ctx)
	found := false
	for _, s := range scans {
		found = found || (s.CameraID == camera && s.ScannedAt.Equal(later.Add(3*time.Minute)))
	}
	sightings, err2 := store.Sightings(ctx)
	seen := false
	for _, s := range sightings {
		seen = seen || (s.GaugeRef == gauge && s.LastSeen.Equal(at))
	}
	if err != nil || err2 != nil || !found || !seen {
		t.Errorf("scans %v sightings %v (%v %v)", found, seen, err, err2)
	}
}

func TestIntegrationEdgeStore(t *testing.T) {
	_, pool := testStore(t)
	store := NewPgEdgeStore(pool)
	ctx := context.Background()
	edge := fmt.Sprintf("itest-edge-%d", time.Now().UnixNano())
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM edge_assignment WHERE edge_id LIKE $1`, edge+"%") })
	if err := store.SetAssignments(ctx, map[string][]string{edge: {"M1", "M2"}, edge + "-b": nil}); err != nil {
		t.Fatal(err)
	}
	if err := store.SetAssignments(ctx, map[string][]string{edge: {"M2"}}); err != nil {
		t.Fatal(err)
	}
	lists, err := store.Assignments(ctx)
	if err != nil || len(lists[edge]) != 1 || lists[edge][0] != "M2" {
		t.Errorf("assignments: %v, %v", lists[edge], err)
	}
	if b, ok := lists[edge+"-b"]; !ok || len(b) != 0 {
		t.Errorf("empty assignment: %v %v", b, ok)
	}
	if _, err := store.Nodes(ctx); err != nil {
		t.Error(err)
	}
}
