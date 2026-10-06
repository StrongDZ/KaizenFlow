package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"

	"github.com/eclipse/paho.golang/paho"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/twmb/franz-go/pkg/kgo"
)

// fakeProducer keeps the promises so a test decides when and how Kafka answers.
type fakeProducer struct {
	mu       sync.Mutex
	records  []*kgo.Record
	promises []func(*kgo.Record, error)
}

func (p *fakeProducer) Produce(_ context.Context, r *kgo.Record, promise func(*kgo.Record, error)) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.records = append(p.records, r)
	p.promises = append(p.promises, promise)
}

func (p *fakeProducer) resolve(i int, err error) { p.promises[i](p.records[i], err) }

type fakeAcker struct {
	acked []*paho.Publish
	err   error
}

func (a *fakeAcker) Ack(pb *paho.Publish) error {
	if a.err != nil {
		return a.err
	}
	a.acked = append(a.acked, pb)
	return nil
}

func newTestBridge() (*Bridge, *fakeProducer, *Metrics) {
	cfg := Config{ClientID: "bridge-test", TopicPrefix: "denso", KafkaTelemetry: "gauge.telemetry", KafkaStatus: "gauge.status"}
	producer := &fakeProducer{}
	metrics := NewMetrics(prometheus.NewRegistry())
	return NewBridge(cfg, producer, metrics, slog.New(slog.NewTextHandler(io.Discard, nil))), producer, metrics
}

func TestMQTTAckOnlyAfterKafkaAck(t *testing.T) {
	bridge, producer, metrics := newTestBridge()
	acker := &fakeAcker{}
	msg := &paho.Publish{Topic: "denso/DENSO_HN/L03/PRESS_01/telemetry", Payload: []byte("payload"), QoS: 1}

	bridge.forward(acker, msg)

	if len(producer.records) != 1 {
		t.Fatalf("produced %d records", len(producer.records))
	}
	if len(acker.acked) != 0 {
		t.Fatal("MQTT message acknowledged before Kafka confirmed it")
	}
	record := producer.records[0]
	if record.Topic != "gauge.telemetry" || string(record.Key) != "PRESS_01" || string(record.Value) != "payload" {
		t.Errorf("record: topic=%s key=%s value=%s", record.Topic, record.Key, record.Value)
	}
	if len(record.Headers) != 1 || record.Headers[0].Key != "mqtt_topic" || string(record.Headers[0].Value) != msg.Topic {
		t.Errorf("headers: %+v", record.Headers)
	}
	if record.Timestamp.IsZero() {
		t.Error("record timestamp (bridge receive time) not set")
	}
	if got := testutil.ToFloat64(metrics.InFlight); got != 1 {
		t.Errorf("in-flight gauge: %v", got)
	}

	producer.resolve(0, nil)

	if len(acker.acked) != 1 || acker.acked[0] != msg {
		t.Fatalf("acked: %v", acker.acked)
	}
	for _, stage := range []string{stageReceived, stageProduced, stageAcked} {
		if testutil.ToFloat64(metrics.Stages.WithLabelValues(stage, "telemetry")) != 1 {
			t.Errorf("stage %s not counted once", stage)
		}
	}
	if testutil.ToFloat64(metrics.InFlight) != 0 || testutil.ToFloat64(metrics.Produced.WithLabelValues("gauge.telemetry")) != 1 {
		t.Error("metrics not updated after the Kafka ack")
	}
}

func TestNoMQTTAckWhenKafkaFails(t *testing.T) {
	bridge, producer, metrics := newTestBridge()
	acker := &fakeAcker{}

	bridge.forward(acker, &paho.Publish{Topic: "denso/P/L/M1/telemetry", QoS: 1})
	producer.resolve(0, errors.New("kafka unavailable"))

	if len(acker.acked) != 0 {
		t.Fatal("message acknowledged although Kafka rejected it; it would be lost")
	}
	if testutil.ToFloat64(metrics.ProduceErrors) != 1 || testutil.ToFloat64(metrics.InFlight) != 0 {
		t.Error("error metrics not updated")
	}
}

func TestStatusGoesToStatusTopicKeyedByMachine(t *testing.T) {
	bridge, producer, _ := newTestBridge()

	bridge.forward(&fakeAcker{}, &paho.Publish{Topic: "denso/P/L/M7/status", QoS: 1})

	if producer.records[0].Topic != "gauge.status" || string(producer.records[0].Key) != "M7" {
		t.Errorf("record: %+v", producer.records[0])
	}
}

func TestAcksFollowKafkaAcksIndependentlyPerMessage(t *testing.T) {
	bridge, producer, _ := newTestBridge()
	acker := &fakeAcker{}
	first := &paho.Publish{Topic: "denso/P/L/M1/telemetry", PacketID: 1}
	second := &paho.Publish{Topic: "denso/P/L/M2/telemetry", PacketID: 2}
	bridge.forward(acker, first)
	bridge.forward(acker, second)

	// Kafka may confirm out of order (different partitions); paho re-orders
	// the acknowledgements on the wire, the bridge just reports each one.
	producer.resolve(1, nil)
	if len(acker.acked) != 1 || acker.acked[0] != second {
		t.Fatalf("after second: %v", acker.acked)
	}
	producer.resolve(0, nil)
	if len(acker.acked) != 2 {
		t.Fatalf("after both: %v", acker.acked)
	}
}

func TestUnroutableTopicIsAcknowledgedAndCounted(t *testing.T) {
	bridge, producer, metrics := newTestBridge()
	acker := &fakeAcker{}

	bridge.forward(acker, &paho.Publish{Topic: "denso/P/L/M1/config"})
	bridge.forward(acker, &paho.Publish{Topic: "something/else"})

	if len(producer.records) != 0 || len(acker.acked) != 2 || testutil.ToFloat64(metrics.Invalid) != 2 {
		t.Errorf("produced=%d acked=%d invalid=%v", len(producer.records), len(acker.acked), testutil.ToFloat64(metrics.Invalid))
	}
}

func TestAckFailureIsCounted(t *testing.T) {
	bridge, producer, metrics := newTestBridge()

	bridge.forward(&fakeAcker{err: errors.New("connection gone")}, &paho.Publish{Topic: "denso/P/L/M1/telemetry"})
	producer.resolve(0, nil)

	if testutil.ToFloat64(metrics.AckErrors) != 1 {
		t.Error("ack error not counted")
	}
}

func TestHealthFollowsConnection(t *testing.T) {
	bridge, _, _ := newTestBridge()
	if bridge.Healthy() == nil {
		t.Error("healthy before connecting")
	}
	bridge.connected.Store(true)
	if err := bridge.Healthy(); err != nil {
		t.Errorf("unhealthy while connected: %v", err)
	}
}
