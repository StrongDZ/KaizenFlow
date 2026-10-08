package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// Limits of the series route: the window in minutes and the number of points
// one answer carries.
const (
	defaultSeriesMinutes = 15
	maxSeriesMinutes     = 240
	maxSeriesPoints      = 300
)

// A frame is a base64 JPEG of a full camera image.
const maxFrameBody = 16 << 20

// API is the read-only REST interface of the live monitoring UI.
type API struct {
	store      Store
	preview    string
	corsOrigin string
	staleAfter time.Duration
	lookback   time.Duration
	now        func() time.Time
	client     *http.Client
	logger     *slog.Logger
	requests   *prometheus.CounterVec
	// live serves the live view; nil when the service has no MQTT broker.
	live   *LiveFrames
	stills *Stills
}

func NewAPI(store Store, previewURL, corsOrigin string, staleAfter, lookback time.Duration, now func() time.Time,
	reg prometheus.Registerer, logger *slog.Logger) *API {
	a := &API{store: store, preview: previewURL, corsOrigin: corsOrigin, staleAfter: staleAfter, lookback: lookback,
		now: now, client: &http.Client{Timeout: 30 * time.Second}, logger: logger,
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "query_api_requests_total", Help: "REST requests, by route and status code."}, []string{"route", "code"})}
	reg.MustRegister(a.requests)
	a.stills = NewStills(now, a.pullFrame)
	return a
}

// Register adds the routes to mux.
func (a *API) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/live/stations", a.wrap("stations", a.list))
	mux.HandleFunc("GET /v1/live/stations/{machine_id}", a.wrap("station", a.get))
	mux.HandleFunc("GET /v1/stations/{machine_id}/series", a.wrap("series", a.series))
	mux.HandleFunc("GET /v1/stations/{machine_id}/history", a.wrap("history", a.history))
	mux.HandleFunc("GET /v1/stations/{machine_id}/frame", a.wrap("frame", a.frame))
	mux.HandleFunc("GET /v1/stations/{machine_id}/live-frame", a.wrap("live_frame", a.liveFrame))
}

type apiError struct {
	Error string `json:"error"`
}

// wrap counts the request and lets the UI, served from another origin, read
// the answer.
func (a *API) wrap(route string, handler func(http.ResponseWriter, *http.Request) int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", a.corsOrigin)
		code := handler(w, r)
		a.requests.WithLabelValues(route, strconv.Itoa(code)).Inc()
	}
}

func writeJSON(w http.ResponseWriter, code int, body any) int {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
	return code
}

func (a *API) fail(w http.ResponseWriter, err error) int {
	if errors.Is(err, ErrNotFound) {
		return writeJSON(w, http.StatusNotFound, apiError{Error: "station not found"})
	}
	a.logger.Error("request failed", "error", err)
	return writeJSON(w, http.StatusInternalServerError, apiError{Error: "internal error"})
}

type edgeView struct {
	EdgeID   string     `json:"edge_id"`
	Status   string     `json:"status"`
	LastSeen *time.Time `json:"last_seen"`
}

type gaugeView struct {
	GaugeID string    `json:"gauge_id"`
	Type    string    `json:"type"`
	Unit    string    `json:"unit"`
	ROI     []float64 `json:"roi"`
	// CameraID is the camera whose frame the roi is in; empty is the default one.
	CameraID string   `json:"camera_id"`
	Min      *float64 `json:"min"`
	Max      *float64 `json:"max"`
	State    string   `json:"state"`
	// The fields below are null until the gauge has a reading in the lookback.
	TS      *time.Time `json:"ts"`
	Value   *float64   `json:"value"`
	VMin    *float64   `json:"v_min"`
	VMax    *float64   `json:"v_max"`
	NFrames *int32     `json:"n_frames"`
	Quality *float32   `json:"quality"`
	Flags   []string   `json:"flags"`
}

type stationView struct {
	MachineID     string    `json:"machine_id"`
	Plant         string    `json:"plant"`
	Line          string    `json:"line"`
	ConfigVersion uint32    `json:"config_version"`
	State         string    `json:"state"`
	Edge          *edgeView `json:"edge"`
	// Cameras are the ids of the cameras the gauges are on (empty: the
	// default camera); the frame route takes one as ?camera=.
	Cameras []string    `json:"cameras"`
	Gauges  []gaugeView `json:"gauges"`
}

type seriesView struct {
	MachineID string  `json:"machine_id"`
	GaugeID   string  `json:"gauge_id"`
	Points    []Point `json:"points"`
}

// views joins the configured stations with the latest readings and the edges.
func (a *API) views(ctx context.Context, machineID string) ([]stationView, error) {
	stations, err := a.store.Stations(ctx, machineID)
	if err != nil {
		return nil, err
	}
	now := a.now()
	latest, err := a.store.Latest(ctx, now.Add(-a.lookback))
	if err != nil {
		return nil, err
	}
	edges, err := a.store.Edges(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]stationView, 0, len(stations))
	for _, s := range stations {
		view := stationView{MachineID: s.MachineID, Plant: s.Plant, Line: s.Line, ConfigVersion: s.ConfigVersion,
			Cameras: make([]string, 0, len(s.Cameras)), Gauges: make([]gaugeView, 0, len(s.Gauges))}
		for _, c := range s.Cameras {
			view.Cameras = append(view.Cameras, c.ID)
		}
		if e, ok := edges[s.MachineID]; ok {
			view.Edge = &edgeView{EdgeID: e.EdgeID, Status: e.Status, LastSeen: e.LastSeen}
		}
		states := make([]string, 0, len(s.Gauges))
		for _, g := range s.Gauges {
			gv := gaugeView{GaugeID: g.GaugeID, Type: g.Type, Unit: g.Unit, ROI: g.ROI, CameraID: g.CameraID,
				Min: g.Rules.Min, Max: g.Rules.Max, Flags: []string{}}
			var reading *Reading
			if r, ok := latest[GaugeKey{s.MachineID, g.GaugeID}]; ok {
				reading = &r
				gv.TS, gv.Value, gv.VMin, gv.VMax = &r.TS, r.Value, r.VMin, r.VMax
				gv.NFrames, gv.Quality, gv.Flags = r.NFrames, r.Quality, flagNames(r.Flags)
			}
			gv.State = gaugeState(reading, now, g.staleLimit(a.staleAfter, a.lookback))
			states = append(states, gv.State)
			view.Gauges = append(view.Gauges, gv)
		}
		view.State = stationState(states)
		out = append(out, view)
	}
	return out, nil
}

func (a *API) list(w http.ResponseWriter, r *http.Request) int {
	views, err := a.views(r.Context(), "")
	if err != nil {
		return a.fail(w, err)
	}
	return writeJSON(w, http.StatusOK, views)
}

func (a *API) get(w http.ResponseWriter, r *http.Request) int {
	views, err := a.views(r.Context(), r.PathValue("machine_id"))
	if err != nil {
		return a.fail(w, err)
	}
	if len(views) == 0 {
		return a.fail(w, ErrNotFound)
	}
	return writeJSON(w, http.StatusOK, views[0])
}

func (a *API) series(w http.ResponseWriter, r *http.Request) int {
	gauge := r.URL.Query().Get("gauge")
	if gauge == "" {
		return writeJSON(w, http.StatusBadRequest, apiError{Error: "gauge is required"})
	}
	minutes := defaultSeriesMinutes
	if raw := r.URL.Query().Get("minutes"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil {
			return writeJSON(w, http.StatusBadRequest, apiError{Error: "minutes must be an integer"})
		}
		minutes = min(max(n, 1), maxSeriesMinutes)
	}
	window := time.Duration(minutes) * time.Minute
	// Whole seconds, rounded up, so that the answer never exceeds maxSeriesPoints.
	bucket := (window + maxSeriesPoints*time.Second - 1) / (maxSeriesPoints * time.Second) * time.Second
	machine := r.PathValue("machine_id")
	points, err := a.store.Series(r.Context(), machine, gauge, a.now().Add(-window), bucket)
	if err != nil {
		return a.fail(w, err)
	}
	if points == nil {
		points = []Point{}
	}
	return writeJSON(w, http.StatusOK, seriesView{MachineID: machine, GaugeID: gauge, Points: points})
}

// frame answers one frame of a camera of the station (?camera= its id, the
// default camera without it), pulled by preview-svc. The edge sends no images;
// this is one frame, on request. With ?max_age= seconds a frame pulled that
// recently is good enough, which is what a thumbnail needs.
func (a *API) frame(w http.ResponseWriter, r *http.Request) int {
	stations, err := a.store.Stations(r.Context(), r.PathValue("machine_id"))
	if err != nil {
		return a.fail(w, err)
	}
	if len(stations) == 0 {
		return a.fail(w, ErrNotFound)
	}
	url := ""
	for _, c := range stations[0].Cameras {
		if c.ID == r.URL.Query().Get("camera") {
			url = c.URL
		}
	}
	if url == "" {
		return writeJSON(w, http.StatusNotFound, apiError{Error: "station has no such camera"})
	}
	maxAge := time.Duration(0)
	if raw := r.URL.Query().Get("max_age"); raw != "" {
		seconds, err := strconv.Atoi(raw)
		if err != nil || seconds < 0 {
			return writeJSON(w, http.StatusBadRequest, apiError{Error: "max_age must be a number of seconds"})
		}
		maxAge = min(time.Duration(seconds)*time.Second, maxStillAge)
	}
	raw, err := a.stills.Get(r.Context(), url, maxAge)
	var failed *previewError
	switch {
	case errors.As(err, &failed):
		return writeJSON(w, http.StatusBadGateway, apiError{Error: failed.message})
	case err != nil:
		return a.fail(w, err)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
	return http.StatusOK
}

// WarmStills pulls a frame of every camera in use once per period until ctx
// ends, so that the thumbnails of the overview are answered from memory. One
// camera at a time: a frame every few minutes is no load on a camera.
func (a *API) WarmStills(ctx context.Context, every time.Duration) {
	for {
		a.warmStills(ctx, every)
		select {
		case <-ctx.Done():
			return
		case <-time.After(every):
		}
	}
}

// warmStills refreshes the frames older than maxAge, each camera once
// whatever the number of machines it serves.
func (a *API) warmStills(ctx context.Context, maxAge time.Duration) {
	stations, err := a.store.Stations(ctx, "")
	if err != nil {
		a.logger.Warn("thumbnails: stations", "error", err)
		return
	}
	seen := map[string]bool{}
	for _, s := range stations {
		for _, c := range s.Cameras {
			if seen[c.URL] || ctx.Err() != nil {
				continue
			}
			seen[c.URL] = true
			if _, err := a.stills.Get(ctx, c.URL, maxAge); err != nil {
				a.logger.Debug("thumbnails: camera", "camera_id", c.ID, "error", err)
			}
		}
	}
}

// previewError is a failure of preview-svc or of the camera behind it.
type previewError struct{ message string }

func (e *previewError) Error() string { return e.message }

// pullFrame asks preview-svc for one frame of a camera.
func (a *API) pullFrame(ctx context.Context, url string) ([]byte, error) {
	payload, _ := json.Marshal(map[string]string{"url": url})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.preview+"/v1/frame", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.client.Do(req)
	if err != nil {
		return nil, &previewError{"preview-svc unreachable: " + err.Error()}
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxFrameBody))
	if err != nil {
		return nil, &previewError{"preview-svc: " + err.Error()}
	}
	if resp.StatusCode != http.StatusOK {
		var e apiError
		_ = json.Unmarshal(raw, &e)
		if e.Error == "" {
			e.Error = resp.Status
		}
		return nil, &previewError{e.Error}
	}
	return raw, nil
}

type liveReadingView struct {
	GaugeID    string   `json:"gauge_id"`
	Value      *float64 `json:"value"` // null when the gauge was not readable on this frame
	Confidence float64  `json:"confidence"`
}

type liveFrameView struct {
	MachineID string    `json:"machine_id"`
	CameraID  string    `json:"camera_id"`
	TS        time.Time `json:"ts"`
	FrameJPEG string    `json:"frame_jpeg"`
	// Size of the camera frame the roi coordinates are in (the image itself is smaller).
	Width    uint32            `json:"width"`
	Height   uint32            `json:"height"`
	Readings []liveReadingView `json:"readings"`
}

// liveFrame is the live view of one camera of a machine: the newest frame the
// edge sent, with what the edge read on that same frame. Asking for it is what
// keeps the edge sending; the frame lives in memory only.
func (a *API) liveFrame(w http.ResponseWriter, r *http.Request) int {
	if a.live == nil {
		return writeJSON(w, http.StatusServiceUnavailable, apiError{Error: "live view is not configured"})
	}
	stations, err := a.store.Stations(r.Context(), r.PathValue("machine_id"))
	if err != nil {
		return a.fail(w, err)
	}
	if len(stations) == 0 {
		return a.fail(w, ErrNotFound)
	}
	if err := a.live.Watch(r.Context(), stations[0]); err != nil {
		return writeJSON(w, http.StatusServiceUnavailable, apiError{Error: errNoBroker.Error()})
	}
	pv, ok := a.live.Latest(stations[0].MachineID, r.URL.Query().Get("camera"))
	if !ok {
		return writeJSON(w, http.StatusNotFound, apiError{Error: "no live frame yet"})
	}
	view := liveFrameView{
		MachineID: pv.GetMachineId(), CameraID: pv.GetCameraId(), TS: time.UnixMilli(pv.GetFrameTsMs()).UTC(),
		FrameJPEG: base64.StdEncoding.EncodeToString(pv.GetJpeg()), Width: pv.GetFrameWidth(), Height: pv.GetFrameHeight(),
		Readings: make([]liveReadingView, 0, len(pv.GetReadings())),
	}
	for _, rd := range pv.GetReadings() {
		view.Readings = append(view.Readings, liveReadingView{GaugeID: rd.GetGaugeId(), Value: rd.Value, Confidence: rd.GetConfidence()})
	}
	w.Header().Set("Cache-Control", "no-store")
	return writeJSON(w, http.StatusOK, view)
}
