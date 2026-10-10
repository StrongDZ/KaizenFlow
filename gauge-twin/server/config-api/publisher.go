package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"sync"
	"time"

	"github.com/eclipse/paho.golang/paho"
	"github.com/prometheus/client_golang/prometheus"
)

// Broker publishes retained MQTT messages.
type Broker interface {
	// PublishRetained returns once the broker acknowledged the message. An
	// empty payload clears the retained message of the topic.
	PublishRetained(ctx context.Context, topic string, payload []byte) error
}

// mqttBroker connects on demand and reconnects after a failure.
type mqttBroker struct {
	address  string
	clientID string
	timeout  time.Duration

	mu     sync.Mutex
	client *paho.Client
	conn   net.Conn
}

func newMQTTBroker(address, clientID string) *mqttBroker {
	return &mqttBroker{address: address, clientID: clientID, timeout: 10 * time.Second}
}

func (b *mqttBroker) connect(ctx context.Context) error {
	var dialer net.Dialer
	conn, err := dialer.DialContext(ctx, "tcp", b.address)
	if err != nil {
		return fmt.Errorf("dial %s: %w", b.address, err)
	}
	client := paho.NewClient(paho.ClientConfig{ClientID: b.clientID, Conn: conn, PacketTimeout: b.timeout})
	ack, err := client.Connect(ctx, &paho.Connect{ClientID: b.clientID, KeepAlive: 30, CleanStart: true})
	if err != nil {
		_ = conn.Close()
		return fmt.Errorf("connect: %w", err)
	}
	if ack.ReasonCode != 0 {
		_ = conn.Close()
		return fmt.Errorf("connect refused: reason code 0x%02x", ack.ReasonCode)
	}
	b.client, b.conn = client, conn
	return nil
}

func (b *mqttBroker) PublishRetained(ctx context.Context, topic string, payload []byte) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, b.timeout)
	defer cancel()
	if b.client == nil {
		if err := b.connect(ctx); err != nil {
			return err
		}
	}
	resp, err := b.client.Publish(ctx, &paho.Publish{Topic: topic, Payload: payload, QoS: 1, Retain: true})
	// 0x10 (no matching subscribers) still means the retained message is stored.
	if resp != nil && (resp.ReasonCode == 0 || resp.ReasonCode == 0x10) {
		return nil
	}
	// Drop the connection; the next publish reconnects.
	_ = b.conn.Close()
	b.client = nil
	if err == nil {
		err = errors.New("publish not acknowledged")
	}
	return err
}

func (b *mqttBroker) Connected() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.client != nil
}

// Publisher keeps MQTT in line with the database: every config whose current
// version is not confirmed as published gets published (retained) and marked.
// Because it works from the database, a failed publish is simply retried and
// several replicas can run it concurrently.
type Publisher struct {
	store    Store
	broker   Broker
	prefix   string
	logger   *slog.Logger
	wake     chan struct{}
	interval time.Duration
	// RepublishEvery is how often every config is published again, published
	// or not: the broker may have lost its retained messages (restarted
	// without its data, or cleared by hand) while the database says all is
	// published. The edge ignores a version it already runs. 0 disables it.
	RepublishEvery time.Duration
	lastRepublish  time.Time
	// AlsoRepublish runs with every republish (the edge assignments).
	AlsoRepublish func(ctx context.Context)

	published   prometheus.Counter
	failures    prometheus.Counter
	unpublished prometheus.Gauge
}

func NewPublisher(store Store, broker Broker, prefix string, interval time.Duration, reg prometheus.Registerer, logger *slog.Logger) *Publisher {
	p := &Publisher{
		store: store, broker: broker, prefix: prefix, logger: logger, interval: interval,
		wake:           make(chan struct{}, 1),
		RepublishEvery: 10 * time.Minute,
		published: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "config_api_published_total", Help: "Station configs published to MQTT."}),
		failures: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "config_api_publish_failures_total", Help: "Failed attempts to publish a station config."}),
		unpublished: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "config_api_unpublished_configs", Help: "Station configs whose current version is not on MQTT yet."}),
	}
	reg.MustRegister(p.published, p.failures, p.unpublished)
	return p
}

// Wake asks for a publish pass now instead of at the next interval.
func (p *Publisher) Wake() {
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

// Run publishes pending configs until ctx is cancelled.
func (p *Publisher) Run(ctx context.Context) {
	ticker := time.NewTicker(p.interval)
	defer ticker.Stop()
	for {
		p.Sync(ctx)
		if p.RepublishEvery > 0 && time.Since(p.lastRepublish) >= p.RepublishEvery {
			p.Republish(ctx)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-p.wake:
		}
	}
}

// Sync publishes every pending config once.
func (p *Publisher) Sync(ctx context.Context) {
	pending, err := p.store.Unpublished(ctx)
	if err != nil {
		if ctx.Err() == nil {
			p.logger.Error("list unpublished configs", "error", err)
		}
		return
	}
	remaining := len(pending)
	for _, s := range pending {
		topic, err := configTopic(p.prefix, s.Config)
		if err == nil {
			err = p.broker.PublishRetained(ctx, topic, s.Config)
		}
		if err == nil {
			err = p.store.MarkPublished(ctx, s.MachineID, s.ConfigVersion)
		}
		if err != nil {
			p.failures.Inc()
			p.logger.Warn("config publish failed; will retry", "machine_id", s.MachineID, "config_version", s.ConfigVersion, "error", err)
			continue
		}
		remaining--
		p.published.Inc()
		p.logger.Info("config published", "machine_id", s.MachineID, "config_version", s.ConfigVersion, "topic", topic)
	}
	p.unpublished.Set(float64(remaining))
}

// Republish publishes every stored config again, retained.
func (p *Publisher) Republish(ctx context.Context) {
	stations, err := p.store.List(ctx)
	if err != nil {
		if ctx.Err() == nil {
			p.logger.Error("list configs to republish", "error", err)
		}
		return
	}
	failed := 0
	for _, s := range stations {
		topic, err := configTopic(p.prefix, s.Config)
		if err == nil {
			err = p.broker.PublishRetained(ctx, topic, s.Config)
		}
		if err != nil {
			failed++
			p.failures.Inc()
			continue
		}
		p.published.Inc()
	}
	if p.AlsoRepublish != nil {
		p.AlsoRepublish(ctx)
	}
	// A failed pass is tried again at the next interval, not after RepublishEvery.
	if failed == 0 {
		p.lastRepublish = time.Now()
	}
	p.logger.Info("configs republished", "configs", len(stations), "failed", failed)
}

// configTopic is denso/{plant}/{line}/{machine}/config for a stored config.
func configTopic(prefix string, config []byte) (string, error) {
	cfg, err := ParseConfig(config)
	if err != nil {
		return "", err
	}
	return prefix + "/" + cfg.GetPlant() + "/" + cfg.GetLine() + "/" + cfg.GetMachineId() + "/config", nil
}
