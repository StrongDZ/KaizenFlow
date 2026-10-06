package main

import (
	"context"
	"errors"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/twmb/franz-go/pkg/kgo"
	"google.golang.org/protobuf/proto"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
	"gauge-twin/server/pkg/validate"
)

// Rejected is a Kafka record that cannot be stored as readings.
type Rejected struct {
	Record *kgo.Record
	Reason string
	Detail string
	// MachineID, EdgeID and Seq are set when the payload decoded.
	MachineID, EdgeID string
	Seq               int64
}

// GaugeKey identifies a gauge.
type GaugeKey struct{ Machine, Gauge string }

// DataError marks a failure caused by the data of a batch, not by the
// infrastructure: retrying the same batch will fail again.
type DataError struct{ Err error }

func (e DataError) Error() string { return e.Err.Error() }
func (e DataError) Unwrap() error { return e.Err }

// ReadingStore writes rows and rejected records in one transaction. Both
// writes are idempotent, so a batch can be written again after a crash.
type ReadingStore interface {
	Write(ctx context.Context, rows []validate.Row, rejected []Rejected) (inserted int64, err error)
}

// StateStore is the Redis side: latest values and hour meters.
type StateStore interface {
	Load(ctx context.Context, gauges []GaugeKey, machines []string) (map[GaugeKey]validate.Previous, map[string]float64, error)
	// Apply stores the rows as latest values where they are newer than what
	// is there, and raises the hour meters.
	Apply(ctx context.Context, rows []validate.Row) error
}

// ConfigSource returns the rules of a machine, or nil when it has no config.
type ConfigSource interface {
	Machine(machineID string) validate.MachineConfig
}

// Forwarder produces rejected and dead-letter records.
type Forwarder interface {
	Forward(ctx context.Context, topic string, source *kgo.Record, reason, detail string) error
}

// Metrics of ingest (SPEC section 5.3).
type Metrics struct {
	Messages     *prometheus.CounterVec
	Rows         *prometheus.CounterVec
	BatchLatency prometheus.Histogram
	EndToEnd     prometheus.Histogram
	Quality      *prometheus.HistogramVec
	Flags        *prometheus.CounterVec
	Rejected     *prometheus.CounterVec
	NoConfig     prometheus.Counter
	Late         prometheus.Counter
	InfraErrors  prometheus.Counter
	Lag          *prometheus.GaugeVec
	LagSeconds   prometheus.Gauge
}

func NewMetrics(reg prometheus.Registerer) *Metrics {
	m := &Metrics{
		Messages: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "ingest_messages_total", Help: "Kafka records processed, by result (ok, rejected, dlq)."}, []string{"result"}),
		Rows: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "ingest_rows_total", Help: "Reading rows, by result (inserted, duplicate)."}, []string{"result"}),
		BatchLatency: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name: "ingest_batch_latency_seconds", Help: "Time to process one batch, retries included.",
			Buckets: prometheus.ExponentialBuckets(0.002, 2, 14)}),
		EndToEnd: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name: "ingest_end_to_end_seconds", Help: "ingested_at minus window_end of realtime readings.",
			Buckets: prometheus.ExponentialBuckets(0.05, 2, 12)}),
		Quality: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name: "reading_quality", Help: "Quality score of stored readings, by gauge type.",
			Buckets: prometheus.LinearBuckets(0.1, 0.1, 10)}, []string{"gauge_type"}),
		Flags: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "reading_flag_total", Help: "Flags on stored readings."}, []string{"flag"}),
		Rejected: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "ingest_rejected_total", Help: "Rejected records, by reason."}, []string{"reason"}),
		NoConfig: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "ingest_no_config_total", Help: "Messages from machines without a config in config-api."}),
		Late: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "ingest_late_total", Help: "Realtime messages older than the latest stored reading (overtaken, e.g. after a failover)."}),
		InfraErrors: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "ingest_infra_errors_total", Help: "Failed attempts caused by the database, Redis or Kafka."}),
		Lag: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "kafka_consumer_lag", Help: "Records between the committed offset and the end of the partition, read from the broker every few seconds."},
			[]string{"topic", "partition"}),
		LagSeconds: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "ingest_lag_seconds", Help: "Age of the newest processed record when its batch finished."}),
	}
	reg.MustRegister(m.Messages, m.Rows, m.BatchLatency, m.EndToEnd, m.Quality, m.Flags, m.Rejected, m.NoConfig, m.Late,
		m.InfraErrors, m.Lag, m.LagSeconds)
	return m
}

// Processor turns Kafka records into stored readings.
type Processor struct {
	configs   ConfigSource
	readings  ReadingStore
	state     StateStore
	forwarder Forwarder
	metrics   *Metrics
	logger    *slog.Logger
	now       func() time.Time

	rejectedTopic, dlqTopic string
	dataRetries             int           // attempts before a failing batch is bisected
	backoffMin, backoffMax  time.Duration // infrastructure retry backoff

	degraded atomic.Bool
}

func NewProcessor(configs ConfigSource, readings ReadingStore, state StateStore, forwarder Forwarder,
	metrics *Metrics, logger *slog.Logger) *Processor {
	return &Processor{configs: configs, readings: readings, state: state, forwarder: forwarder,
		metrics: metrics, logger: logger, now: time.Now,
		rejectedTopic: "gauge.rejected", dlqTopic: "gauge.dlq",
		dataRetries: 5, backoffMin: 200 * time.Millisecond, backoffMax: 30 * time.Second}
}

// Degraded reports whether the processor is currently retrying because of an
// infrastructure failure.
func (p *Processor) Degraded() bool { return p.degraded.Load() }

// forever retries an infrastructure operation until it succeeds or ctx ends.
// Offsets are not committed meanwhile, so data piles up in Kafka instead of
// being dropped (SPEC 5.2).
func (p *Processor) forever(ctx context.Context, what string, op func() error) error {
	wait := p.backoffMin
	for {
		err := op()
		if err == nil {
			p.degraded.Store(false)
			return nil
		}
		var dataErr DataError
		if errors.As(err, &dataErr) {
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		p.degraded.Store(true)
		p.metrics.InfraErrors.Inc()
		p.logger.Warn("infrastructure error; retrying", "operation", what, "error", err, "retry_in", wait.String())
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
		wait = min(wait*2, p.backoffMax)
	}
}

type decoded struct {
	record *kgo.Record
	tel    *gaugev1.Telemetry
}

// Process handles one batch. It returns nil once every record is stored,
// rejected or dead-lettered, which is when the offsets may be committed. The
// only error it returns is the cancellation of ctx.
func (p *Processor) Process(ctx context.Context, records []*kgo.Record) error {
	started := p.now()
	var messages []decoded
	var rejected []Rejected
	for _, record := range records {
		tel := &gaugev1.Telemetry{}
		switch err := proto.Unmarshal(record.Value, tel); {
		case err != nil:
			rejected = append(rejected, Rejected{Record: record, Reason: "bad_schema", Detail: err.Error()})
		case tel.GetMachineId() == "" || tel.GetEdgeId() == "" || tel.GetWindowEndMs() <= 0:
			rejected = append(rejected, Rejected{Record: record, Reason: "incomplete",
				Detail:    "machine_id, edge_id and window_end_ms are required",
				MachineID: tel.GetMachineId(), EdgeID: tel.GetEdgeId(), Seq: int64(tel.GetSeq())})
		default:
			messages = append(messages, decoded{record, tel})
		}
	}

	// Stored state the checks compare against.
	var gauges []GaugeKey
	var machines []string
	seenGauge, seenMachine := map[GaugeKey]bool{}, map[string]bool{}
	for _, m := range messages {
		if !seenMachine[m.tel.GetMachineId()] {
			seenMachine[m.tel.GetMachineId()] = true
			machines = append(machines, m.tel.GetMachineId())
		}
		for _, meas := range m.tel.GetMeasurements() {
			key := GaugeKey{m.tel.GetMachineId(), meas.GetGaugeId()}
			if !seenGauge[key] {
				seenGauge[key] = true
				gauges = append(gauges, key)
			}
		}
	}
	var latest map[GaugeKey]validate.Previous
	var hourMeters map[string]float64
	if err := p.forever(ctx, "redis load", func() (err error) {
		latest, hourMeters, err = p.state.Load(ctx, gauges, machines)
		return err
	}); err != nil {
		return err
	}

	nowMs := p.now().UnixMilli()
	perRecord := make([][]validate.Row, len(messages))
	for i, m := range messages {
		machine := m.tel.GetMachineId()
		config := p.configs.Machine(machine)
		if config == nil {
			p.metrics.NoConfig.Inc()
		}
		hourMeter, hasHourMeter := hourMeters[machine]
		rows := validate.Check(validate.Input{
			Telemetry: m.tel, Config: config, NowMs: nowMs,
			Latest:    func(gauge string) validate.Previous { return latest[GaugeKey{machine, gauge}] },
			HourMeter: hourMeter, HasHourMeter: hasHourMeter,
		})
		for _, row := range rows {
			if row.Late {
				p.metrics.Late.Inc()
				break
			}
		}
		// Later messages of the same batch see this one as the stored state.
		for _, row := range rows {
			if !row.UpdateLatest {
				continue
			}
			key := GaugeKey{machine, row.GaugeID}
			if prev := latest[key]; !prev.OK || prev.TsMs < row.TsMs {
				latest[key] = validate.Previous{Value: *row.Value, TsMs: row.TsMs, OK: true}
			}
			if row.Monotonic && (!hasHourMeter || *row.Value > hourMeter) {
				hourMeters[machine] = *row.Value
			}
		}
		perRecord[i] = rows
	}

	stored, err := p.write(ctx, messages, perRecord, rejected)
	if err != nil {
		return err
	}
	if err := p.forever(ctx, "redis apply", func() error { return p.state.Apply(ctx, stored) }); err != nil {
		return err
	}
	for _, r := range rejected {
		r := r
		if err := p.forever(ctx, "produce rejected", func() error {
			return p.forwarder.Forward(ctx, p.rejectedTopic, r.Record, r.Reason, r.Detail)
		}); err != nil {
			return err
		}
	}

	p.metrics.Messages.WithLabelValues("rejected").Add(float64(len(rejected)))
	for _, r := range rejected {
		p.metrics.Rejected.WithLabelValues(r.Reason).Inc()
	}
	finished := p.now()
	for _, row := range stored {
		p.metrics.Quality.WithLabelValues(row.GaugeType).Observe(float64(row.Quality))
		for _, flag := range row.Flags {
			p.metrics.Flags.WithLabelValues(gaugev1.Flag(flag).String()).Inc()
		}
	}
	for _, m := range messages {
		if !m.tel.GetReplayed() {
			p.metrics.EndToEnd.Observe(float64(finished.UnixMilli()-m.tel.GetWindowEndMs()) / 1000)
		}
	}
	if n := len(records); n > 0 {
		p.metrics.LagSeconds.Set(finished.Sub(records[n-1].Timestamp).Seconds())
	}
	p.metrics.BatchLatency.Observe(finished.Sub(started).Seconds())
	return nil
}

// write stores the rows of the given records. A data error is retried a few
// times, then the batch is split in two until the offending record is found;
// only that record goes to the dead-letter topic.
func (p *Processor) write(ctx context.Context, messages []decoded, perRecord [][]validate.Row, rejected []Rejected) ([]validate.Row, error) {
	var rows []validate.Row
	for _, r := range perRecord {
		rows = append(rows, r...)
	}
	if len(rows) == 0 && len(rejected) == 0 {
		return nil, nil
	}
	var err error
	for attempt := 1; attempt <= p.dataRetries; attempt++ {
		var inserted int64
		err = p.forever(ctx, "database write", func() (e error) {
			inserted, e = p.readings.Write(ctx, rows, rejected)
			return e
		})
		if err == nil {
			p.metrics.Rows.WithLabelValues("inserted").Add(float64(inserted))
			p.metrics.Rows.WithLabelValues("duplicate").Add(float64(int64(len(rows)) - inserted))
			p.metrics.Messages.WithLabelValues("ok").Add(float64(len(messages)))
			return rows, nil
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		p.logger.Warn("batch rejected by the database", "attempt", attempt, "records", len(messages), "error", err)
	}

	if len(messages) <= 1 {
		if len(messages) == 0 {
			// The rejected_reading rows themselves are refused. The records
			// still go to the rejected topic, so nothing is lost; only the
			// table misses them.
			p.logger.Error("rejected records could not be stored in the database", "records", len(rejected), "error", err)
			return nil, nil
		}
		// Rejected records of this batch still have to be written.
		if len(rejected) > 0 {
			if _, werr := p.write(ctx, nil, nil, rejected); werr != nil {
				return nil, werr
			}
		}
		record := messages[0].record
		p.logger.Error("record sent to the dead-letter topic", "topic", record.Topic, "partition", record.Partition,
			"offset", record.Offset, "error", err)
		if ferr := p.forever(ctx, "produce dlq", func() error {
			return p.forwarder.Forward(ctx, p.dlqTopic, record, "write_failed", err.Error())
		}); ferr != nil {
			return nil, ferr
		}
		p.metrics.Messages.WithLabelValues("dlq").Inc()
		return nil, nil
	}
	half := len(messages) / 2
	first, err := p.write(ctx, messages[:half], perRecord[:half], rejected)
	if err != nil {
		return nil, err
	}
	second, err := p.write(ctx, messages[half:], perRecord[half:], nil)
	if err != nil {
		return nil, err
	}
	return append(first, second...), nil
}
