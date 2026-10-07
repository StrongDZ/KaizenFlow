// Command ingest reads telemetry from Kafka, validates it and writes it to
// TimescaleDB and Redis. Offsets are committed only after the database write
// succeeded, and the write is idempotent: no loss and no duplicates.
package main

import (
	"context"
	"errors"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"

	"gauge-twin/server/pkg/env"
	"gauge-twin/server/pkg/httpserver"
	"gauge-twin/server/pkg/logging"
	"gauge-twin/server/pkg/topics"
)

func main() {
	os.Exit(run())
}

func run() int {
	logger := logging.New("ingest")
	batchSize, err1 := env.Int("BATCH_SIZE", 1000)
	batchWait, err2 := env.Duration("BATCH_WAIT", 200*time.Millisecond)
	refresh, err3 := env.Duration("CONFIG_REFRESH", 30*time.Second)
	lagEvery, err4 := env.Duration("LAG_INTERVAL", 10*time.Second)
	if err := errors.Join(err1, err2, err3, err4); err != nil {
		logger.Error("invalid configuration", "error", err)
		return 2
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// No default: the database credentials come from the environment only.
	databaseURL := env.String("DATABASE_URL", "")
	if databaseURL == "" {
		logger.Error("invalid configuration", "error", "DATABASE_URL is required")
		return 2
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		logger.Error("database", "error", err)
		return 1
	}
	defer pool.Close()
	redisClient := redis.NewClient(&redis.Options{Addr: env.String("REDIS_ADDR", "redis:6379")})
	defer redisClient.Close()

	telemetryTopic := env.String("KAFKA_TOPIC_TELEMETRY", topics.KafkaTelemetry)
	client, err := kgo.NewClient(
		kgo.SeedBrokers(env.Strings("KAFKA_BROKERS", []string{"redpanda:9092"})...),
		kgo.ConsumerGroup(env.String("KAFKA_GROUP", "ingest")),
		kgo.ConsumeTopics(telemetryTopic),
		// Offsets are committed by hand, after the database write.
		kgo.DisableAutoCommit(),
		// A rebalance waits until the batch in hand is stored and committed,
		// so a partition never moves to another replica mid-batch.
		kgo.BlockRebalanceOnPoll(),
		kgo.FetchMaxWait(batchWait),
		kgo.RequiredAcks(kgo.AllISRAcks()),
	)
	if err != nil {
		logger.Error("kafka client", "error", err)
		return 1
	}
	defer client.Close()

	registry := httpserver.NewRegistry()
	metrics := NewMetrics(registry)
	configs := NewConfigCache(env.String("CONFIG_API_URL", "http://config-api:8080"))
	processor := NewProcessor(configs, &PgReadings{pool}, &RedisState{redisClient}, &KafkaForwarder{client}, metrics, logger)
	processor.rejectedTopic = env.String("KAFKA_TOPIC_REJECTED", topics.KafkaRejected)
	processor.dlqTopic = env.String("KAFKA_TOPIC_DLQ", topics.KafkaDLQ)

	var configLoaded atomic.Bool
	health := func() error {
		switch {
		case !configLoaded.Load():
			return errors.New("waiting for the first config load from config-api")
		case processor.Degraded():
			return errors.New("degraded: retrying after an infrastructure error")
		}
		return nil
	}
	httpDone := make(chan error, 1)
	go func() {
		httpDone <- httpserver.Serve(ctx, env.String("HTTP_ADDR", ":8080"), httpserver.Handler(registry, health), logger)
	}()

	// Without configs every reading would be flagged FLAG_NO_CONFIG, so
	// nothing is consumed before the first successful load.
	for ctx.Err() == nil {
		if err := configs.Refresh(ctx); err == nil {
			configLoaded.Store(true)
			break
		} else {
			logger.Warn("config-api not reachable yet", "error", err)
		}
		select {
		case <-ctx.Done():
		case <-time.After(2 * time.Second):
		}
	}
	go func() {
		ticker := time.NewTicker(refresh)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := configs.Refresh(ctx); err != nil && ctx.Err() == nil {
					logger.Warn("config refresh failed; keeping the cached configs", "error", err)
				}
			}
		}
	}()

	// The lag is read from the broker on its own schedule: a metric updated
	// by the consume loop would freeze exactly when the loop is stuck.
	go func() {
		admin := kadm.NewClient(client)
		ticker := time.NewTicker(lagEvery)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := reportLag(ctx, admin, client.CommittedOffsets(), telemetryTopic, metrics.Lag); err != nil && ctx.Err() == nil {
					logger.Warn("reading the partition end offsets failed", "error", err)
				}
			}
		}
	}()

	logger.Info("consuming", "topic", telemetryTopic, "batch_size", batchSize)
	for ctx.Err() == nil {
		fetches := client.PollRecords(ctx, batchSize)
		if ctx.Err() != nil {
			break
		}
		fetches.EachError(func(topic string, partition int32, err error) {
			logger.Warn("fetch error", "topic", topic, "partition", partition, "error", err)
		})
		records := fetches.Records()
		if len(records) > 0 {
			if err := processor.Process(ctx, records); err != nil {
				break // cancelled: the batch is not committed and will be read again
			}
			if err := client.CommitRecords(ctx, records...); err != nil && ctx.Err() == nil {
				// Not fatal: the batch is simply processed again, idempotently.
				logger.Warn("offset commit failed", "error", err)
			}
		}
		client.AllowRebalance()
	}

	client.AllowRebalance()
	if err := <-httpDone; err != nil {
		logger.Error("http server", "error", err)
		return 1
	}
	logger.Info("stopped")
	return 0
}
