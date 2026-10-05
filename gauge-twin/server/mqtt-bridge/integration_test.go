//go:build integration

package main

// Integration tests and measurements against a real EMQX and Kafka. Run with
// `make test-integration` after `make up`. Every test uses its own topic
// prefix, share group and Kafka topics, so runs do not disturb each other.

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/eclipse/paho.golang/paho"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/twmb/franz-go/pkg/kgo"
)

// dropConnection closes the socket without a DISCONNECT, as a crash would.
func (b *Bridge) dropConnection() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.conn != nil {
		_ = b.conn.Close()
	}
}

// warmupValue marks the records startBridge produces to create the topic.
var warmupValue = []byte{0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF}

type testEnv struct {
	t      *testing.T
	mqtt   string
	kafka  string
	prefix string
	group  string
	topic  string // Kafka topic for telemetry
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	mqtt, kafka := os.Getenv("BRIDGE_TEST_MQTT"), os.Getenv("BRIDGE_TEST_KAFKA")
	if mqtt == "" || kafka == "" {
		t.Skip("BRIDGE_TEST_MQTT / BRIDGE_TEST_KAFKA are not set")
	}
	id := time.Now().UnixNano()
	return &testEnv{t: t, mqtt: mqtt, kafka: kafka,
		prefix: fmt.Sprintf("it%d", id), group: fmt.Sprintf("g%d", id), topic: fmt.Sprintf("it.telemetry.%d", id)}
}

// sessionExpiry selects the session mode under test: BRIDGE_TEST_SESSION_EXPIRY=0
// means a clean session that ends with the connection.
func sessionExpiry() time.Duration {
	if d, err := time.ParseDuration(os.Getenv("BRIDGE_TEST_SESSION_EXPIRY")); err == nil {
		return d
	}
	return 10 * time.Minute
}

type runningBridge struct {
	bridge *Bridge
	stop   context.CancelFunc
	done   chan struct{}
}

// stuckProducer never confirms anything, like a replica whose Kafka
// connection hangs: every message it receives stays unacknowledged.
type stuckProducer struct{}

func (stuckProducer) Produce(context.Context, *kgo.Record, func(*kgo.Record, error)) {}

// startStuckBridge runs a replica that receives messages but never
// acknowledges them.
func (e *testEnv) startStuckBridge(clientID string) *runningBridge {
	e.t.Helper()
	return e.start(clientID, stuckProducer{})
}

// startBridge runs a replica in-process and waits until it is subscribed.
func (e *testEnv) startBridge(clientID string) *runningBridge {
	e.t.Helper()
	return e.start(clientID, nil)
}

func (e *testEnv) start(clientID string, override Producer) *runningBridge {
	e.t.Helper()
	producer, err := kgo.NewClient(
		kgo.SeedBrokers(e.kafka),
		kgo.RequiredAcks(kgo.AllISRAcks()),
		kgo.ProducerLinger(5*time.Millisecond),
		kgo.AllowAutoTopicCreation(),
	)
	if err != nil {
		e.t.Fatal(err)
	}
	cfg := Config{
		Broker: e.mqtt, ClientID: clientID, ShareGroup: e.group, TopicPrefix: e.prefix,
		SessionExpiry: sessionExpiry(), ReceiveMaximum: 1024, KeepAlive: 30,
		ConnectTimeout: 10 * time.Second, BackoffMin: 500 * time.Millisecond, BackoffMax: 2 * time.Second,
		DrainTimeout:   time.Second,
		KafkaTelemetry: e.topic, KafkaStatus: e.topic + ".status",
	}
	var target Producer = producer
	if override != nil {
		target = override
	}
	bridge := NewBridge(cfg, target, NewMetrics(prometheus.NewRegistry()), slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	rb := &runningBridge{bridge: bridge, stop: cancel, done: make(chan struct{})}
	go func() {
		defer close(rb.done)
		_ = bridge.Run(ctx)
		flushCtx, cancelFlush := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancelFlush()
		_ = producer.Flush(flushCtx)
		producer.Close()
	}()
	e.t.Cleanup(func() { cancel(); <-rb.done })
	// Create the Kafka topic up front so the first messages do not wait for it.
	warm := producer.ProduceSync(context.Background(), &kgo.Record{Topic: e.topic, Key: []byte("warmup"), Value: warmupValue})
	if err := warm.FirstErr(); err != nil {
		e.t.Fatalf("warm-up produce: %v", err)
	}
	deadline := time.Now().Add(15 * time.Second)
	for bridge.Healthy() != nil {
		if time.Now().After(deadline) {
			e.t.Fatalf("bridge %s did not connect", clientID)
		}
		time.Sleep(20 * time.Millisecond)
	}
	return rb
}

// kill simulates a crash: the socket is dropped and the replica never comes back.
func (rb *runningBridge) kill() {
	rb.bridge.dropConnection()
	rb.stop()
	<-rb.done
}

// stopGracefully disconnects cleanly; the session stays on the broker.
func (rb *runningBridge) stopGracefully() {
	rb.stop()
	<-rb.done
}

type publishResult struct {
	acked   map[uint64]bool
	reasons map[byte]int // PUBACK reason codes
	failed  int
}

// publish sends ids [from, from+count) as QoS 1 telemetry at the given rate
// (messages per second; 0 = as fast as possible), spread over 20 machines.
func (e *testEnv) publish(from, count uint64, rate int) publishResult {
	e.t.Helper()
	conn, err := net.DialTimeout("tcp", e.mqtt, 5*time.Second)
	if err != nil {
		e.t.Fatal(err)
	}
	clientID := fmt.Sprintf("pub-%s-%d", e.prefix, from)
	client := paho.NewClient(paho.ClientConfig{ClientID: clientID, Conn: conn, PacketTimeout: 20 * time.Second})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if _, err := client.Connect(ctx, &paho.Connect{ClientID: clientID, KeepAlive: 30, CleanStart: true}); err != nil {
		e.t.Fatal(err)
	}
	defer func() { _ = client.Disconnect(&paho.Disconnect{}) }()

	res := publishResult{acked: map[uint64]bool{}, reasons: map[byte]int{}}
	var mu sync.Mutex
	var wg sync.WaitGroup
	slots := make(chan struct{}, 200) // concurrent unacknowledged publishes
	var tick <-chan time.Time
	if rate > 0 {
		ticker := time.NewTicker(time.Second / time.Duration(rate))
		defer ticker.Stop()
		tick = ticker.C
	}
	for id := from; id < from+count; id++ {
		if tick != nil {
			<-tick
		}
		slots <- struct{}{}
		wg.Add(1)
		go func(id uint64) {
			defer wg.Done()
			defer func() { <-slots }()
			payload := make([]byte, 8)
			binary.BigEndian.PutUint64(payload, id)
			topic := fmt.Sprintf("%s/P/L/machine_%02d/telemetry", e.prefix, id%20)
			resp, err := client.Publish(ctx, &paho.Publish{Topic: topic, QoS: 1, Payload: payload})
			mu.Lock()
			defer mu.Unlock()
			if resp != nil {
				res.reasons[resp.ReasonCode]++
			}
			if resp != nil && (resp.ReasonCode == 0x00 || resp.ReasonCode == 0x10) {
				res.acked[id] = true
			} else {
				res.failed++
				_ = err
			}
		}(id)
	}
	wg.Wait()
	return res
}

// consume reads the Kafka topic from the start until it has been quiet for a
// while and returns how many times each id was seen, checking the keys.
func (e *testEnv) consume(quiet time.Duration) map[uint64]int {
	e.t.Helper()
	client, err := kgo.NewClient(
		kgo.SeedBrokers(e.kafka),
		kgo.ConsumeTopics(e.topic),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
	)
	if err != nil {
		e.t.Fatal(err)
	}
	defer client.Close()
	seen := map[uint64]int{}
	// The topic may have just been created: keep polling for a while even if
	// the first polls come back empty.
	started, lastData := time.Now(), time.Time{}
	for {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		fetches := client.PollFetches(ctx)
		cancel()
		fetches.EachRecord(func(r *kgo.Record) {
			lastData = time.Now()
			if string(r.Key) == "warmup" {
				return
			}
			id := binary.BigEndian.Uint64(r.Value)
			seen[id]++
			if want := fmt.Sprintf("machine_%02d", id%20); string(r.Key) != want {
				e.t.Errorf("id %d: key %q, want %q", id, r.Key, want)
			}
		})
		if !lastData.IsZero() && time.Since(lastData) > quiet {
			return seen
		}
		if lastData.IsZero() && time.Since(started) > 20*time.Second {
			return seen
		}
	}
}

func summarize(acked map[uint64]bool, seen map[uint64]int) (missing, duplicates int) {
	for id := range acked {
		if seen[id] == 0 {
			missing++
		}
	}
	for _, n := range seen {
		if n > 1 {
			duplicates += n - 1
		}
	}
	return missing, duplicates
}

func TestIntegrationForwardsEveryMessageOnce(t *testing.T) {
	e := newTestEnv(t)
	e.startBridge("bridge-a-" + e.prefix)
	e.startBridge("bridge-b-" + e.prefix)

	res := e.publish(0, 5000, 0)
	seen := e.consume(3 * time.Second)

	missing, duplicates := summarize(res.acked, seen)
	t.Logf("published=%d acked=%d reasons=%v kafka=%d missing=%d duplicates=%d",
		5000, len(res.acked), res.reasons, len(seen), missing, duplicates)
	if len(res.acked) != 5000 || missing != 0 || duplicates != 0 {
		t.Fatalf("expected every message exactly once")
	}
}

// Case (a): one of two replicas crashes for good while traffic flows.
func TestIntegrationReplicaDiesForGood(t *testing.T) {
	e := newTestEnv(t)
	a := e.startBridge("bridge-a-" + e.prefix)
	e.startBridge("bridge-b-" + e.prefix)

	go func() {
		time.Sleep(3 * time.Second)
		a.kill()
	}()
	res := e.publish(0, 10000, 1000)
	seen := e.consume(5 * time.Second)
	missing, duplicates := summarize(res.acked, seen)
	t.Logf("with replica A dead: acked=%d reasons=%v kafka=%d missing=%d duplicates=%d",
		len(res.acked), res.reasons, len(seen), missing, duplicates)

	// Does the missing part sit in A's session, waiting for that client ID?
	e.startBridge("bridge-a-" + e.prefix)
	seenAfter := e.consume(5 * time.Second)
	missingAfter, duplicatesAfter := summarize(res.acked, seenAfter)
	t.Logf("after A came back with the same client ID: kafka=%d missing=%d duplicates=%d",
		len(seenAfter), missingAfter, duplicatesAfter)

	if missingAfter != 0 {
		t.Errorf("%d acknowledged messages never reached Kafka", missingAfter)
	}
}

// Case (b): a replica crashes and restarts with the same client ID.
func TestIntegrationReplicaRestartsWithSameClientID(t *testing.T) {
	e := newTestEnv(t)
	a := e.startBridge("bridge-a-" + e.prefix)
	e.startBridge("bridge-b-" + e.prefix)

	go func() {
		time.Sleep(3 * time.Second)
		a.bridge.dropConnection() // Run reconnects with the same client ID
	}()
	res := e.publish(0, 10000, 1000)
	seen := e.consume(5 * time.Second)

	missing, duplicates := summarize(res.acked, seen)
	t.Logf("acked=%d reasons=%v kafka=%d missing=%d duplicates=%d",
		len(res.acked), res.reasons, len(seen), missing, duplicates)
	if missing != 0 {
		t.Errorf("%d acknowledged messages never reached Kafka", missing)
	}
}

// Measures what the broker does with messages published while every replica
// is away: how many survive in the session queue of the bridge.
func TestIntegrationQueueWhileNoReplicaIsConnected(t *testing.T) {
	e := newTestEnv(t)
	a := e.startBridge("bridge-a-" + e.prefix)
	a.stopGracefully()

	const count = 20000
	res := e.publish(0, count, 0)
	e.startBridge("bridge-a-" + e.prefix)
	seen := e.consume(5 * time.Second)

	missing, duplicates := summarize(res.acked, seen)
	t.Logf("published while offline=%d acked=%d reasons=%v delivered after reconnect=%d missing=%d duplicates=%d",
		count, len(res.acked), res.reasons, len(seen), missing, duplicates)
	// With the queue limits of infra/compose/dev.yml nothing may be dropped.
	if sessionExpiry() > 0 && missing != 0 {
		t.Errorf("%d of %d messages published while no replica was connected were lost", missing, count)
	}
}

// A replica that holds many unacknowledged messages crashes. With persistent
// sessions the broker keeps them for that client ID; they must all arrive
// once the replica is back.
func TestIntegrationUnackedMessagesSurviveReplicaCrash(t *testing.T) {
	e := newTestEnv(t)
	stuck := e.startStuckBridge("bridge-a-" + e.prefix)
	e.startBridge("bridge-b-" + e.prefix)

	res := e.publish(0, 4000, 1000)
	before := e.consume(3 * time.Second)
	stuck.kill()
	whileDead := e.consume(10 * time.Second)
	e.startBridge("bridge-a-" + e.prefix)
	after := e.consume(5 * time.Second)

	held, _ := summarize(res.acked, before)
	missingWhileDead, _ := summarize(res.acked, whileDead)
	missing, duplicates := summarize(res.acked, after)
	t.Logf("acked=%d; held unacknowledged by the stuck replica=%d; still missing while it was dead=%d; "+
		"after it came back: missing=%d duplicates=%d", len(res.acked), held, missingWhileDead, missing, duplicates)
	if held == 0 {
		t.Fatal("the stuck replica held nothing; the test did not exercise redelivery")
	}
	if missing != 0 {
		t.Errorf("%d acknowledged messages never reached Kafka", missing)
	}
}
