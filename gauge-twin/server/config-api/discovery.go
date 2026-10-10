package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Gauge discovery: discover-svc runs a detector on a frame of every camera and
// posts what it found. A detection where a gauge is declared says that gauge
// is still in view; any other detection becomes a candidate, proposed to a
// person once it has been found in a few scans. The person checks its region
// on the camera page and saves it as a gauge of a machine (the candidate is
// then accepted at the next scan), or marks it as nothing to read (ignored).
// No candidate ever reaches the readings by itself.

// ErrCandidateNotFound is returned for an unknown candidate.
var ErrCandidateNotFound = errors.New("candidate not found")

// Candidate statuses.
const (
	candidatePending  = "pending"
	candidateAccepted = "accepted"
	candidateIgnored  = "ignored"
)

// Limits of a scan.
const (
	maxDetections = 64
	maxCropBytes  = 256 << 10
	maxScanBody   = 20 << 20
)

// Gauge types a detection may suggest (config.proto: Gauge.type).
var detectableTypes = map[string]bool{"analog_dial": true, "seg7": true, "rolling_counter": true, "timer_mmss": true}

// Detection is one object discover-svc found on a frame.
type Detection struct {
	ROI   []int32 `json:"roi"` // x, y, w, h in pixels of the frame
	Type  string  `json:"type"`
	Score float32 `json:"score"`
	// Hint is the suggested calibration: for a dial the centre and the scale
	// ends in the 256 square of the roi, for a display the digit count.
	Hint     json.RawMessage `json:"hint,omitempty"`
	CropJPEG []byte          `json:"crop_jpeg,omitempty"` // base64 in JSON
}

// Candidate is a detection where no gauge is declared.
type Candidate struct {
	ID       int64   `json:"candidate_id"`
	CameraID string  `json:"camera_id"`
	ROI      []int32 `json:"roi"`
	Type     string  `json:"type"`
	// Score is the mean detector score over the scans that found it: a label
	// or a screw scores high in some frame now and then, a gauge in most.
	Score     float32         `json:"score"`
	Hint      json.RawMessage `json:"hint"`
	CropJPEG  []byte          `json:"crop_jpeg"`
	Seen      int             `json:"seen"`
	FirstSeen time.Time       `json:"first_seen"`
	LastSeen  time.Time       `json:"last_seen"`
	Status    string          `json:"status"`
	MachineID *string         `json:"machine_id"`
	GaugeID   *string         `json:"gauge_id"`
	DecidedAt *time.Time      `json:"decided_at"`
}

// CameraScan is the last scan of a camera.
type CameraScan struct {
	CameraID   string    `json:"camera_id"`
	ScannedAt  time.Time `json:"scanned_at"`
	Width      int       `json:"width"`
	Height     int       `json:"height"`
	Detections int       `json:"detections"`
}

// GaugeRef names a declared gauge.
type GaugeRef struct {
	MachineID string `json:"machine_id"`
	GaugeID   string `json:"gauge_id"`
}

// Sighting is the last scan that found a declared gauge.
type Sighting struct {
	GaugeRef
	LastSeen time.Time `json:"last_seen"`
}

// declaredGauge is a gauge of a station config, on the camera being scanned.
type declaredGauge struct {
	GaugeRef
	ROI []int32
}

// scanPlan is what one scan changes.
type scanPlan struct {
	Sighted  []GaugeRef
	Updates  map[int64]Detection // candidate -> the detection that found it again
	Inserts  []Detection
	Accepted map[int64]GaugeRef // pending candidates where a gauge is now declared
	// Reopened are accepted candidates whose gauge is no longer declared (it
	// was removed from its machine): they are proposed again.
	Reopened []int64
}

// box is a region as x0, y0, x1, y1.
type box struct{ x0, y0, x1, y1 float64 }

func boxOf(roi []int32) (box, bool) {
	if len(roi) != 4 || roi[2] <= 0 || roi[3] <= 0 {
		return box{}, false
	}
	x, y := float64(roi[0]), float64(roi[1])
	return box{x, y, x + float64(roi[2]), y + float64(roi[3])}, true
}

func (b box) contains(x, y float64) bool { return b.x0 <= x && x <= b.x1 && b.y0 <= y && y <= b.y1 }
func (b box) center() (float64, float64) { return (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2 }
func (b box) area() float64              { return (b.x1 - b.x0) * (b.y1 - b.y0) }

// sameObject says whether two regions frame the same gauge. A declared dial
// region often covers the whole face and more, a declared display only its
// digits while the detector frames the bezel: the regions match when each
// centre lies in the other region and their sizes are of the same order.
func sameObject(a, b []int32) bool {
	p, okP := boxOf(a)
	q, okQ := boxOf(b)
	if !okP || !okQ {
		return false
	}
	px, py := p.center()
	qx, qy := q.center()
	ratio := p.area() / q.area()
	return q.contains(px, py) && p.contains(qx, qy) && ratio > 0.1 && ratio < 10
}

// planScan sorts the detections of one scan into sightings of declared
// gauges, candidates found again and new candidates.
func planScan(detections []Detection, declared []declaredGauge, existing []Candidate) scanPlan {
	plan := scanPlan{Updates: map[int64]Detection{}, Accepted: map[int64]GaugeRef{}}
	sighted := map[GaugeRef]bool{}
	for _, d := range detections {
		onGauge := false
		for _, g := range declared {
			if sameObject(d.ROI, g.ROI) {
				onGauge = true
				if !sighted[g.GaugeRef] {
					sighted[g.GaugeRef] = true
					plan.Sighted = append(plan.Sighted, g.GaugeRef)
				}
			}
		}
		if onGauge {
			continue
		}
		found := false
		for _, c := range existing {
			if !sameObject(d.ROI, c.ROI) {
				continue
			}
			found = true
			// Two detections of one candidate in a scan: the better one counts.
			if prev, ok := plan.Updates[c.ID]; !ok || d.Score > prev.Score {
				plan.Updates[c.ID] = d
			}
			break
		}
		if found {
			continue
		}
		duplicate := false
		for i, n := range plan.Inserts {
			if sameObject(d.ROI, n.ROI) {
				duplicate = true
				if d.Score > n.Score {
					plan.Inserts[i] = d
				}
				break
			}
		}
		if !duplicate {
			plan.Inserts = append(plan.Inserts, d)
		}
	}
	for _, c := range existing {
		on := false
		for _, g := range declared {
			if sameObject(c.ROI, g.ROI) {
				on = true
				if c.Status == candidatePending {
					plan.Accepted[c.ID] = g.GaugeRef
				}
				break
			}
		}
		if !on && c.Status == candidateAccepted {
			plan.Reopened = append(plan.Reopened, c.ID)
		}
	}
	return plan
}

// DiscoveryStore persists candidates, scans and sightings.
type DiscoveryStore interface {
	// Candidates lists the candidates of a camera, or of every camera for "".
	Candidates(ctx context.Context, cameraID string) ([]Candidate, error)
	ApplyScan(ctx context.Context, scan CameraScan, plan scanPlan) error
	SetCandidateStatus(ctx context.Context, id int64, status string) (Candidate, error)
	Scans(ctx context.Context) ([]CameraScan, error)
	Sightings(ctx context.Context) ([]Sighting, error)
}

// PgDiscoveryStore is the PostgreSQL implementation.
type PgDiscoveryStore struct{ pool *pgxpool.Pool }

func NewPgDiscoveryStore(pool *pgxpool.Pool) *PgDiscoveryStore { return &PgDiscoveryStore{pool: pool} }

const candidateColumns = `candidate_id, camera_id, roi, type, score, hint, crop_jpeg, seen, first_seen, last_seen,
	status, machine_id, gauge_id, decided_at`

func scanCandidate(row pgx.Row) (Candidate, error) {
	var c Candidate
	var hint []byte
	err := row.Scan(&c.ID, &c.CameraID, &c.ROI, &c.Type, &c.Score, &hint, &c.CropJPEG, &c.Seen, &c.FirstSeen, &c.LastSeen,
		&c.Status, &c.MachineID, &c.GaugeID, &c.DecidedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Candidate{}, ErrCandidateNotFound
	}
	c.Hint = hint
	return c, err
}

func (p *PgDiscoveryStore) Candidates(ctx context.Context, cameraID string) ([]Candidate, error) {
	rows, err := p.pool.Query(ctx, `SELECT `+candidateColumns+` FROM gauge_candidate
		WHERE $1 = '' OR camera_id = $1 ORDER BY camera_id, candidate_id`, cameraID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Candidate
	for rows.Next() {
		c, err := scanCandidate(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func hintOrEmpty(h json.RawMessage) []byte {
	if len(h) == 0 {
		return []byte(`{}`)
	}
	return h
}

func (p *PgDiscoveryStore) ApplyScan(ctx context.Context, scan CameraScan, plan scanPlan) error {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	at := scan.ScannedAt
	if _, err := tx.Exec(ctx, `
		INSERT INTO camera_scan (camera_id, scanned_at, width, height, detections) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (camera_id) DO UPDATE SET scanned_at = EXCLUDED.scanned_at, width = EXCLUDED.width,
		  height = EXCLUDED.height, detections = EXCLUDED.detections`,
		scan.CameraID, at, scan.Width, scan.Height, scan.Detections); err != nil {
		return err
	}
	for _, g := range plan.Sighted {
		if _, err := tx.Exec(ctx, `
			INSERT INTO gauge_sighting (machine_id, gauge_id, last_seen) VALUES ($1, $2, $3)
			ON CONFLICT (machine_id, gauge_id) DO UPDATE SET last_seen = EXCLUDED.last_seen`, g.MachineID, g.GaugeID, at); err != nil {
			return err
		}
	}
	for id, d := range plan.Updates {
		// A pending candidate follows the detector; a decided one only counts the sightings.
		if _, err := tx.Exec(ctx, `
			UPDATE gauge_candidate SET seen = seen + 1, last_seen = $2, score = (score * seen + $3) / (seen + 1),
			  roi = CASE WHEN status = 'pending' THEN $4 ELSE roi END,
			  type = CASE WHEN status = 'pending' THEN $5 ELSE type END,
			  hint = CASE WHEN status = 'pending' THEN $6::jsonb ELSE hint END,
			  crop_jpeg = CASE WHEN status = 'pending' AND $7::bytea IS NOT NULL THEN $7 ELSE crop_jpeg END
			WHERE candidate_id = $1`, id, at, d.Score, d.ROI, d.Type, hintOrEmpty(d.Hint), d.CropJPEG); err != nil {
			return err
		}
	}
	for _, d := range plan.Inserts {
		if _, err := tx.Exec(ctx, `
			INSERT INTO gauge_candidate (camera_id, roi, type, score, hint, crop_jpeg, first_seen, last_seen)
			VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $7)`, scan.CameraID, d.ROI, d.Type, d.Score, hintOrEmpty(d.Hint), d.CropJPEG, at); err != nil {
			return err
		}
	}
	for _, id := range plan.Reopened {
		if _, err := tx.Exec(ctx, `
			UPDATE gauge_candidate SET status = 'pending', machine_id = NULL, gauge_id = NULL, decided_at = NULL
			WHERE candidate_id = $1 AND status = 'accepted'`, id); err != nil {
			return err
		}
	}
	for id, g := range plan.Accepted {
		if _, err := tx.Exec(ctx, `
			UPDATE gauge_candidate SET status = 'accepted', machine_id = $2, gauge_id = $3, decided_at = $4
			WHERE candidate_id = $1 AND status = 'pending'`, id, g.MachineID, g.GaugeID, at); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (p *PgDiscoveryStore) SetCandidateStatus(ctx context.Context, id int64, status string) (Candidate, error) {
	return scanCandidate(p.pool.QueryRow(ctx, `
		UPDATE gauge_candidate SET status = $2, machine_id = NULL, gauge_id = NULL,
		  decided_at = CASE WHEN $2 = 'pending' THEN NULL ELSE now() END
		WHERE candidate_id = $1 RETURNING `+candidateColumns, id, status))
}

func (p *PgDiscoveryStore) Scans(ctx context.Context) ([]CameraScan, error) {
	rows, err := p.pool.Query(ctx, `SELECT camera_id, scanned_at, width, height, detections FROM camera_scan ORDER BY camera_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CameraScan
	for rows.Next() {
		var s CameraScan
		if err := rows.Scan(&s.CameraID, &s.ScannedAt, &s.Width, &s.Height, &s.Detections); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (p *PgDiscoveryStore) Sightings(ctx context.Context) ([]Sighting, error) {
	rows, err := p.pool.Query(ctx, `SELECT machine_id, gauge_id, last_seen FROM gauge_sighting ORDER BY machine_id, gauge_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Sighting
	for rows.Next() {
		var s Sighting
		if err := rows.Scan(&s.MachineID, &s.GaugeID, &s.LastSeen); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// Discovery is the REST interface of gauge discovery.
type Discovery struct {
	store    DiscoveryStore
	cameras  CameraStore
	stations Store
	api      *API
	now      func() time.Time
	// MinSeen is the number of scans that must find a candidate before it is
	// proposed: something carried past the camera is found once.
	MinSeen int
	// MinScore is the mean detector score a candidate must have to be
	// proposed. It is above the threshold of discover-svc: a weak detection
	// still tells that a declared gauge is in view, but labels and screws
	// score weakly too and are not worth a person's time.
	MinScore float32
	// LostAfter is how long a scan of its camera may go on without finding a
	// declared gauge that was found before, before the gauge is reported lost.
	LostAfter time.Duration
}

func NewDiscovery(store DiscoveryStore, cameras CameraStore, stations Store, api *API) *Discovery {
	return &Discovery{store: store, cameras: cameras, stations: stations, api: api, now: time.Now, MinSeen: 3, MinScore: 0.3, LostAfter: 15 * time.Minute}
}

func (d *Discovery) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/discovery/scans", d.api.wrap(d.scan))
	mux.HandleFunc("GET /v1/discovery/candidates", d.api.wrap(d.list))
	mux.HandleFunc("POST /v1/discovery/candidates/{id}/ignore", d.api.wrap(d.setStatus(candidateIgnored)))
	mux.HandleFunc("POST /v1/discovery/candidates/{id}/restore", d.api.wrap(d.setStatus(candidatePending)))
	mux.HandleFunc("GET /v1/discovery/gauges", d.api.wrap(d.gauges))
}

func (d *Discovery) fail(w http.ResponseWriter, err error) int {
	switch {
	case errors.Is(err, ErrCandidateNotFound):
		return writeJSON(w, http.StatusNotFound, apiError{Error: "candidate not found"})
	case errors.Is(err, ErrCameraNotFound):
		return writeJSON(w, http.StatusNotFound, apiError{Error: "camera not found"})
	}
	return d.api.fail(w, err)
}

// declared lists the gauges of every station config with the camera they
// are on (a gauge without camera_id is on the default camera of its config).
func (d *Discovery) declared(ctx context.Context) (map[string][]declaredGauge, error) {
	stations, err := d.stations.List(ctx)
	if err != nil {
		return nil, err
	}
	out := map[string][]declaredGauge{}
	for _, s := range stations {
		cfg, err := ParseConfig(s.Config)
		if err != nil {
			continue
		}
		for _, g := range cfg.GetGauges() {
			camera := g.GetCameraId()
			if camera == "" {
				camera = cfg.GetCamera().GetCameraId()
			}
			out[camera] = append(out[camera], declaredGauge{GaugeRef{s.MachineID, g.GetGaugeId()}, g.GetRoi()})
		}
	}
	return out, nil
}

type scanRequest struct {
	CameraID   string      `json:"camera_id"`
	Width      int         `json:"width"`
	Height     int         `json:"height"`
	Detections []Detection `json:"detections"`
}

func validScan(s scanRequest) []string {
	var problems []string
	if s.Width <= 0 || s.Height <= 0 {
		problems = append(problems, "width and height of the frame are required")
	}
	if len(s.Detections) > maxDetections {
		problems = append(problems, "at most "+strconv.Itoa(maxDetections)+" detections per scan")
	}
	for i, det := range s.Detections {
		at := "detections[" + strconv.Itoa(i) + "]: "
		b, ok := boxOf(det.ROI)
		if !ok || b.x0 < 0 || b.y0 < 0 || b.x1 > float64(s.Width) || b.y1 > float64(s.Height) {
			problems = append(problems, at+"roi must be x, y, w, h inside the frame")
		}
		if !detectableTypes[det.Type] {
			problems = append(problems, at+"unknown type "+strconv.Quote(det.Type))
		}
		if det.Score < 0 || det.Score > 1 {
			problems = append(problems, at+"score must be between 0 and 1")
		}
		if len(det.CropJPEG) > maxCropBytes {
			problems = append(problems, at+"crop_jpeg is too large")
		}
		if len(det.Hint) > 0 && !json.Valid(det.Hint) {
			problems = append(problems, at+"hint must be a JSON object")
		}
	}
	return problems
}

// scan records what discover-svc found on a frame of a camera.
func (d *Discovery) scan(w http.ResponseWriter, r *http.Request) int {
	var req scanRequest
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxScanBody))
	if err == nil {
		err = json.Unmarshal(body, &req)
	}
	if err != nil {
		return writeJSON(w, http.StatusBadRequest, apiError{Error: "invalid JSON body: " + err.Error()})
	}
	if problems := validScan(req); len(problems) > 0 {
		return writeJSON(w, http.StatusBadRequest, apiError{Error: "invalid scan", Details: problems})
	}
	if _, err := d.cameras.GetCamera(r.Context(), req.CameraID); err != nil {
		return d.fail(w, err)
	}
	declared, err := d.declared(r.Context())
	if err != nil {
		return d.fail(w, err)
	}
	existing, err := d.store.Candidates(r.Context(), req.CameraID)
	if err != nil {
		return d.fail(w, err)
	}
	plan := planScan(req.Detections, declared[req.CameraID], existing)
	scan := CameraScan{CameraID: req.CameraID, ScannedAt: d.now().UTC(), Width: req.Width, Height: req.Height, Detections: len(req.Detections)}
	if err := d.store.ApplyScan(r.Context(), scan, plan); err != nil {
		return d.fail(w, err)
	}
	return writeJSON(w, http.StatusOK, map[string]int{
		"sighted": len(plan.Sighted), "found_again": len(plan.Updates), "new": len(plan.Inserts), "accepted": len(plan.Accepted),
		"reopened": len(plan.Reopened),
	})
}

// list answers the candidates of ?status= (pending by default) and, with
// ?camera_id=, of one camera. A pending candidate is listed once enough
// scans found it with a good enough score, and no longer once a gauge is
// declared on it.
func (d *Discovery) list(w http.ResponseWriter, r *http.Request) int {
	status := r.URL.Query().Get("status")
	if status == "" {
		status = candidatePending
	}
	if status != candidatePending && status != candidateAccepted && status != candidateIgnored {
		return writeJSON(w, http.StatusBadRequest, apiError{Error: "status must be pending, accepted or ignored"})
	}
	all, err := d.store.Candidates(r.Context(), r.URL.Query().Get("camera_id"))
	if err != nil {
		return d.fail(w, err)
	}
	declared, err := d.declared(r.Context())
	if err != nil {
		return d.fail(w, err)
	}
	out := []Candidate{}
	for _, c := range all {
		if c.Status != status {
			continue
		}
		if status == candidatePending {
			if c.Seen < d.MinSeen || c.Score < d.MinScore || onDeclared(c, declared[c.CameraID]) {
				continue
			}
		}
		out = append(out, c)
	}
	return writeJSON(w, http.StatusOK, map[string]any{"candidates": out, "min_seen": d.MinSeen, "min_score": d.MinScore})
}

func onDeclared(c Candidate, declared []declaredGauge) bool {
	for _, g := range declared {
		if sameObject(c.ROI, g.ROI) {
			return true
		}
	}
	return false
}

func (d *Discovery) setStatus(status string) func(http.ResponseWriter, *http.Request) int {
	return func(w http.ResponseWriter, r *http.Request) int {
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			return writeJSON(w, http.StatusBadRequest, apiError{Error: "candidate id must be a number"})
		}
		c, err := d.store.SetCandidateStatus(r.Context(), id, status)
		if err != nil {
			return d.fail(w, err)
		}
		return writeJSON(w, http.StatusOK, c)
	}
}

// Sighting states of a declared gauge.
const (
	sightSeen      = "seen"      // the last scans of its camera found it
	sightLost      = "lost"      // found before, missing from the scans of the last LostAfter
	sightNever     = "never"     // no scan found it: the detector may not know this kind of gauge
	sightUnscanned = "unscanned" // its camera was never scanned
)

type gaugeSight struct {
	GaugeRef
	CameraID  string     `json:"camera_id"`
	State     string     `json:"state"`
	LastSeen  *time.Time `json:"last_seen"`
	ScannedAt *time.Time `json:"scanned_at"`
}

// sightState says whether the scans of a camera still find a gauge.
func sightState(lastSeen, scannedAt *time.Time, lostAfter time.Duration) string {
	switch {
	case scannedAt == nil:
		return sightUnscanned
	case lastSeen == nil:
		return sightNever
	case scannedAt.Sub(*lastSeen) > lostAfter:
		return sightLost
	}
	return sightSeen
}

// gauges answers, for every declared gauge, whether the detector still finds it.
func (d *Discovery) gauges(w http.ResponseWriter, r *http.Request) int {
	declared, err := d.declared(r.Context())
	if err != nil {
		return d.fail(w, err)
	}
	scans, err := d.store.Scans(r.Context())
	if err != nil {
		return d.fail(w, err)
	}
	sightings, err := d.store.Sightings(r.Context())
	if err != nil {
		return d.fail(w, err)
	}
	scanned := map[string]time.Time{}
	for _, s := range scans {
		scanned[s.CameraID] = s.ScannedAt
	}
	seen := map[GaugeRef]time.Time{}
	for _, s := range sightings {
		seen[s.GaugeRef] = s.LastSeen
	}
	out := []gaugeSight{}
	for camera, gauges := range declared {
		for _, g := range gauges {
			v := gaugeSight{GaugeRef: g.GaugeRef, CameraID: camera}
			if t, ok := seen[g.GaugeRef]; ok {
				v.LastSeen = &t
			}
			if t, ok := scanned[camera]; ok {
				v.ScannedAt = &t
			}
			v.State = sightState(v.LastSeen, v.ScannedAt, d.LostAfter)
			out = append(out, v)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].MachineID != out[j].MachineID {
			return out[i].MachineID < out[j].MachineID
		}
		return out[i].GaugeID < out[j].GaugeID
	})
	return writeJSON(w, http.StatusOK, map[string]any{"gauges": out, "scans": nonNil(scans), "lost_after_s": int(d.LostAfter / time.Second)})
}

func nonNil(s []CameraScan) []CameraScan {
	if s == nil {
		return []CameraScan{}
	}
	return s
}
