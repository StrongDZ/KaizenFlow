//go:build integration

package main

// Integration tests of the stores against TimescaleDB (migrated) and Redis.
// Run with `make test-integration` after `make up && make migrate`.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/twmb/franz-go/pkg/kgo"

	"gauge-twin/server/pkg/validate"
)

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("INGEST_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("INGEST_TEST_DATABASE_URL is not set")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func testRow(machine, gauge string, ts time.Time, value float64) validate.Row {
	return validate.Row{TsMs: ts.UnixMilli(), MachineID: machine, GaugeID: gauge, Value: &value, VMin: value - 1, VMax: value + 1,
		NFrames: 2, Quality: 0.9, Flags: []int16{4, 5}, EdgeID: "edge-it", Seq: 7, ModelVersion: "m", UpdateLatest: true}
}

func TestIntegrationWriteIsIdempotentAndKeepsEveryField(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	store := &PgReadings{pool}
	machine := fmt.Sprintf("ITEST_%d", time.Now().UnixNano())
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM gauge_reading WHERE machine_id = $1`, machine)
		_, _ = pool.Exec(ctx, `DELETE FROM rejected_reading WHERE kafka_topic = $1`, machine)
	})
	base := time.Now().Truncate(time.Second).Add(-time.Minute)
	unreadable := testRow(machine, "B", base, 0)
	unreadable.Value, unreadable.Flags, unreadable.Replayed = nil, []int16{1}, true
	rows := []validate.Row{testRow(machine, "A", base, 60.5), testRow(machine, "A", base.Add(time.Second), 61), unreadable,
		testRow(machine, "A", base, 999)} // same key as the first row, inside one batch
	rejected := []Rejected{{Record: &kgo.Record{Topic: machine, Partition: 2, Offset: 41, Value: []byte{0xFF}, Timestamp: base},
		Reason: "bad_schema", Detail: "truncated"}}

	inserted, err := store.Write(ctx, rows, rejected)
	if err != nil || inserted != 3 {
		t.Fatalf("first write: inserted=%d err=%v", inserted, err)
	}
	// The same batch again, as after a crash before the offset commit.
	inserted, err = store.Write(ctx, rows, rejected)
	if err != nil || inserted != 0 {
		t.Fatalf("second write: inserted=%d err=%v", inserted, err)
	}

	var count, rejectedCount int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM gauge_reading WHERE machine_id = $1`, machine).Scan(&count)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM rejected_reading WHERE kafka_topic = $1`, machine).Scan(&rejectedCount)
	if count != 3 || rejectedCount != 1 {
		t.Errorf("rows=%d rejected=%d", count, rejectedCount)
	}
	var value, vmin *float64
	var quality float32
	var flags []int16
	var edge, model string
	var seq int64
	var nframes int32
	err = pool.QueryRow(ctx, `SELECT value, v_min, quality, flags, edge_id, seq, model_version, n_frames FROM gauge_reading
		WHERE machine_id = $1 AND gauge_id = 'A' AND ts = $2`, machine, base).Scan(&value, &vmin, &quality, &flags, &edge, &seq, &model, &nframes)
	if err != nil || *value != 60.5 || *vmin != 59.5 || quality != 0.9 || len(flags) != 2 || flags[1] != 5 ||
		edge != "edge-it" || seq != 7 || model != "m" || nframes != 2 {
		t.Errorf("stored row: value=%v quality=%v flags=%v edge=%s seq=%d err=%v", value, quality, flags, edge, seq, err)
	}
	var null, replayed bool
	_ = pool.QueryRow(ctx, `SELECT value IS NULL, replayed FROM gauge_reading WHERE machine_id = $1 AND gauge_id = 'B'`, machine).Scan(&null, &replayed)
	if !null || !replayed {
		t.Errorf("unreadable replayed gauge: value null=%v replayed=%v", null, replayed)
	}
	var realtime int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM gauge_reading WHERE machine_id = $1 AND NOT replayed`, machine).Scan(&realtime)
	if realtime != 2 {
		t.Errorf("%d realtime rows, want 2", realtime)
	}
}

func TestIntegrationBadDataIsReportedAsDataError(t *testing.T) {
	pool := testPool(t)
	store := &PgReadings{pool}
	// PostgreSQL refuses a NUL byte in text: a failure no retry can fix.
	_, err := store.Write(context.Background(), []validate.Row{testRow("BAD\x00ID", "A", time.Now(), 1)}, nil)
	var dataErr DataError
	if !errors.As(err, &dataErr) {
		t.Fatalf("got %v, want a DataError", err)
	}
}

func TestIntegrationRedisKeepsOnlyNewerValues(t *testing.T) {
	addr := os.Getenv("INGEST_TEST_REDIS")
	if addr == "" {
		t.Skip("INGEST_TEST_REDIS is not set")
	}
	client := redis.NewClient(&redis.Options{Addr: addr})
	defer client.Close()
	ctx := context.Background()
	state := &RedisState{client}
	machine := fmt.Sprintf("ITEST_%d", time.Now().UnixNano())
	key := GaugeKey{machine, "H"}
	t.Cleanup(func() { client.Del(ctx, latestKey(key), hourMeterKey(machine)) })
	now := time.Now().Truncate(time.Millisecond)
	meter := func(ts time.Time, value float64) validate.Row {
		row := testRow(machine, "H", ts, value)
		row.Monotonic = true
		return row
	}

	if latest, hours, err := state.Load(ctx, []GaugeKey{key}, []string{machine}); err != nil || len(latest) != 0 || len(hours) != 0 {
		t.Fatalf("empty load: %v %v %v", latest, hours, err)
	}
	if err := state.Apply(ctx, []validate.Row{meter(now, 100.5)}); err != nil {
		t.Fatal(err)
	}
	skewed := meter(now.Add(time.Hour), 999)
	skewed.UpdateLatest = false
	// An older reading (a replay), a lower hour meter, and a row that must not become latest.
	if err := state.Apply(ctx, []validate.Row{meter(now.Add(-time.Minute), 90), skewed}); err != nil {
		t.Fatal(err)
	}

	latest, hours, err := state.Load(ctx, []GaugeKey{key}, []string{machine})
	if err != nil {
		t.Fatal(err)
	}
	if got := latest[key]; !got.OK || got.Value != 100.5 || got.TsMs != now.UnixMilli() {
		t.Errorf("latest: %+v", got)
	}
	if hours[machine] != 100.5 {
		t.Errorf("hour meter: %v", hours[machine])
	}
	if quality := client.HGet(ctx, latestKey(key), "quality").Val(); quality != "0.9" {
		t.Errorf("quality field: %q", quality)
	}

	if err := state.Apply(ctx, []validate.Row{meter(now.Add(time.Second), 100.6)}); err != nil {
		t.Fatal(err)
	}
	latest, hours, _ = state.Load(ctx, []GaugeKey{key}, []string{machine})
	if latest[key].Value != 100.6 || hours[machine] != 100.6 {
		t.Errorf("newer value not stored: %+v %v", latest[key], hours[machine])
	}
}
