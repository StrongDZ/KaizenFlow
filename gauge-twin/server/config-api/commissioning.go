package main

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	"gauge-twin/edge/decode"
	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

// Commissioning (SPEC section 5, GD7): a page to set up a station from a
// camera frame. preview-svc runs the models (the inference of ds-sim, same
// preprocess.json); the decoding below is the package edge-agent uses, so the
// preview reads exactly as the edge will.

//go:embed web
var webFiles embed.FS

// Frames are base64 JPEG in JSON: a 4K frame is a few MB.
const maxCommissioningBody = 32 << 20

// Commissioning serves the page and its API.
type Commissioning struct {
	store   Store
	preview string // base URL of preview-svc
	client  *http.Client
}

func NewCommissioning(store Store, previewURL string) *Commissioning {
	return &Commissioning{store: store, preview: previewURL, client: &http.Client{Timeout: 30 * time.Second}}
}

func (c *Commissioning) Register(mux *http.ServeMux) {
	static, _ := fs.Sub(webFiles, "web")
	mux.Handle("GET /commissioning/", http.StripPrefix("/commissioning/", http.FileServerFS(static)))
	mux.Handle("GET /commissioning", http.RedirectHandler("/commissioning/", http.StatusMovedPermanently))
	mux.HandleFunc("POST /v1/commissioning/frame", c.frame)
	mux.HandleFunc("POST /v1/commissioning/rectify", c.rectify)
	mux.HandleFunc("POST /v1/commissioning/preview", c.previewReading)
}

// errPreview carries the status preview-svc answered with.
type errPreview struct {
	code int
	msg  string
}

func (e *errPreview) Error() string { return e.msg }

// call posts a JSON body to preview-svc and decodes the JSON answer.
func (c *Commissioning) call(ctx context.Context, path string, body any, out any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.preview+path, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.client.Do(req)
	if err != nil {
		return &errPreview{code: http.StatusServiceUnavailable, msg: "preview-svc unreachable: " + err.Error()}
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxCommissioningBody))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		var e apiError
		_ = json.Unmarshal(raw, &e)
		if e.Error == "" {
			e.Error = resp.Status
		}
		// 400 stays a client error; anything else is the camera or preview-svc.
		code := http.StatusBadGateway
		if resp.StatusCode == http.StatusBadRequest {
			code = http.StatusBadRequest
		}
		return &errPreview{code: code, msg: e.Error}
	}
	return json.Unmarshal(raw, out)
}

func (c *Commissioning) fail(w http.ResponseWriter, err error) {
	var pe *errPreview
	if errors.As(err, &pe) {
		writeJSON(w, pe.code, apiError{Error: pe.msg})
		return
	}
	writeJSON(w, http.StatusInternalServerError, apiError{Error: err.Error()})
}

func readBody(w http.ResponseWriter, r *http.Request, out any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxCommissioningBody)).Decode(out); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "invalid JSON body: " + err.Error()})
		return false
	}
	return true
}

// frame grabs one frame. The camera is the url in the body, or the one in
// the stored config of machine_id.
func (c *Commissioning) frame(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL       string `json:"url"`
		MachineID string `json:"machine_id"`
	}
	if !readBody(w, r, &req) {
		return
	}
	if req.URL == "" && req.MachineID != "" {
		stored, err := c.store.Get(r.Context(), req.MachineID)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				writeJSON(w, http.StatusNotFound, apiError{Error: "no config for " + req.MachineID})
				return
			}
			c.fail(w, err)
			return
		}
		cfg, err := ParseConfig(stored.Config)
		if err != nil {
			c.fail(w, err)
			return
		}
		req.URL = cfg.GetCamera().GetUrl()
	}
	if req.URL == "" {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "url or machine_id is required"})
		return
	}
	var out map[string]any
	if err := c.call(r.Context(), "/v1/frame", map[string]string{"url": req.URL}, &out); err != nil {
		c.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// rectify returns the quad warped onto the square in which calib points are
// given, so they can be clicked directly.
func (c *Commissioning) rectify(w http.ResponseWriter, r *http.Request) {
	var req map[string]any
	if !readBody(w, r, &req) {
		return
	}
	var out map[string]any
	if err := c.call(r.Context(), "/v1/rectify", req, &out); err != nil {
		c.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// GaugePreview is the reading of one gauge on one frame.
type GaugePreview struct {
	GaugeID string `json:"gauge_id"`
	// Error is set when the gauge config cannot be decoded yet (e.g. calib
	// points missing); the other fields are then empty.
	Error      string   `json:"error,omitempty"`
	Value      *float64 `json:"value,omitempty"`
	Unit       string   `json:"unit,omitempty"`
	Quality    float32  `json:"quality"`
	Flags      []string `json:"flags,omitempty"`
	Confidence float64  `json:"confidence"`
	Sharpness  float64  `json:"sharpness"`
	Glare      float64  `json:"glare"`
	// Dial keypoints (center, start, end, mid, tip) in frame pixels, to draw.
	Keypoints [][2]float64 `json:"keypoints,omitempty"`
}

// previewReading reads every gauge of a draft config on one frame: the frame
// sent along, or a fresh one from the camera (live preview).
func (c *Commissioning) previewReading(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Config    json.RawMessage `json:"config"`
		FrameJPEG string          `json:"frame_jpeg"`
	}
	if !readBody(w, r, &req) {
		return
	}
	cfg, err := ParseConfig(req.Config)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	var out struct {
		FrameJPEG   string          `json:"frame_jpeg"`
		FrameResult json.RawMessage `json:"frame_result"`
	}
	if err := c.call(r.Context(), "/v1/infer", map[string]any{"config": req.Config, "frame_jpeg": req.FrameJPEG}, &out); err != nil {
		c.fail(w, err)
		return
	}
	var result gaugev1.FrameResult
	if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(out.FrameResult, &result); err != nil {
		c.fail(w, fmt.Errorf("frame result from preview-svc: %w", err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"frame_jpeg": out.FrameJPEG, // empty when the caller sent the frame
		"ts_ms":      result.GetFrameTsMs(),
		"gauges":     ReadGauges(cfg, &result),
	})
}

// ReadGauges decodes a FrameResult for every gauge of the config, as one
// window of one frame on the edge.
func ReadGauges(cfg *gaugev1.StationConfig, result *gaugev1.FrameResult) []GaugePreview {
	rois := map[string]*gaugev1.RoiResult{}
	for _, roi := range result.GetRois() {
		rois[roi.GetGaugeId()] = roi
	}
	opt := decode.DefaultOptions()
	out := make([]GaugePreview, 0, len(cfg.GetGauges()))
	for _, gc := range cfg.GetGauges() {
		p := GaugePreview{GaugeID: gc.GetGaugeId(), Unit: gc.GetUnit()}
		gauge, err := decode.NewGauge(gc)
		if err != nil {
			p.Error = err.Error()
			out = append(out, p)
			continue
		}
		roi, ok := rois[gc.GetGaugeId()]
		if !ok {
			p.Error = "roi outside the frame"
			out = append(out, p)
			continue
		}
		reading := gauge.Read(result.GetFrameTsMs(), roi, opt)
		agg := decode.NewAggregator(gauge, opt)
		agg.Add(reading)
		m := agg.Close(result.GetFrameTsMs(), false).Measurement
		p.Value, p.Quality = m.Value, m.GetQuality()
		p.Confidence, p.Sharpness, p.Glare = reading.Confidence, reading.Sharpness, reading.Glare
		for _, f := range m.GetFlags() {
			p.Flags = append(p.Flags, f.String())
		}
		for _, kp := range roi.GetKeypoints() {
			p.Keypoints = append(p.Keypoints, [2]float64{float64(kp.GetX()), float64(kp.GetY())})
		}
		out = append(out, p)
	}
	return out
}
