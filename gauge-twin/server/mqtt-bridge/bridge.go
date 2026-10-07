package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/eclipse/paho.golang/paho"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/twmb/franz-go/pkg/kgo"
	"google.golang.org/protobuf/proto"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"

	"gauge-twin/server/pkg/topics"
)

// Config of one bridge replica.
type Config struct {
	// TraceSeq logs edge_id and seq of every telemetry message per stage.
	TraceSeq bool
	Broker   string // MQTT host:port
	// ClientID must be stable for a replica (e.g. the StatefulSet ordinal):
	// the broker keeps a session per client ID and a restarted replica picks
	// its queued messages up again.
	ClientID       string
	ShareGroup     string
	TopicPrefix    string
	SessionExpiry  time.Duration
	ReceiveMaximum uint16 // unacknowledged messages the broker may have in flight to us
	KeepAlive      uint16 // seconds
	ConnectTimeout time.Duration
	BackoffMin     time.Duration
	BackoffMax     time.Duration
	// DrainTimeout bounds the wait for Kafka confirmations on shutdown.
	DrainTimeout time.Duration

	KafkaTelemetry string
	KafkaStatus    string
}

// Producer is the part of kgo.Client the bridge uses.
type Producer interface {
	Produce(ctx context.Context, r *kgo.Record, promise func(*kgo.Record, error))
}

// acker acknowledges an MQTT message; *paho.Client implements it.
type acker interface {
	Ack(pb *paho.Publish) error
}

// Metrics of the bridge.
type Metrics struct {
	Received        *prometheus.CounterVec
	Produced        *prometheus.CounterVec
	ProduceErrors   prometheus.Counter
	Invalid         prometheus.Counter
	AckErrors       prometheus.Counter
	ProduceDuration prometheus.Histogram
	Connected       prometheus.Gauge
	Reconnects      prometheus.Counter
	InFlight        prometheus.Gauge
	// Stages counts a message at every step through the bridge, so a loss
	// can be located: before the bridge, inside it, or after it.
	Stages *prometheus.CounterVec
}

// Stages of a message in the bridge.
const (
	stageReceived = "received" // delivered by the MQTT broker (redeliveries included)
	stageProduced = "produced" // confirmed by Kafka
	stageAcked    = "acked"    // acknowledged to the MQTT broker
)

func NewMetrics(reg prometheus.Registerer) *Metrics {
	m := &Metrics{
		Received: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "bridge_mqtt_messages_received_total",
			Help: "MQTT messages received, by kind (telemetry or status).",
		}, []string{"kind"}),
		Produced: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "bridge_kafka_messages_produced_total",
			Help: "Messages acknowledged by Kafka, by topic.",
		}, []string{"topic"}),
		ProduceErrors: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "bridge_kafka_produce_errors_total",
			Help: "Messages Kafka did not accept; they are not acknowledged to MQTT and get redelivered.",
		}),
		Invalid: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "bridge_mqtt_messages_invalid_total",
			Help: "MQTT messages on a topic the bridge cannot route; acknowledged and dropped.",
		}),
		AckErrors: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "bridge_mqtt_ack_errors_total",
			Help: "Acknowledgements that could not be sent (connection gone); the broker redelivers.",
		}),
		ProduceDuration: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "bridge_kafka_produce_duration_seconds",
			Help:    "Time from receiving an MQTT message to the Kafka acknowledgement.",
			Buckets: prometheus.ExponentialBuckets(0.001, 2, 14),
		}),
		Connected: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "bridge_mqtt_connected",
			Help: "1 while this replica is subscribed to the shared subscription, else 0.",
		}),
		Reconnects: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "bridge_mqtt_reconnects_total",
			Help: "MQTT connections established after the first one.",
		}),
		InFlight: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "bridge_inflight_messages",
			Help: "Messages received from MQTT and not yet acknowledged by Kafka.",
		}),
		Stages: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "bridge_messages_total",
			Help: "Messages by stage (received from MQTT, produced to Kafka, acked to MQTT) and kind.",
		}, []string{"stage", "kind"}),
	}
	reg.MustRegister(m.Received, m.Produced, m.ProduceErrors, m.Invalid, m.AckErrors,
		m.ProduceDuration, m.Connected, m.Reconnects, m.InFlight, m.Stages)
	return m
}

// Bridge forwards MQTT telemetry and status messages to Kafka. An MQTT
// message is acknowledged only after Kafka has acknowledged the record, so a
// crash at any point leads to a redelivery, never to a loss.
type Bridge struct {
	cfg      Config
	producer Producer
	metrics  *Metrics
	logger   *slog.Logger

	connected atomic.Bool
	inFlight  sync.WaitGroup

	mu   sync.Mutex
	conn net.Conn // current MQTT connection, for tests that simulate a crash
}

func NewBridge(cfg Config, producer Producer, metrics *Metrics, logger *slog.Logger) *Bridge {
	return &Bridge{cfg: cfg, producer: producer, metrics: metrics, logger: logger.With("client_id", cfg.ClientID)}
}

// Healthy reports whether the replica is currently subscribed.
func (b *Bridge) Healthy() error {
	if !b.connected.Load() {
		return errors.New("mqtt: not connected")
	}
	return nil
}

// Run keeps the bridge connected until ctx is cancelled.
func (b *Bridge) Run(ctx context.Context) error {
	rng := rand.New(rand.NewSource(time.Now().UnixNano()))
	delay := b.cfg.BackoffMin
	first := true
	for {
		started := time.Now()
		err := b.session(ctx, &first)
		if ctx.Err() != nil {
			return nil
		}
		// A session that lasted a while was healthy: start the backoff over.
		if time.Since(started) > b.cfg.BackoffMax {
			delay = b.cfg.BackoffMin
		}
		wait := time.Duration(float64(delay) * (0.5 + rng.Float64()))
		b.logger.Warn("mqtt session ended", "error", err, "retry_in", wait.String())
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(wait):
		}
		delay = min(delay*2, b.cfg.BackoffMax)
	}
}

// session runs one MQTT connection: connect, subscribe, serve until the
// connection drops or ctx is cancelled.
func (b *Bridge) session(ctx context.Context, first *bool) error {
	connectCtx, cancel := context.WithTimeout(ctx, b.cfg.ConnectTimeout)
	defer cancel()

	var dialer net.Dialer
	conn, err := dialer.DialContext(connectCtx, "tcp", b.cfg.Broker)
	if err != nil {
		return fmt.Errorf("dial %s: %w", b.cfg.Broker, err)
	}
	defer conn.Close()

	clientErr := make(chan error, 1)
	report := func(err error) {
		select {
		case clientErr <- err:
		default:
		}
	}
	var client *paho.Client
	client = paho.NewClient(paho.ClientConfig{
		ClientID: b.cfg.ClientID,
		Conn:     conn,
		// Acknowledge by hand, once Kafka has the record. paho sends the
		// acknowledgements in the order the messages were received.
		EnableManualAcknowledgment: true,
		SendAcksInterval:           5 * time.Millisecond,
		OnPublishReceived: []func(paho.PublishReceived) (bool, error){
			func(pr paho.PublishReceived) (bool, error) {
				b.forward(client, pr.Packet)
				return true, nil
			},
		},
		OnClientError: report,
		OnServerDisconnect: func(d *paho.Disconnect) {
			report(fmt.Errorf("server disconnected: reason code 0x%02x", d.ReasonCode))
		},
	})

	expiry := uint32(b.cfg.SessionExpiry.Seconds())
	receiveMax := b.cfg.ReceiveMaximum
	ack, err := client.Connect(connectCtx, &paho.Connect{
		ClientID:  b.cfg.ClientID,
		KeepAlive: b.cfg.KeepAlive,
		// SessionExpiry > 0 asks for a persistent session: the broker keeps
		// queueing for this client ID while the replica is away. With 0 the
		// session ends with the connection.
		CleanStart: b.cfg.SessionExpiry == 0,
		Properties: &paho.ConnectProperties{SessionExpiryInterval: &expiry, ReceiveMaximum: &receiveMax},
	})
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	if ack.ReasonCode != 0 {
		return fmt.Errorf("connect refused: reason code 0x%02x", ack.ReasonCode)
	}

	subscriptions := []paho.SubscribeOptions{
		{Topic: topics.SharedFilter(b.cfg.ShareGroup, b.cfg.TopicPrefix, topics.KindTelemetry), QoS: 1},
		{Topic: topics.SharedFilter(b.cfg.ShareGroup, b.cfg.TopicPrefix, topics.KindStatus), QoS: 1},
	}
	if _, err := client.Subscribe(connectCtx, &paho.Subscribe{Subscriptions: subscriptions}); err != nil {
		return fmt.Errorf("subscribe: %w", err)
	}

	b.mu.Lock()
	b.conn = conn
	b.mu.Unlock()
	b.connected.Store(true)
	b.metrics.Connected.Set(1)
	if !*first {
		b.metrics.Reconnects.Inc()
	}
	*first = false
	b.logger.Info("mqtt subscribed", "broker", b.cfg.Broker, "session_present", ack.SessionPresent)
	defer func() {
		b.connected.Store(false)
		b.metrics.Connected.Set(0)
	}()

	select {
	case <-client.Done():
		select {
		case err := <-clientErr:
			return err
		default:
			return errors.New("connection closed")
		}
	case err := <-clientErr:
		return err
	case <-ctx.Done():
		// Graceful stop: let Kafka confirm what was already received and give
		// paho a moment to send those acknowledgements, then disconnect.
		// The session stays on the broker, so nothing queued is lost.
		drained := make(chan struct{})
		go func() {
			b.inFlight.Wait()
			close(drained)
		}()
		select {
		case <-drained:
			time.Sleep(50 * time.Millisecond)
		case <-time.After(b.cfg.DrainTimeout):
			b.logger.Warn("shutdown: Kafka did not confirm in time; unacknowledged messages will be redelivered")
		}
		_ = client.Disconnect(&paho.Disconnect{ReasonCode: 0})
		return nil
	}
}

// forward hands one MQTT message to Kafka and acknowledges it to the broker
// only when Kafka has confirmed the record.
func (b *Bridge) forward(client acker, pb *paho.Publish) {
	parsed, ok := topics.Parse(b.cfg.TopicPrefix, pb.Topic)
	var kafkaTopic string
	switch {
	case ok && parsed.Kind == topics.KindTelemetry:
		kafkaTopic = b.cfg.KafkaTelemetry
	case ok && parsed.Kind == topics.KindStatus:
		kafkaTopic = b.cfg.KafkaStatus
	default:
		// Cannot happen with our subscriptions; acknowledge so it is not
		// redelivered forever.
		b.metrics.Invalid.Inc()
		b.logger.Warn("unroutable mqtt topic", "topic", pb.Topic)
		b.ack(client, pb)
		return
	}
	b.metrics.Received.WithLabelValues(parsed.Kind).Inc()
	b.metrics.Stages.WithLabelValues(stageReceived, parsed.Kind).Inc()
	b.trace(stageReceived, parsed.Kind, pb)
	b.metrics.InFlight.Inc()
	b.inFlight.Add(1)

	received := time.Now()
	record := &kgo.Record{
		Topic:     kafkaTopic,
		Key:       []byte(parsed.Machine),
		Value:     pb.Payload,
		Timestamp: received, // the bridge receive time; "state" uses it as the offline moment
		Headers:   []kgo.RecordHeader{{Key: "mqtt_topic", Value: []byte(pb.Topic)}},
	}
	b.producer.Produce(context.Background(), record, func(_ *kgo.Record, err error) {
		defer b.inFlight.Done()
		b.metrics.InFlight.Dec()
		if err != nil {
			// Not acknowledged: the broker redelivers it after a reconnect.
			b.metrics.ProduceErrors.Inc()
			b.logger.Error("kafka produce failed", "error", err, "topic", kafkaTopic, "machine_id", parsed.Machine)
			return
		}
		b.metrics.Produced.WithLabelValues(kafkaTopic).Inc()
		b.metrics.ProduceDuration.Observe(time.Since(received).Seconds())
		b.metrics.Stages.WithLabelValues(stageProduced, parsed.Kind).Inc()
		b.trace(stageProduced, parsed.Kind, pb)
		if b.ack(client, pb) {
			b.metrics.Stages.WithLabelValues(stageAcked, parsed.Kind).Inc()
		}
	})
}

func (b *Bridge) ack(client acker, pb *paho.Publish) bool {
	if err := client.Ack(pb); err != nil {
		b.metrics.AckErrors.Inc()
		return false
	}
	return true
}

// trace logs edge_id and seq of a telemetry message at a stage. It is a
// diagnostic for locating lost messages (TRACE_SEQ=true) and decodes every
// payload, so it stays off in normal operation.
func (b *Bridge) trace(stage, kind string, pb *paho.Publish) {
	if !b.cfg.TraceSeq || kind != topics.KindTelemetry {
		return
	}
	var tel gaugev1.Telemetry
	if err := proto.Unmarshal(pb.Payload, &tel); err != nil {
		return
	}
	b.logger.Info("trace", "stage", stage, "edge_id", tel.GetEdgeId(), "seq", tel.GetSeq(), "dup", pb.Duplicate)
}
