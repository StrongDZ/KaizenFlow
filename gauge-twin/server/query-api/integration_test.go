//go:build integration

package main

// Integration tests against TimescaleDB (migrated). Run with
// `make test-integration` after `make up && make migrate`.

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

var ctx = context.Background()

// testStore returns the store and a machine ID no other test uses; the rows
// of that machine are removed when the test ends.
func testStore(t *testing.T) (*PgStore, *pgxpool.Pool, string) {
	t.Helper()
	url := os.Getenv("QUERY_API_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("QUERY_API_TEST_DATABASE_URL is not set")
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	machine := fmt.Sprintf("itest-qa-%d", time.Now().UnixNano())
	t.Cleanup(func() {
		for _, q := range []string{
			`DELETE FROM gauge_reading WHERE machine_id = $1`,
			`DELETE FROM station_config WHERE machine_id = $1`,
			`DELETE FROM machine WHERE machine_id = $1`,
			`DELETE FROM edge_node WHERE edge_id = $1`,
		} {
			_, _ = pool.Exec(ctx, q, machine)
		}
		pool.Close()
	})
	return NewPgStore(pool), pool, machine
}

func exec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(ctx, sql, args...); err != nil {
		t.Fatal(err)
	}
}

func insertReading(t *testing.T, pool *pgxpool.Pool, machine, gauge string, ts time.Time, value float64, quality float32, flags []int16) {
	t.Helper()
	exec(t, pool, `INSERT INTO gauge_reading (ts, machine_id, gauge_id, value, v_min, v_max, n_frames, quality, flags)
		VALUES ($1, $2, $3, $4::float8, $4::float8 - 1, $4::float8 + 1, 2, $5, $6)`, ts, machine, gauge, value, quality, flags)
}

func TestIntegrationStations(t *testing.T) {
	store, pool, machine := testStore(t)
	exec(t, pool, `INSERT INTO machine (machine_id, plant, line) VALUES ($1, 'ITEST', 'L09')`, machine)
	exec(t, pool, `INSERT INTO station_config (machine_id, config_version, config) VALUES ($1, 7, $2::jsonb)`, machine, `{
		"camera": {"url": "rtsp://cam/itest", "camera_id": "front"},
		"cameras": [{"camera_id": "side", "url": "rtsp://cam/itest-side"}, {"camera_id": "unused", "url": "rtsp://cam/unused"}],
		"gauges": [
		  {"gauge_id": "OIL_TEMP", "type": "analog_dial", "unit": "degC", "roi": [1406, 207, 270, 296], "rules": {"min": 0, "max": 170},
		   "camera_id": "front"},
		  {"gauge_id": "CYCLE_TIMER", "type": "timer_mmss", "roi": [1258, 801, 176, 89], "camera_id": "side"}
		]}`)

	got, err := store.Stations(ctx, machine)
	if err != nil || len(got) != 1 {
		t.Fatalf("got %+v, %v", got, err)
	}
	s := got[0]
	if s.MachineID != machine || s.Plant != "ITEST" || s.Line != "L09" || s.ConfigVersion != 7 || len(s.Gauges) != 2 {
		t.Fatalf("station: %+v", s)
	}
	// The default camera, named or not, is the empty id; an unused camera is left out.
	if len(s.Cameras) != 2 || s.Cameras[0] != (CameraRef{URL: "rtsp://cam/itest"}) || s.Cameras[1] != (CameraRef{ID: "side", URL: "rtsp://cam/itest-side"}) {
		t.Fatalf("cameras: %+v", s.Cameras)
	}
	if s.Gauges[0].CameraID != "" || s.Gauges[1].CameraID != "side" {
		t.Errorf("camera of the gauges: %q, %q", s.Gauges[0].CameraID, s.Gauges[1].CameraID)
	}
	oil, timer := s.Gauges[0], s.Gauges[1]
	if oil.GaugeID != "OIL_TEMP" || oil.Type != "analog_dial" || oil.Unit != "degC" || len(oil.ROI) != 4 || oil.ROI[0] != 1406 ||
		oil.Rules.Min == nil || *oil.Rules.Max != 170 {
		t.Errorf("OIL_TEMP: %+v", oil)
	}
	if timer.Unit != "" || timer.Rules.Min != nil || timer.Rules.Max != nil {
		t.Errorf("CYCLE_TIMER: %+v", timer)
	}

	all, err := store.Stations(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for i, row := range all {
		found = found || row.MachineID == machine
		if i > 0 && all[i-1].MachineID > row.MachineID {
			t.Errorf("stations are not ordered by machine ID: %s before %s", all[i-1].MachineID, row.MachineID)
		}
	}
	if !found {
		t.Error("the list of all stations misses the test machine")
	}
	if none, err := store.Stations(ctx, machine+"-unknown"); err != nil || len(none) != 0 {
		t.Errorf("unknown machine: %+v, %v", none, err)
	}
}

func TestIntegrationLatestFollowsTsNotWriteOrder(t *testing.T) {
	store, pool, machine := testStore(t)
	now := time.Now().UTC().Truncate(time.Millisecond)
	// The newest reading is written first; a replayed, older one arrives after it.
	insertReading(t, pool, machine, "AMMETER", now.Add(-time.Second), 29.8, 0.44, []int16{4})
	insertReading(t, pool, machine, "AMMETER", now.Add(-time.Minute), 20.0, 0.9, nil)
	insertReading(t, pool, machine, "OLD", now.Add(-time.Hour), 1.0, 0.9, nil)

	got, err := store.Latest(ctx, now.Add(-10*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	r, ok := got[GaugeKey{machine, "AMMETER"}]
	if !ok || !r.TS.Equal(now.Add(-time.Second)) || *r.Value != 29.8 || *r.VMin != 28.8 || *r.VMax != 30.8 ||
		*r.NFrames != 2 || *r.Quality != 0.44 || len(r.Flags) != 1 || r.Flags[0] != 4 {
		t.Errorf("AMMETER: %+v (found %v)", r, ok)
	}
	if _, ok := got[GaugeKey{machine, "OLD"}]; ok {
		t.Error("a reading older than since came back")
	}
}

func TestIntegrationEdges(t *testing.T) {
	store, pool, machine := testStore(t)
	other := machine + "-b"
	seen := time.Now().UTC().Truncate(time.Millisecond)
	// The edge ID equals the machine ID so that the cleanup removes it.
	exec(t, pool, `INSERT INTO edge_node (edge_id, machine_id, machine_ids, status, last_seen) VALUES ($1, $2, $3, 'online', $4)`,
		machine, machine, []string{machine, other}, seen)

	got, err := store.Edges(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range []string{machine, other} {
		e, ok := got[m]
		if !ok || e.EdgeID != machine || e.Status != "online" || e.LastSeen == nil || !e.LastSeen.Equal(seen) {
			t.Errorf("%s: %+v (found %v)", m, e, ok)
		}
	}
}

func TestIntegrationSeries(t *testing.T) {
	store, pool, machine := testStore(t)
	base := time.Now().UTC().Truncate(time.Minute).Add(-5 * time.Minute)
	// Written out of order; the first two share a 10 s bucket.
	insertReading(t, pool, machine, "OIL_TEMP", base.Add(20*time.Second), 30, 0.9, nil)
	insertReading(t, pool, machine, "OIL_TEMP", base.Add(2*time.Second), 10, 0.8, nil)
	insertReading(t, pool, machine, "OIL_TEMP", base.Add(4*time.Second), 20, 0.6, nil)
	insertReading(t, pool, machine, "OTHER", base.Add(3*time.Second), 99, 0.9, nil)
	insertReading(t, pool, machine, "OIL_TEMP", base.Add(-time.Hour), 99, 0.9, nil)

	got, err := store.Series(ctx, machine, "OIL_TEMP", base.Add(-time.Minute), 10*time.Second)
	if err != nil || len(got) != 2 {
		t.Fatalf("got %+v, %v", got, err)
	}
	if !got[0].TS.Equal(base) || *got[0].Value != 15 || *got[0].Quality != 0.6 {
		t.Errorf("first bucket: %+v", got[0])
	}
	if !got[1].TS.Equal(base.Add(20*time.Second)) || *got[1].Value != 30 {
		t.Errorf("second bucket: %+v", got[1])
	}
}

func TestIntegrationHistory(t *testing.T) {
	store, pool, machine := testStore(t)
	base := time.Now().UTC().Truncate(time.Minute).Add(-5 * time.Minute)
	insertReading(t, pool, machine, "OIL_TEMP", base.Add(2*time.Second), 10, 0.8, nil)
	insertReading(t, pool, machine, "OIL_TEMP", base.Add(4*time.Second), 20, 0.6, nil)
	insertReading(t, pool, machine, "OIL_TEMP", base.Add(20*time.Second), 30, 0.9, nil)
	insertReading(t, pool, machine, "OIL_TEMP", base.Add(time.Minute), 99, 0.9, nil) // at to: outside
	insertReading(t, pool, machine, "OTHER", base.Add(3*time.Second), 99, 0.9, nil)

	got, err := store.History(ctx, machine, "OIL_TEMP", base, base.Add(time.Minute), 10*time.Second, sourceRaw)
	if err != nil || len(got) != 2 {
		t.Fatalf("got %+v, %v", got, err)
	}
	first := got[0]
	if !first.TS.Equal(base) || *first.Value != 15 || *first.Min > 10 || *first.Max < 20 || *first.Quality != 0.6 || first.N != 2 {
		t.Errorf("first bucket: %+v (min %v max %v)", first, *first.Min, *first.Max)
	}
	if !got[1].TS.Equal(base.Add(20*time.Second)) || *got[1].Value != 30 || got[1].N != 1 {
		t.Errorf("second bucket: %+v", got[1])
	}

	if _, err := pool.Exec(ctx, "CALL refresh_continuous_aggregate('gauge_1m', $1::timestamptz, $2::timestamptz)", base.Add(-time.Minute), base.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	minutes, err := store.History(ctx, machine, "OIL_TEMP", base, base.Add(time.Minute), time.Minute, sourceMinute)
	if err != nil || len(minutes) != 1 {
		t.Fatalf("aggregate: got %+v, %v", minutes, err)
	}
	if m := minutes[0]; !m.TS.Equal(base) || *m.Value != 20 || m.N != 3 || m.Quality != nil {
		t.Errorf("aggregate bucket: %+v (value %v)", m, *m.Value)
	}
}
