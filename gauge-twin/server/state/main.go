// Command state watches the edges: it keeps edge_node and Redis up to date
// from the status topic and detects telemetry lost between edge and server
// from the sequence numbers.
package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"
	"github.com/twmb/franz-go/pkg/kgo"
	"google.golang.org/protobuf/proto"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
	"gauge-twin/server/pkg/env"
	"gauge-twin/server/pkg/httpserver"
	"gauge-twin/server/pkg/logging"
	"gauge-twin/server/pkg/topics"
)

// EdgeStore persists what the heartbeats say.
type EdgeStore interface {
	// Upsert stores a status. at is the time the server received it: for a
	// last will, ts_ms inside the message is the connect time, not the
	// moment the edge went offline.
	Upsert(ctx context.Context, st *gaugev1.Status, at time.Time) error
	CountOnline(ctx context.Context, within time.Duration) (int64, error)
}

type pgEdges struct{ pool *pgxpool.Pool }

func (p *pgEdges) Upsert(ctx context.Context, st *gaugev1.Status, at time.Time) error {
	status := stateOffline
	if st.GetState() == gaugev1.State_STATE_ONLINE {
		status = stateOnline
	}
	primary := ""
	if len(st.GetMachineIds()) > 0 {
		primary = st.GetMachineIds()[0]
	}
	// last_seen only moves with online heartbeats; a status older than the
	// stored one (a redelivery) changes nothing.
	_, err := p.pool.Exec(ctx, `
		INSERT INTO edge_node AS e (edge_id, machine_id, machine_ids, sw_version, config_version, status, last_seen, updated_at)
		VALUES ($1, NULLIF($2, ''), $3, $4, $5, $6, CASE WHEN $6 = 'online' THEN $7::timestamptz END, $7)
		ON CONFLICT (edge_id) DO UPDATE SET
		  machine_id = EXCLUDED.machine_id, machine_ids = EXCLUDED.machine_ids, sw_version = EXCLUDED.sw_version,
		  config_version = EXCLUDED.config_version, status = EXCLUDED.status,
		  last_seen = COALESCE(EXCLUDED.last_seen, e.last_seen), updated_at = EXCLUDED.updated_at
		WHERE e.updated_at <= EXCLUDED.updated_at`,
		st.GetEdgeId(), primary, st.GetMachineIds(), st.GetSwVersion(), int32(st.GetConfigVersion()), status, at.UTC())
	return err
}

func (p *pgEdges) CountOnline(ctx context.Context, within time.Duration) (int64, error) {
	var n int64
	err := p.pool.QueryRow(ctx, `SELECT count(*) FROM edge_node WHERE status = 'online' AND last_seen > now() - $1::interval`,
		within.String()).Scan(&n)
	return n, err
}

// Metrics of state (SPEC section 5.3).
type Metrics struct {
	EdgeOnline  prometheus.Gauge
	SeqGap      *prometheus.CounterVec
	SeqLate     *prometheus.CounterVec
	SeqResets   prometheus.Counter
	BufferBytes *prometheus.GaugeVec
	Statuses    *prometheus.CounterVec
	Errors      prometheus.Counter
}

func NewMetrics(reg prometheus.Registerer) *Metrics {
	m := &Metrics{
		EdgeOnline: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "edge_online", Help: "Edges that sent an online heartbeat within the last 120 s."}),
		SeqGap: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "edge_seq_gap_total", Help: "Telemetry sequence numbers counted as lost, by edge."}, []string{"edge_id"}),
		SeqLate: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "edge_seq_late_total", Help: "Sequence numbers that arrived after being counted as lost, by edge."}, []string{"edge_id"}),
		SeqResets: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "state_seq_resets_total", Help: "Edges whose sequence counter restarted from 1."}),
		BufferBytes: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "edge_buffer_bytes", Help: "Offline buffer size reported by the last heartbeat, by edge."}, []string{"edge_id"}),
		Statuses: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "state_status_messages_total", Help: "Status messages processed, by state."}, []string{"state"}),
		Errors: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "state_errors_total", Help: "Records that could not be processed and will be read again."}),
	}
	reg.MustRegister(m.EdgeOnline, m.SeqGap, m.SeqLate, m.SeqResets, m.BufferBytes, m.Statuses, m.Errors)
	return m
}

// Service holds the handlers of both topics.
type Service struct {
	edges   EdgeStore
	tracker *SeqTracker
	metrics *Metrics
	logger  *slog.Logger
	prefix  string
	// resender is nil when resend requests are switched off.
	resender *Resender
}

// HandleStatus processes one record of the status topic. Undecodable records
// are skipped; an infrastructure error is returned so the record is retried.
func (s *Service) HandleStatus(ctx context.Context, record *kgo.Record) error {
	var st gaugev1.Status
	if err := proto.Unmarshal(record.Value, &st); err != nil || st.GetEdgeId() == "" {
		s.logger.Warn("status skipped", "error", err, "offset", record.Offset)
		return nil
	}
	online := st.GetState() == gaugev1.State_STATE_ONLINE
	// The record timestamp is when mqtt-bridge received the message.
	if err := s.edges.Upsert(ctx, &st, record.Timestamp); err != nil {
		return err
	}
	if err := s.tracker.SetEdgeState(ctx, st.GetEdgeId(), online, st.GetBufferMsgs(), record.Timestamp); err != nil {
		return err
	}
	if plant := plantOf(s.prefix, record); plant != "" {
		if err := s.tracker.SetPlant(ctx, st.GetEdgeId(), plant); err != nil {
			return err
		}
	}
	s.metrics.BufferBytes.WithLabelValues(st.GetEdgeId()).Set(float64(st.GetBufferBytes()))
	s.metrics.Statuses.WithLabelValues(st.GetState().String()).Inc()
	return nil
}

// plantOf reads the plant from the MQTT topic mqtt-bridge put in the record headers.
func plantOf(prefix string, record *kgo.Record) string {
	for _, h := range record.Headers {
		if h.Key == "mqtt_topic" {
			if parsed, ok := topics.Parse(prefix, string(h.Value)); ok {
				return parsed.Plant
			}
		}
	}
	return ""
}

// HandleTelemetry records the sequence number of one telemetry record.
func (s *Service) HandleTelemetry(ctx context.Context, record *kgo.Record) error {
	var tel gaugev1.Telemetry
	if err := proto.Unmarshal(record.Value, &tel); err != nil || tel.GetEdgeId() == "" || tel.GetSeq() == 0 {
		return nil // ingest rejects these; they carry no usable sequence number
	}
	obs, err := s.tracker.Observe(ctx, tel.GetEdgeId(), tel.GetSeq(), tel.GetReplayed(), time.Now())
	if err != nil {
		return err
	}
	if obs.Reset {
		s.metrics.SeqResets.Inc()
		s.logger.Info("edge sequence counter restarted", "edge_id", tel.GetEdgeId())
	}
	if obs.Late > 0 {
		s.metrics.SeqLate.WithLabelValues(tel.GetEdgeId()).Add(float64(obs.Late))
	}
	if obs.Overflow > 0 {
		s.metrics.SeqGap.WithLabelValues(tel.GetEdgeId()).Add(float64(obs.Overflow))
		s.logger.Warn("sequence gap larger than the tracking limit", "edge_id", tel.GetEdgeId(), "lost", obs.Overflow)
	}
	return nil
}

// Sweep asks for what is missing, counts overdue gaps as lost and refreshes
// the online gauge.
func (s *Service) Sweep(ctx context.Context) {
	if s.resender != nil {
		s.resender.Run(ctx, time.Now())
	}
	lost, err := s.tracker.Sweep(ctx, time.Now())
	if err != nil {
		s.logger.Warn("gap sweep failed", "error", err)
	}
	for edge, n := range lost {
		s.metrics.SeqGap.WithLabelValues(edge).Add(float64(n))
		s.logger.Warn("telemetry lost between edge and server", "edge_id", edge, "messages", n)
	}
	if n, err := s.edges.CountOnline(ctx, 120*time.Second); err == nil {
		s.metrics.EdgeOnline.Set(float64(n))
	}
}

// consume reads one topic and commits after every batch was handled.
func consume(ctx context.Context, client *kgo.Client, handle func(context.Context, *kgo.Record) error, m *Metrics, logger *slog.Logger) {
	for ctx.Err() == nil {
		fetches := client.PollRecords(ctx, 1000)
		if ctx.Err() != nil {
			return
		}
		records := fetches.Records()
		failed := false
		for _, record := range records {
			if err := handle(ctx, record); err != nil {
				m.Errors.Inc()
				logger.Warn("record failed; the batch will be read again", "topic", record.Topic, "error", err)
				failed = true
				break
			}
		}
		if failed {
			// Nothing is committed; rewind to the committed offsets and retry.
			client.AllowRebalance()
			select {
			case <-ctx.Done():
				return
			case <-time.After(2 * time.Second):
			}
			client.SetOffsets(client.CommittedOffsets())
			continue
		}
		if len(records) > 0 {
			if err := client.CommitRecords(ctx, records...); err != nil && ctx.Err() == nil {
				logger.Warn("offset commit failed", "error", err)
			}
		}
		client.AllowRebalance()
	}
}

func newConsumer(brokers []string, group, topic string) (*kgo.Client, error) {
	return kgo.NewClient(kgo.SeedBrokers(brokers...), kgo.ConsumerGroup(group), kgo.ConsumeTopics(topic),
		kgo.DisableAutoCommit(), kgo.BlockRebalanceOnPoll())
}

func main() {
	os.Exit(run())
}

func run() int {
	logger := logging.New("state")
	grace, err1 := env.Duration("SEQ_GAP_GRACE", 10*time.Minute)
	sweepEvery, err2 := env.Duration("SWEEP_INTERVAL", 30*time.Second)
	resendAfter, err3 := env.Duration("RESEND_AFTER", time.Minute)
	if err := errors.Join(err1, err2, err3); err != nil {
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

	brokers := env.Strings("KAFKA_BROKERS", []string{"redpanda:9092"})
	statusClient, err := newConsumer(brokers, env.String("KAFKA_GROUP_STATUS", "state-status"), env.String("KAFKA_TOPIC_STATUS", topics.KafkaStatus))
	if err != nil {
		logger.Error("kafka client", "error", err)
		return 1
	}
	defer statusClient.Close()
	// A separate group: sequence tracking reads the telemetry independently of ingest.
	seqClient, err := newConsumer(brokers, env.String("KAFKA_GROUP_SEQ", "state-seq"), env.String("KAFKA_TOPIC_TELEMETRY", topics.KafkaTelemetry))
	if err != nil {
		logger.Error("kafka client", "error", err)
		return 1
	}
	defer seqClient.Close()

	registry := httpserver.NewRegistry()
	metrics := NewMetrics(registry)
	prefix := env.String("MQTT_TOPIC_PREFIX", topics.DefaultPrefix)
	service := &Service{edges: &pgEdges{pool}, tracker: &SeqTracker{client: redisClient, grace: grace}, metrics: metrics, logger: logger, prefix: prefix}

	var wg sync.WaitGroup
	if env.String("RESEND_ENABLED", "true") == "true" {
		hostname, _ := os.Hostname()
		resendMetrics := NewResendMetrics(registry)
		link := &MQTTLink{Broker: env.String("MQTT_BROKER", "emqx:1883"), ClientID: env.String("MQTT_CLIENT_ID", "state-"+hostname),
			Prefix: prefix, ShareGroup: env.String("MQTT_SHARE_GROUP", "state"), Metrics: resendMetrics, Logger: logger}
		service.resender = &Resender{tracker: service.tracker, pub: link, prefix: prefix, after: resendAfter,
			metrics: resendMetrics, gaps: metrics.SeqGap, logger: logger}
		link.OnAck = func(payload []byte) { service.resender.HandleAck(ctx, payload) }
		wg.Add(1)
		go func() { defer wg.Done(); link.Run(ctx) }()
	}

	health := func() error {
		pingCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := pool.Ping(pingCtx); err != nil {
			return errors.New("database: " + err.Error())
		}
		if err := redisClient.Ping(pingCtx).Err(); err != nil {
			return errors.New("redis: " + err.Error())
		}
		return nil
	}

	wg.Add(3)
	go func() { defer wg.Done(); consume(ctx, statusClient, service.HandleStatus, metrics, logger) }()
	go func() { defer wg.Done(); consume(ctx, seqClient, service.HandleTelemetry, metrics, logger) }()
	go func() {
		defer wg.Done()
		ticker := time.NewTicker(sweepEvery)
		defer ticker.Stop()
		for {
			service.Sweep(ctx)
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()

	logger.Info("starting")
	err = httpserver.Serve(ctx, env.String("HTTP_ADDR", ":8080"), httpserver.Handler(registry, health), logger)
	wg.Wait()
	if err != nil {
		logger.Error("http server", "error", err)
		return 1
	}
	logger.Info("stopped")
	return 0
}
