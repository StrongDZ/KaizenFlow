// Command mqtt-bridge forwards MQTT telemetry and status messages to Kafka.
// It replaces an EMQX-to-Kafka rule, which the open-source EMQX 5.8 lacks.
package main

import (
	"context"
	"errors"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"

	"gauge-twin/server/pkg/env"
	"gauge-twin/server/pkg/httpserver"
	"gauge-twin/server/pkg/logging"
	"gauge-twin/server/pkg/topics"
)

func main() {
	os.Exit(run())
}

func loadConfig() (Config, error) {
	hostname, _ := os.Hostname()
	cfg := Config{
		TraceSeq:       env.String("TRACE_SEQ", "false") == "true",
		Broker:         env.String("MQTT_BROKER", "emqx:1883"),
		ClientID:       env.String("MQTT_CLIENT_ID", "mqtt-bridge-"+hostname),
		ShareGroup:     env.String("MQTT_SHARE_GROUP", "bridge"),
		TopicPrefix:    env.String("MQTT_TOPIC_PREFIX", topics.DefaultPrefix),
		KeepAlive:      30,
		ConnectTimeout: 10 * time.Second,
		BackoffMin:     time.Second,
		BackoffMax:     30 * time.Second,
		DrainTimeout:   10 * time.Second,
		KafkaTelemetry: env.String("KAFKA_TOPIC_TELEMETRY", topics.KafkaTelemetry),
		KafkaStatus:    env.String("KAFKA_TOPIC_STATUS", topics.KafkaStatus),
	}
	var errs []error
	var err error
	if cfg.SessionExpiry, err = env.Duration("MQTT_SESSION_EXPIRY", 2*time.Hour); err != nil {
		errs = append(errs, err)
	}
	receiveMax, err := env.Int("MQTT_RECEIVE_MAXIMUM", 1024)
	if err != nil {
		errs = append(errs, err)
	} else if receiveMax < 1 || receiveMax > 65535 {
		errs = append(errs, errors.New("MQTT_RECEIVE_MAXIMUM must be between 1 and 65535"))
	}
	cfg.ReceiveMaximum = uint16(receiveMax)
	return cfg, errors.Join(errs...)
}

func run() int {
	logger := logging.New("mqtt-bridge")
	cfg, err := loadConfig()
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		return 2
	}

	// acks=all and an idempotent producer are franz-go defaults; they are
	// spelled out because the no-loss guarantee depends on them. Records are
	// retried until Kafka accepts them: when Kafka is down the buffer fills,
	// Produce blocks and MQTT messages stay unacknowledged on the broker.
	producer, err := kgo.NewClient(
		kgo.SeedBrokers(env.Strings("KAFKA_BROKERS", []string{"redpanda:9092"})...),
		kgo.ClientID(cfg.ClientID),
		kgo.RequiredAcks(kgo.AllISRAcks()),
		kgo.ProducerLinger(5*time.Millisecond),
		kgo.MaxBufferedRecords(10000),
		kgo.RecordRetries(1<<31-1),
	)
	if err != nil {
		logger.Error("kafka client", "error", err)
		return 1
	}
	defer producer.Close()

	registry := httpserver.NewRegistry()
	bridge := NewBridge(cfg, producer, NewMetrics(registry), logger)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	httpDone := make(chan error, 1)
	go func() {
		httpDone <- httpserver.Serve(ctx, env.String("HTTP_ADDR", ":8080"), httpserver.Handler(registry, bridge.Healthy), logger)
	}()

	logger.Info("starting", "mqtt_broker", cfg.Broker, "share_group", cfg.ShareGroup, "client_id", cfg.ClientID)
	_ = bridge.Run(ctx)

	flushCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := producer.Flush(flushCtx); err != nil {
		logger.Warn("kafka flush on shutdown", "error", err)
	}
	if err := <-httpDone; err != nil {
		logger.Error("http server", "error", err)
		return 1
	}
	logger.Info("stopped")
	return 0
}
