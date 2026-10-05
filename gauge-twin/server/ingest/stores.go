package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/twmb/franz-go/pkg/kgo"
	"google.golang.org/protobuf/encoding/protojson"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
	"gauge-twin/server/pkg/validate"
)

// ------------------------------------------------------------ database ----

// PgReadings writes to TimescaleDB.
type PgReadings struct{ pool *pgxpool.Pool }

var readingColumns = []string{"ts", "machine_id", "gauge_id", "value", "v_min", "v_max", "n_frames", "quality",
	"flags", "edge_id", "seq", "model_version", "replayed"}

// Write copies the rows into a temporary table and inserts them with
// ON CONFLICT DO NOTHING, so replays and duplicates never create extra rows.
func (p *PgReadings) Write(ctx context.Context, rows []validate.Row, rejected []Rejected) (int64, error) {
	inserted, err := p.write(ctx, rows, rejected)
	if err != nil {
		// SQLSTATE classes 22 (data exception) and 23 (integrity violation)
		// are caused by the rows themselves; everything else is infrastructure.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && len(pgErr.Code) >= 2 && (pgErr.Code[:2] == "22" || pgErr.Code[:2] == "23") {
			return 0, DataError{err}
		}
	}
	return inserted, err
}

func (p *PgReadings) write(ctx context.Context, rows []validate.Row, rejected []Rejected) (int64, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var inserted int64
	if len(rows) > 0 {
		if _, err := tx.Exec(ctx, `CREATE TEMP TABLE ingest_batch (LIKE gauge_reading INCLUDING DEFAULTS) ON COMMIT DROP`); err != nil {
			return 0, err
		}
		source := pgx.CopyFromSlice(len(rows), func(i int) ([]any, error) {
			r := rows[i]
			return []any{time.UnixMilli(r.TsMs).UTC(), r.MachineID, r.GaugeID, r.Value, r.VMin, r.VMax, r.NFrames,
				r.Quality, r.Flags, r.EdgeID, r.Seq, r.ModelVersion, r.Replayed}, nil
		})
		if _, err := tx.CopyFrom(ctx, pgx.Identifier{"ingest_batch"}, readingColumns, source); err != nil {
			return 0, err
		}
		tag, err := tx.Exec(ctx, `
			INSERT INTO gauge_reading (ts, machine_id, gauge_id, value, v_min, v_max, n_frames, quality, flags, edge_id, seq, model_version, replayed)
			SELECT ts, machine_id, gauge_id, value, v_min, v_max, n_frames, quality, flags, edge_id, seq, model_version, replayed
			FROM ingest_batch ON CONFLICT DO NOTHING`)
		if err != nil {
			return 0, err
		}
		inserted = tag.RowsAffected()
	}
	for _, r := range rejected {
		// The record timestamp makes the row identical on a retry.
		if _, err := tx.Exec(ctx, `
			INSERT INTO rejected_reading (rejected_at, reason, detail, machine_id, edge_id, seq, kafka_topic, kafka_partition, kafka_offset, payload)
			VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, 0), $7, $8, $9, $10)
			ON CONFLICT (kafka_topic, kafka_partition, kafka_offset) DO NOTHING`,
			r.Record.Timestamp.UTC(), r.Reason, r.Detail, r.MachineID, r.EdgeID, r.Seq,
			r.Record.Topic, r.Record.Partition, r.Record.Offset, r.Record.Value); err != nil {
			return 0, err
		}
	}
	return inserted, tx.Commit(ctx)
}

// --------------------------------------------------------------- redis ----

// RedisState keeps latest values and hour meters (SPEC section 3.5).
type RedisState struct{ client *redis.Client }

// setLatest stores a reading only if it is newer than the stored one.
var setLatest = redis.NewScript(`
local ts = redis.call('HGET', KEYS[1], 'ts')
if (not ts) or tonumber(ts) < tonumber(ARGV[1]) then
  redis.call('HSET', KEYS[1], 'ts', ARGV[1], 'value', ARGV[2], 'quality', ARGV[3])
  return 1
end
return 0`)

// raiseHourMeter stores a value only if it is above the stored one.
var raiseHourMeter = redis.NewScript(`
local cur = redis.call('GET', KEYS[1])
if (not cur) or tonumber(cur) < tonumber(ARGV[1]) then
  redis.call('SET', KEYS[1], ARGV[1])
  return 1
end
return 0`)

func latestKey(k GaugeKey) string        { return "latest:" + k.Machine + ":" + k.Gauge }
func hourMeterKey(machine string) string { return "hourmeter:" + machine }

func (s *RedisState) Load(ctx context.Context, gauges []GaugeKey, machines []string) (map[GaugeKey]validate.Previous, map[string]float64, error) {
	latest, hourMeters := map[GaugeKey]validate.Previous{}, map[string]float64{}
	if len(gauges) == 0 && len(machines) == 0 {
		return latest, hourMeters, nil
	}
	pipe := s.client.Pipeline()
	latestCmds := make([]*redis.SliceCmd, len(gauges))
	for i, key := range gauges {
		latestCmds[i] = pipe.HMGet(ctx, latestKey(key), "value", "ts")
	}
	hourCmds := make([]*redis.StringCmd, len(machines))
	for i, machine := range machines {
		hourCmds[i] = pipe.Get(ctx, hourMeterKey(machine))
	}
	if _, err := pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		return nil, nil, err
	}
	for i, cmd := range latestCmds {
		values := cmd.Val()
		if len(values) != 2 || values[0] == nil || values[1] == nil {
			continue
		}
		value, err1 := strconv.ParseFloat(fmt.Sprint(values[0]), 64)
		ts, err2 := strconv.ParseInt(fmt.Sprint(values[1]), 10, 64)
		if err1 == nil && err2 == nil {
			latest[gauges[i]] = validate.Previous{Value: value, TsMs: ts, OK: true}
		}
	}
	for i, cmd := range hourCmds {
		if value, err := cmd.Float64(); err == nil {
			hourMeters[machines[i]] = value
		}
	}
	return latest, hourMeters, nil
}

func (s *RedisState) Apply(ctx context.Context, rows []validate.Row) error {
	pipe := s.client.Pipeline()
	queued := 0
	for _, row := range rows {
		if !row.UpdateLatest {
			continue
		}
		value := strconv.FormatFloat(*row.Value, 'g', -1, 64)
		setLatest.Eval(ctx, pipe, []string{latestKey(GaugeKey{row.MachineID, row.GaugeID})},
			row.TsMs, value, strconv.FormatFloat(float64(row.Quality), 'g', 4, 32))
		queued++
		if row.Monotonic {
			raiseHourMeter.Eval(ctx, pipe, []string{hourMeterKey(row.MachineID)}, value)
		}
	}
	if queued == 0 {
		return nil
	}
	_, err := pipe.Exec(ctx)
	return err
}

// --------------------------------------------------------------- kafka ----

// KafkaForwarder produces rejected and dead-letter records, keeping the
// original payload and key and describing the source in headers.
type KafkaForwarder struct{ client *kgo.Client }

func (f *KafkaForwarder) Forward(ctx context.Context, topic string, source *kgo.Record, reason, detail string) error {
	record := &kgo.Record{
		Topic: topic, Key: source.Key, Value: source.Value,
		Headers: append(append([]kgo.RecordHeader(nil), source.Headers...),
			kgo.RecordHeader{Key: "reason", Value: []byte(reason)},
			kgo.RecordHeader{Key: "detail", Value: []byte(detail)},
			kgo.RecordHeader{Key: "source", Value: []byte(fmt.Sprintf("%s/%d/%d", source.Topic, source.Partition, source.Offset))},
		),
	}
	return f.client.ProduceSync(ctx, record).FirstErr()
}

// ------------------------------------------------------------- configs ----

// ConfigCache holds the station configs of config-api, refreshed periodically.
type ConfigCache struct {
	url    string
	client *http.Client

	mu       sync.RWMutex
	machines map[string]validate.MachineConfig
}

func NewConfigCache(baseURL string) *ConfigCache {
	return &ConfigCache{url: baseURL + "/v1/stations", client: &http.Client{Timeout: 10 * time.Second},
		machines: map[string]validate.MachineConfig{}}
}

func (c *ConfigCache) Machine(machineID string) validate.MachineConfig {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.machines[machineID]
}

// Refresh replaces the cache with the current configs. On failure the
// previous content is kept.
func (c *ConfigCache) Refresh(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.url, nil)
	if err != nil {
		return err
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("config-api answered %d", resp.StatusCode)
	}
	machines, err := parseStations(body)
	if err != nil {
		return err
	}
	c.mu.Lock()
	c.machines = machines
	c.mu.Unlock()
	return nil
}

func parseStations(body []byte) (map[string]validate.MachineConfig, error) {
	var list struct {
		Stations []struct {
			MachineID string          `json:"machine_id"`
			Config    json.RawMessage `json:"config"`
		} `json:"stations"`
	}
	if err := json.Unmarshal(body, &list); err != nil {
		return nil, fmt.Errorf("decode station list: %w", err)
	}
	machines := make(map[string]validate.MachineConfig, len(list.Stations))
	for _, s := range list.Stations {
		var cfg gaugev1.StationConfig
		if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(s.Config, &cfg); err != nil {
			return nil, fmt.Errorf("config of %s: %w", s.MachineID, err)
		}
		rules := validate.MachineConfig{}
		for _, g := range cfg.GetGauges() {
			gauge := validate.GaugeRules{Type: g.GetType()}
			// Rules are optional; a gauge without them is only type-known.
			if r := g.GetRules(); r != nil {
				gauge.Min, gauge.Max, gauge.MaxRatePerS, gauge.Monotonic = r.Min, r.Max, r.MaxRatePerS, r.GetMonotonic()
			}
			rules[g.GetGaugeId()] = gauge
		}
		machines[s.MachineID] = rules
	}
	return machines, nil
}
