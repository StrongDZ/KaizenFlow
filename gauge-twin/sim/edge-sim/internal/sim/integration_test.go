//go:build integration

package sim

// Integration tests against a real MQTT broker. Run with `make test-integration`
// after `make up`; the broker address comes from EDGE_SIM_TEST_BROKER.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/eclipse/paho.golang/paho"
	"github.com/prometheus/client_golang/prometheus"
	"google.golang.org/protobuf/proto"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

type received struct {
	mu       sync.Mutex
	telem    []*gaugev1.Telemetry
	topics   map[string]bool
	statuses []*gaugev1.Status
	retained map[string]bool // status topics to clean up
}

// subscribe listens on denso/<plant>/# with QoS 1 and collects everything.
func subscribe(t *testing.T, broker, plant string) (*received, *paho.Client) {
	t.Helper()
	rec := &received{topics: map[string]bool{}, retained: map[string]bool{}}
	conn, err := net.DialTimeout("tcp", broker, 5*time.Second)
	if err != nil {
		t.Fatalf("dial broker %s: %v", broker, err)
	}
	client := paho.NewClient(paho.ClientConfig{
		ClientID: "itest-sub-" + plant,
		Conn:     conn,
		OnPublishReceived: []func(paho.PublishReceived) (bool, error){func(pr paho.PublishReceived) (bool, error) {
			topic, payload := pr.Packet.Topic, pr.Packet.Payload
			rec.mu.Lock()
			defer rec.mu.Unlock()
			switch {
			case strings.HasSuffix(topic, "/telemetry"):
				var tel gaugev1.Telemetry
				if proto.Unmarshal(payload, &tel) == nil {
					rec.telem = append(rec.telem, &tel)
					rec.topics[topic] = true
				}
			case strings.HasSuffix(topic, "/status") && len(payload) > 0:
				var st gaugev1.Status
				if proto.Unmarshal(payload, &st) == nil {
					rec.statuses = append(rec.statuses, &st)
					rec.retained[topic] = true
				}
			}
			return true, nil
		}},
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := client.Connect(ctx, &paho.Connect{ClientID: "itest-sub-" + plant, KeepAlive: 30, CleanStart: true}); err != nil {
		t.Fatalf("subscriber connect: %v", err)
	}
	if _, err := client.Subscribe(ctx, &paho.Subscribe{
		Subscriptions: []paho.SubscribeOptions{{Topic: "denso/" + plant + "/#", QoS: 1}},
	}); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	t.Cleanup(func() {
		// Remove the retained status messages this test left on the broker.
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		rec.mu.Lock()
		topics := rec.retained
		rec.mu.Unlock()
		for topic := range topics {
			_, _ = client.Publish(ctx, &paho.Publish{Topic: topic, QoS: 1, Retain: true})
		}
		_ = client.Disconnect(&paho.Disconnect{})
	})
	return rec, client
}

func runAgainstBroker(t *testing.T, cfg Config) (Summary, []Record, *received) {
	t.Helper()
	broker := os.Getenv("EDGE_SIM_TEST_BROKER")
	if broker == "" {
		t.Skip("EDGE_SIM_TEST_BROKER is not set")
	}
	cfg.Plant = fmt.Sprintf("IT%d", time.Now().UnixNano())
	rec, _ := subscribe(t, broker, cfg.Plant)

	var logBuf bytes.Buffer
	seqlog := NewSeqLog(&logBuf)
	transport := MQTTTransport{Broker: broker, KeepAlive: 30, Timeout: cfg.PublishTimeout}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	summary, err := Run(context.Background(), cfg, transport, seqlog, NewMetrics(prometheus.NewRegistry()), logger)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	time.Sleep(time.Second) // let the subscriber receive the tail

	var records []Record
	for _, line := range strings.Split(strings.TrimSpace(logBuf.String()), "\n") {
		var r Record
		if err := json.Unmarshal([]byte(line), &r); err != nil {
			t.Fatalf("bad seq log line: %v", err)
		}
		records = append(records, r)
	}
	return summary, records, rec
}

// Every acknowledged (edge, seq) of the sequence log must have reached a subscriber.
func assertNothingLost(t *testing.T, records []Record, rec *received, edges int) {
	t.Helper()
	rec.mu.Lock()
	defer rec.mu.Unlock()
	got := map[string]bool{}
	for _, tel := range rec.telem {
		got[fmt.Sprintf("%s/%d", tel.GetEdgeId(), tel.GetSeq())] = true
	}
	acked := 0
	for _, r := range records {
		if !r.Acked {
			t.Errorf("unacked record: %+v", r)
			continue
		}
		acked++
		if !got[fmt.Sprintf("%s/%d", r.EdgeID, r.Seq)] {
			t.Errorf("acked but never received: %s seq %d", r.EdgeID, r.Seq)
		}
	}
	if acked == 0 {
		t.Fatal("nothing was acknowledged")
	}
	assertContiguous(t, rec.telem, edges)
}

func TestIntegrationDisconnectsLoseNothing(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Machines = 20
	cfg.Window = 200 * time.Millisecond
	cfg.Duration = 12 * time.Second
	cfg.Ramp = time.Second
	cfg.Faults = FaultSet{FaultDisconnect: true}
	cfg.DisconnectEvery, cfg.DisconnectFor = 4*time.Second, 2*time.Second
	cfg.BackoffMin, cfg.BackoffMax = 200*time.Millisecond, time.Second
	summary, records, rec := runAgainstBroker(t, cfg)

	if summary.Unacked != 0 || summary.Dropped != 0 {
		t.Fatalf("messages lost: %+v", summary)
	}
	if summary.Reconnects == 0 || summary.Replayed == 0 {
		t.Fatalf("no cut or no replay happened: %+v", summary)
	}
	assertNothingLost(t, records, rec, 20)

	rec.mu.Lock()
	defer rec.mu.Unlock()
	replayed, offline := 0, 0
	for _, tel := range rec.telem {
		if tel.GetReplayed() {
			replayed++
		}
	}
	for _, st := range rec.statuses {
		if st.GetState() == gaugev1.State_STATE_OFFLINE {
			offline++
		}
	}
	if replayed == 0 {
		t.Error("subscriber saw no replayed message")
	}
	// The broker publishes the last will on every cut, plus one clean
	// STATE_OFFLINE per edge at shutdown.
	if int64(offline) < summary.Reconnects+20 {
		t.Errorf("%d offline statuses for %d cuts and 20 shutdowns", offline, summary.Reconnects)
	}
}

func TestIntegrationSeveralMachinesPerEdge(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Machines, cfg.MachinesPerEdge = 20, 4
	cfg.Window = 200 * time.Millisecond
	cfg.Duration = 5 * time.Second
	cfg.Ramp = 500 * time.Millisecond
	summary, records, rec := runAgainstBroker(t, cfg)

	if summary.Unacked != 0 || summary.PublishErrors != 0 {
		t.Fatalf("unexpected errors: %+v", summary)
	}
	assertNothingLost(t, records, rec, 5)

	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.topics) != 20 {
		t.Errorf("telemetry on %d topics, want 20", len(rec.topics))
	}
	if len(rec.retained) != 5 {
		t.Errorf("status on %d topics, want one per edge (5)", len(rec.retained))
	}
	for _, st := range rec.statuses {
		if len(st.GetMachineIds()) != 4 {
			t.Errorf("status of %s lists %d machines", st.GetEdgeId(), len(st.GetMachineIds()))
		}
	}
}
