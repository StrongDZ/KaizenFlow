//go:build integration

package main

// Integration tests against TimescaleDB (migrated) and EMQX. Run with
// `make test-integration` after `make up && make migrate`.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
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
