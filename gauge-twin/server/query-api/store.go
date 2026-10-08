package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotFound is returned for a machine without a station config.
var ErrNotFound = errors.New("station not found")

// GaugeConfig is the part of a gauge config the UI needs.
type GaugeConfig struct {
	GaugeID string    `json:"gauge_id"`
	Type    string    `json:"type"`
	Unit    string    `json:"unit"`
	ROI     []float64 `json:"roi"` // x, y, w, h in pixels of its camera's frame
	// CameraID names the camera that sees the gauge; empty is the default one.
	CameraID string `json:"camera_id"`
	Rules    struct {
		Min *float64 `json:"min"`
		Max *float64 `json:"max"`
		// The edge does not report these gauges in every window (SPEC 4.2).
		Deadband        *float64 `json:"deadband"`
		ReportIntervalS uint32   `json:"report_interval_s"`
	} `json:"rules"`
}

// Type of a gauge that is only reported when its value changes.
const typeRollingCounter = "rolling_counter"

// resendEvery is how often the edge repeats an unchanged value of a gauge
// with a deadband.
const resendEvery = time.Minute

// staleLimit is the age after which the latest reading of a gauge says the
// gauge went silent. Most gauges are reported in every window; a counter is
// reported when it changes (or every report interval), a gauge with a
// deadband at least once a minute. Their last reading is older by design.
func (g GaugeConfig) staleLimit(staleAfter, lookback time.Duration) time.Duration {
	switch {
	case g.Type == typeRollingCounter && g.Rules.ReportIntervalS > 0:
		return time.Duration(g.Rules.ReportIntervalS)*time.Second + staleAfter
	case g.Type == typeRollingCounter:
		// Never repeated: any reading the lookback still holds is current.
		return lookback
	case g.Rules.Deadband != nil:
		return resendEvery + staleAfter
	}
	return staleAfter
}

// CameraRef is a camera of a station config. The url stays on the server: it
// can hold credentials.
type CameraRef struct {
	ID  string // empty for an unnamed default camera
	URL string
}

// StationRow is a station as configured.
type StationRow struct {
	MachineID     string
	Plant         string
	Line          string
	ConfigVersion uint32
	// Cameras lists the cameras the gauges are on, in the order the gauges
	// name them. A camera can also be in the config of another machine.
	Cameras []CameraRef
	Gauges  []GaugeConfig
}

type cameraDoc struct {
	ID  string `json:"camera_id"`
	URL string `json:"url"`
}

// camerasInUse resolves the camera of every gauge the way decode.CameraOf
// does, and returns the ones with a url, each once.
func camerasInUse(def cameraDoc, more []cameraDoc, gauges []GaugeConfig) []CameraRef {
	var out []CameraRef
	seen := map[string]bool{}
	for _, g := range gauges {
		cam, found := def, g.CameraID == "" || g.CameraID == def.ID
		for _, c := range more {
			if !found && c.ID == g.CameraID {
				cam, found = c, true
			}
		}
		if found && cam.URL != "" && !seen[g.CameraID] {
			seen[g.CameraID] = true
			out = append(out, CameraRef{ID: g.CameraID, URL: cam.URL})
		}
	}
	return out
}

// EdgeRow is the edge that reported a machine last.
type EdgeRow struct {
	EdgeID   string
	Status   string
	LastSeen *time.Time
}

// GaugeKey identifies a gauge.
type GaugeKey struct{ Machine, Gauge string }

// Point is one bucket of a series.
type Point struct {
	TS      time.Time `json:"ts"`
	Value   *float64  `json:"value"`
	Quality *float32  `json:"quality"`
}

// Store reads what the UI shows. Every query orders by ts, never by write
// order (SPEC section 3.4).
type Store interface {
	// Stations lists the configured stations ordered by machine ID; a
	// non-empty machineID keeps that one only.
	Stations(ctx context.Context, machineID string) ([]StationRow, error)
	// Latest returns the newest reading of every gauge that has one after since.
	Latest(ctx context.Context, since time.Time) (map[GaugeKey]Reading, error)
	// Edges returns the edge of every machine an edge reported.
	Edges(ctx context.Context) (map[string]EdgeRow, error)
	// Series returns the readings of a gauge after since, averaged per bucket.
	Series(ctx context.Context, machine, gauge string, since time.Time, bucket time.Duration) ([]Point, error)
	// History returns the readings of a gauge in [from, to) per bucket, from
	// the readings (sourceRaw) or from the one-minute aggregate (sourceMinute).
	History(ctx context.Context, machine, gauge string, from, to time.Time, bucket time.Duration, source string) ([]HistoryPoint, error)
	Ping(ctx context.Context) error
}

// PgStore is the PostgreSQL implementation.
type PgStore struct{ pool *pgxpool.Pool }

func NewPgStore(pool *pgxpool.Pool) *PgStore { return &PgStore{pool: pool} }

func (p *PgStore) Ping(ctx context.Context) error { return p.pool.Ping(ctx) }

func (p *PgStore) Stations(ctx context.Context, machineID string) ([]StationRow, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT sc.machine_id, COALESCE(m.plant, ''), COALESCE(m.line, ''), sc.config_version, sc.config::text
		FROM station_config sc LEFT JOIN machine m USING (machine_id)
		WHERE $1 = '' OR sc.machine_id = $1
		ORDER BY sc.machine_id`, machineID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []StationRow
	for rows.Next() {
		var s StationRow
		var config string
		if err := rows.Scan(&s.MachineID, &s.Plant, &s.Line, &s.ConfigVersion, &config); err != nil {
			return nil, err
		}
		var doc struct {
			Camera  cameraDoc     `json:"camera"`
			Cameras []cameraDoc   `json:"cameras"`
			Gauges  []GaugeConfig `json:"gauges"`
		}
		if err := json.Unmarshal([]byte(config), &doc); err != nil {
			return nil, fmt.Errorf("config of %s: %w", s.MachineID, err)
		}
		// A gauge may name the default camera by its id; the views use one
		// spelling, the empty id.
		for i := range doc.Gauges {
			if doc.Gauges[i].CameraID == doc.Camera.ID {
				doc.Gauges[i].CameraID = ""
			}
		}
		s.Gauges, s.Cameras = doc.Gauges, camerasInUse(cameraDoc{URL: doc.Camera.URL}, doc.Cameras, doc.Gauges)
		out = append(out, s)
	}
	return out, rows.Err()
}

func (p *PgStore) Latest(ctx context.Context, since time.Time) (map[GaugeKey]Reading, error) {
	// since bounds the scan to the recent chunks of the hypertable.
	rows, err := p.pool.Query(ctx, `
		SELECT DISTINCT ON (machine_id, gauge_id)
		       machine_id, gauge_id, ts, value, v_min, v_max, n_frames, quality, flags
		FROM gauge_reading
		WHERE ts > $1
		ORDER BY machine_id, gauge_id, ts DESC`, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[GaugeKey]Reading{}
	for rows.Next() {
		var k GaugeKey
		var r Reading
		if err := rows.Scan(&k.Machine, &k.Gauge, &r.TS, &r.Value, &r.VMin, &r.VMax, &r.NFrames, &r.Quality, &r.Flags); err != nil {
			return nil, err
		}
		out[k] = r
	}
	return out, rows.Err()
}

func (p *PgStore) Edges(ctx context.Context) (map[string]EdgeRow, error) {
	// An edge serves several machines (machine_ids); rows written before that
	// column existed only carry machine_id. A machine keeps the edge seen last.
	rows, err := p.pool.Query(ctx, `
		SELECT DISTINCT ON (machine) machine, edge_id, status, last_seen
		FROM (
		  SELECT unnest(CASE WHEN cardinality(machine_ids) > 0 THEN machine_ids ELSE ARRAY[machine_id] END) AS machine,
		         edge_id, status, last_seen
		  FROM edge_node
		) e
		WHERE machine IS NOT NULL
		ORDER BY machine, last_seen DESC NULLS LAST`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]EdgeRow{}
	for rows.Next() {
		var machine string
		var e EdgeRow
		if err := rows.Scan(&machine, &e.EdgeID, &e.Status, &e.LastSeen); err != nil {
			return nil, err
		}
		out[machine] = e
	}
	return out, rows.Err()
}

func (p *PgStore) Series(ctx context.Context, machine, gauge string, since time.Time, bucket time.Duration) ([]Point, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT time_bucket($4::interval, ts) AS bucket, avg(value), min(quality)
		FROM gauge_reading
		WHERE machine_id = $1 AND gauge_id = $2 AND ts > $3
		GROUP BY bucket
		ORDER BY bucket`, machine, gauge, since, bucket)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Point
	for rows.Next() {
		var pt Point
		if err := rows.Scan(&pt.TS, &pt.Value, &pt.Quality); err != nil {
			return nil, err
		}
		out = append(out, pt)
	}
	return out, rows.Err()
}
