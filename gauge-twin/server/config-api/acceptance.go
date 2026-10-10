package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	"gauge-twin/edge/decode"
	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

// Acceptance (commissioning, last step): the engineer standing at the gauge
// types what it shows, the edge decoder reads the same moment from the
// camera, and the two are compared. A gauge is accepted on the spot or sent
// back to calibration before its data ever reaches the database. Every
// sample keeps its frame: these are the only labelled images of the real
// plant, and the training set of the next model.

// AcceptanceRules decide when a sample and a gauge pass.
type AcceptanceRules struct {
	// DialTolerance is the largest error of a dial sample, as a share of full
	// scale. Wider than the 1.5% target of the model: a person reads a needle
	// to about half a minor tick.
	DialTolerance float64
	// MinSamples a gauge needs, all passing, to be accepted.
	MinSamples int
	// MinQuality is the quality below which the server leaves a reading out
	// of gauge_1m; a correct reading under it still delivers no data.
	MinQuality float32
}

func DefaultAcceptanceRules() AcceptanceRules {
	return AcceptanceRules{DialTolerance: 0.02, MinSamples: 3, MinQuality: 0.7}
}

// AcceptanceSample is one comparison of a typed value with a reading.
type AcceptanceSample struct {
	ID            string   `json:"id"`
	MachineID     string   `json:"machine_id"`
	GaugeID       string   `json:"gauge_id"`
	Type          string   `json:"type"`
	Unit          string   `json:"unit,omitempty"`
	TsMs          int64    `json:"ts_ms"`
	ConfigVersion uint32   `json:"config_version"`
	Truth         float64  `json:"truth"`
	Value         *float64 `json:"value,omitempty"`
	// Error is |value - truth|; Tolerance the largest error that passes.
	Error      *float64 `json:"error,omitempty"`
	Tolerance  float64  `json:"tolerance"`
	Passed     bool     `json:"passed"`
	Reason     string   `json:"reason,omitempty"`
	Quality    float32  `json:"quality"`
	QualityOK  bool     `json:"quality_ok"`
	Confidence float64  `json:"confidence"`
	Flags      []string `json:"flags,omitempty"`
	// FullScale of a dial, to express Error as a share of the range.
	FullScale float64 `json:"full_scale,omitempty"`
}

// Verdicts of a gauge.
const (
	VerdictAccepted   = "accepted"
	VerdictRejected   = "rejected"
	VerdictIncomplete = "incomplete"
)

// GaugeAcceptance sums up the samples of one gauge.
type GaugeAcceptance struct {
	GaugeID string `json:"gauge_id"`
	Verdict string `json:"verdict"`
	Passed  int    `json:"passed"`
	Failed  int    `json:"failed"`
	// LowQuality counts samples read correctly but below MinQuality: the
	// gauge would be right and still missing from gauge_1m.
	LowQuality int `json:"low_quality"`
	// Needed is how many more passing samples the gauge needs.
	Needed  int                `json:"needed"`
	Samples []AcceptanceSample `json:"samples"`
}

// judge fills the outcome of a sample from the reading of its gauge.
func judge(sample *AcceptanceSample, gauge *decode.Gauge, reading GaugePreview, rules AcceptanceRules) {
	sample.Quality, sample.Confidence, sample.Flags = reading.Quality, reading.Confidence, reading.Flags
	sample.QualityOK = reading.Quality >= rules.MinQuality
	if gauge.Type == decode.TypeDial {
		sample.FullScale = gauge.FullScale()
		sample.Tolerance = rules.DialTolerance * sample.FullScale
	} else {
		// A digit display is right or wrong: half a step of its last digit
		// only absorbs the rounding of the typed number.
		sample.Tolerance = gauge.Resolution() / 2
	}
	if reading.Value == nil {
		sample.Reason = "không đọc được"
		if len(reading.Flags) > 0 {
			sample.Reason += " (" + strings.Join(reading.Flags, ", ") + ")"
		}
		return
	}
	diff := math.Abs(*reading.Value - sample.Truth)
	sample.Value, sample.Error = reading.Value, &diff
	if diff > sample.Tolerance {
		sample.Reason = fmt.Sprintf("lệch %s, cho phép %s", trim(diff), trim(sample.Tolerance))
		return
	}
	sample.Passed = true
}

func trim(v float64) string { return strconv.FormatFloat(v, 'g', 4, 64) }

// SummariseAcceptance groups samples by gauge, oldest first, and gives each
// gauge its verdict: rejected as soon as one sample fails, accepted with
// MinSamples passing samples, incomplete in between.
func SummariseAcceptance(samples []AcceptanceSample, rules AcceptanceRules) []GaugeAcceptance {
	byGauge := map[string]*GaugeAcceptance{}
	var order []string
	sort.SliceStable(samples, func(i, j int) bool { return samples[i].TsMs < samples[j].TsMs })
	for _, s := range samples {
		g, ok := byGauge[s.GaugeID]
		if !ok {
			g = &GaugeAcceptance{GaugeID: s.GaugeID}
			byGauge[s.GaugeID] = g
			order = append(order, s.GaugeID)
		}
		g.Samples = append(g.Samples, s)
		switch {
		case !s.Passed:
			g.Failed++
		case !s.QualityOK:
			g.Passed++
			g.LowQuality++
		default:
			g.Passed++
		}
	}
	sort.Strings(order)
	out := make([]GaugeAcceptance, 0, len(order))
	for _, id := range order {
		g := byGauge[id]
		switch {
		case g.Failed > 0:
			g.Verdict = VerdictRejected
		case g.Passed >= rules.MinSamples:
			g.Verdict = VerdictAccepted
		default:
			g.Verdict = VerdictIncomplete
			g.Needed = rules.MinSamples - g.Passed
		}
		out = append(out, *g)
	}
	return out
}

// SampleStore keeps acceptance samples and their frames.
type SampleStore interface {
	Save(ctx context.Context, sample AcceptanceSample, jpeg []byte) error
	List(ctx context.Context, machineID string) ([]AcceptanceSample, error)
	// Delete removes every sample of a gauge (it is being commissioned again).
	Delete(ctx context.Context, machineID, gaugeID string) error
	// Frame returns the JPEG of a sample.
	Frame(ctx context.Context, machineID, gaugeID, id string) ([]byte, error)
}

// DirSampleStore keeps samples as <root>/<machine>/<gauge>/<id>.json and
// .jpg. Replicas share the directory; ids are checked identifiers, so the
// paths stay inside the root.
type DirSampleStore struct{ root string }

func NewDirSampleStore(root string) *DirSampleStore { return &DirSampleStore{root: root} }

func (d *DirSampleStore) dir(machineID, gaugeID string) (string, error) {
	if !identifier.MatchString(machineID) || !identifier.MatchString(gaugeID) {
		return "", fmt.Errorf("invalid machine or gauge id")
	}
	return filepath.Join(d.root, machineID, gaugeID), nil
}

// writeFile writes through a temporary name so a reader never sees half a file.
func writeFile(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (d *DirSampleStore) Save(_ context.Context, sample AcceptanceSample, jpeg []byte) error {
	dir, err := d.dir(sample.MachineID, sample.GaugeID)
	if err != nil {
		return err
	}
	if !identifier.MatchString(sample.ID) {
		return fmt.Errorf("invalid sample id")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	record, err := json.MarshalIndent(sample, "", "  ")
	if err != nil {
		return err
	}
	// The frame first: a record never points at a missing image.
	if err := writeFile(filepath.Join(dir, sample.ID+".jpg"), jpeg); err != nil {
		return err
	}
	return writeFile(filepath.Join(dir, sample.ID+".json"), record)
}

func (d *DirSampleStore) List(_ context.Context, machineID string) ([]AcceptanceSample, error) {
	if !identifier.MatchString(machineID) {
		return nil, fmt.Errorf("invalid machine id")
	}
	files, err := filepath.Glob(filepath.Join(d.root, machineID, "*", "*.json"))
	if err != nil {
		return nil, err
	}
	samples := make([]AcceptanceSample, 0, len(files))
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			return nil, err
		}
		var s AcceptanceSample
		if err := json.Unmarshal(raw, &s); err != nil {
			return nil, fmt.Errorf("%s: %w", file, err)
		}
		samples = append(samples, s)
	}
	return samples, nil
}

func (d *DirSampleStore) Delete(_ context.Context, machineID, gaugeID string) error {
	dir, err := d.dir(machineID, gaugeID)
	if err != nil {
		return err
	}
	return os.RemoveAll(dir)
}

func (d *DirSampleStore) Frame(_ context.Context, machineID, gaugeID, id string) ([]byte, error) {
	dir, err := d.dir(machineID, gaugeID)
	if err != nil || !identifier.MatchString(id) {
		return nil, ErrNotFound
	}
	raw, err := os.ReadFile(filepath.Join(dir, id+".jpg"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	return raw, err
}

// Acceptance serves the acceptance step of the commissioning page.
type Acceptance struct {
	commissioning *Commissioning
	samples       SampleStore
	rules         AcceptanceRules
	now           func() time.Time
}

func NewAcceptance(c *Commissioning, samples SampleStore, rules AcceptanceRules) *Acceptance {
	return &Acceptance{commissioning: c, samples: samples, rules: rules, now: time.Now}
}

func (a *Acceptance) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/commissioning/acceptance", a.record)
	mux.HandleFunc("GET /v1/commissioning/acceptance/{machine}", a.list)
	mux.HandleFunc("GET /v1/commissioning/accuracy", a.accuracy)
	mux.HandleFunc("DELETE /v1/commissioning/acceptance/{machine}/{gauge}", a.clear)
	mux.HandleFunc("GET /v1/commissioning/acceptance/{machine}/{gauge}/{id}", a.frame)
}

// record reads the gauge on a fresh camera frame (or the frame sent along)
// with the draft config, compares it with the value the engineer typed and
// stores the sample.
func (a *Acceptance) record(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Config    json.RawMessage `json:"config"`
		GaugeID   string          `json:"gauge_id"`
		Truth     *float64        `json:"truth"`
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
	if req.Truth == nil || math.IsNaN(*req.Truth) || math.IsInf(*req.Truth, 0) {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "truth is required: the value the gauge shows now"})
		return
	}
	if !identifier.MatchString(cfg.GetMachineId()) {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "config.machine_id is required"})
		return
	}
	var gc *gaugev1.Gauge
	for _, g := range cfg.GetGauges() {
		if g.GetGaugeId() == req.GaugeID {
			gc = g
		}
	}
	if gc == nil || !identifier.MatchString(req.GaugeID) {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "gauge_id is not a gauge of the config"})
		return
	}
	gauge, err := decode.NewGauge(gc)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "gauge is not ready for acceptance: " + err.Error()})
		return
	}

	var out struct {
		FrameJPEG   string          `json:"frame_jpeg"`
		FrameResult json.RawMessage `json:"frame_result"`
	}
	body := map[string]any{"config": req.Config, "frame_jpeg": req.FrameJPEG}
	if err := a.commissioning.call(r.Context(), "/v1/infer", body, &out); err != nil {
		a.commissioning.fail(w, err)
		return
	}
	var result gaugev1.FrameResult
	if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(out.FrameResult, &result); err != nil {
		a.commissioning.fail(w, fmt.Errorf("frame result from preview-svc: %w", err))
		return
	}
	frame := req.FrameJPEG
	if frame == "" {
		frame = out.FrameJPEG
	}
	jpeg, err := base64.StdEncoding.DecodeString(frame)
	if err != nil || len(jpeg) == 0 {
		a.commissioning.fail(w, fmt.Errorf("no frame to keep with the sample"))
		return
	}

	var reading GaugePreview
	for _, p := range ReadGauges(cfg, &result) {
		if p.GaugeID == req.GaugeID {
			reading = p
		}
	}
	if reading.Error != "" {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "gauge cannot be read: " + reading.Error})
		return
	}
	now := a.now()
	sample := AcceptanceSample{
		ID:        strconv.FormatInt(now.UnixMilli(), 10),
		MachineID: cfg.GetMachineId(), GaugeID: req.GaugeID, Type: gauge.Type, Unit: gauge.Unit,
		TsMs: now.UnixMilli(), ConfigVersion: cfg.GetConfigVersion(), Truth: *req.Truth,
	}
	judge(&sample, gauge, reading, a.rules)
	if err := a.samples.Save(r.Context(), sample, jpeg); err != nil {
		a.commissioning.fail(w, err)
		return
	}
	a.respond(w, r, cfg.GetMachineId(), &sample)
}

// respond answers with the acceptance state of the machine and, after a new
// sample, the sample itself.
func (a *Acceptance) respond(w http.ResponseWriter, r *http.Request, machineID string, sample *AcceptanceSample) {
	samples, err := a.samples.List(r.Context(), machineID)
	if err != nil {
		a.commissioning.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"machine_id": machineID,
		"sample":     sample,
		"gauges":     SummariseAcceptance(samples, a.rules),
		"rules": map[string]any{
			"dial_tolerance": a.rules.DialTolerance, "min_samples": a.rules.MinSamples, "min_quality": a.rules.MinQuality,
		},
	})
}

func (a *Acceptance) list(w http.ResponseWriter, r *http.Request) {
	machine := r.PathValue("machine")
	if !identifier.MatchString(machine) {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "invalid machine id"})
		return
	}
	a.respond(w, r, machine, nil)
}

func (a *Acceptance) clear(w http.ResponseWriter, r *http.Request) {
	machine, gauge := r.PathValue("machine"), r.PathValue("gauge")
	if !identifier.MatchString(machine) || !identifier.MatchString(gauge) {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "invalid machine or gauge id"})
		return
	}
	if err := a.samples.Delete(r.Context(), machine, gauge); err != nil {
		a.commissioning.fail(w, err)
		return
	}
	a.respond(w, r, machine, nil)
}

func (a *Acceptance) frame(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSuffix(r.PathValue("id"), ".jpg")
	jpeg, err := a.samples.Frame(r.Context(), r.PathValue("machine"), r.PathValue("gauge"), id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, apiError{Error: "no such sample"})
			return
		}
		a.commissioning.fail(w, err)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	_, _ = w.Write(jpeg)
}

// ListAll returns the samples of every machine.
func (d *DirSampleStore) ListAll(_ context.Context) ([]AcceptanceSample, error) {
	files, err := filepath.Glob(filepath.Join(d.root, "*", "*", "*.json"))
	if err != nil {
		return nil, err
	}
	samples := make([]AcceptanceSample, 0, len(files))
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			return nil, err
		}
		var s AcceptanceSample
		if err := json.Unmarshal(raw, &s); err != nil {
			return nil, fmt.Errorf("%s: %w", file, err)
		}
		samples = append(samples, s)
	}
	return samples, nil
}

// AccuracyRow is the field accuracy of a group of gauges.
type AccuracyRow struct {
	Key     string `json:"key"` // gauge type, or machine/gauge
	Type    string `json:"type"`
	Samples int    `json:"samples"`
	Passed  int    `json:"passed"`
	// PassRate is Passed / Samples; LowerBound is the lower end of its 95%
	// Wilson interval: what the samples prove, given how few they may be.
	PassRate   float64 `json:"pass_rate"`
	LowerBound float64 `json:"lower_bound"`
	// LowQuality counts the readings that were right but below the quality
	// threshold (kept out of gauge_1m).
	LowQuality int `json:"low_quality"`
	// MeanErrorPct is the mean absolute error of dials in % of full scale.
	MeanErrorPct *float64 `json:"mean_error_pct,omitempty"`
}

// AccuracyReport is the accuracy measured on site, from the acceptance samples.
type AccuracyReport struct {
	Samples int           `json:"samples"`
	ByType  []AccuracyRow `json:"by_type"`
	ByGauge []AccuracyRow `json:"by_gauge"`
}

// wilsonLower is the lower bound of the 95% Wilson score interval of k successes in n.
func wilsonLower(k, n int) float64 {
	if n == 0 {
		return 0
	}
	const z = 1.959964
	p, nf := float64(k)/float64(n), float64(n)
	centre := p + z*z/(2*nf)
	spread := z * math.Sqrt(p*(1-p)/nf+z*z/(4*nf*nf))
	return math.Max(0, (centre-spread)/(1+z*z/nf))
}

// Accuracy groups the samples by gauge type and by gauge.
func Accuracy(samples []AcceptanceSample) AccuracyReport {
	type acc struct {
		row        AccuracyRow
		errSum     float64
		errSamples int
	}
	byType, byGauge := map[string]*acc{}, map[string]*acc{}
	add := func(groups map[string]*acc, key string, s AcceptanceSample) {
		g, ok := groups[key]
		if !ok {
			g = &acc{row: AccuracyRow{Key: key, Type: s.Type}}
			groups[key] = g
		}
		g.row.Samples++
		if s.Passed {
			g.row.Passed++
			if !s.QualityOK {
				g.row.LowQuality++
			}
		}
		if s.Error != nil && s.FullScale > 0 {
			g.errSum += math.Abs(*s.Error) / s.FullScale * 100
			g.errSamples++
		}
	}
	for _, s := range samples {
		add(byType, s.Type, s)
		add(byGauge, s.MachineID+"/"+s.GaugeID, s)
	}
	rows := func(groups map[string]*acc) []AccuracyRow {
		out := make([]AccuracyRow, 0, len(groups))
		for _, g := range groups {
			r := g.row
			r.PassRate = float64(r.Passed) / float64(r.Samples)
			r.LowerBound = wilsonLower(r.Passed, r.Samples)
			if g.errSamples > 0 {
				mean := g.errSum / float64(g.errSamples)
				r.MeanErrorPct = &mean
			}
			out = append(out, r)
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
		return out
	}
	return AccuracyReport{Samples: len(samples), ByType: rows(byType), ByGauge: rows(byGauge)}
}

func (a *Acceptance) accuracy(w http.ResponseWriter, r *http.Request) {
	lister, ok := a.samples.(interface {
		ListAll(context.Context) ([]AcceptanceSample, error)
	})
	if !ok {
		http.Error(w, "sample store cannot list every machine", http.StatusNotImplemented)
		return
	}
	samples, err := lister.ListAll(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(Accuracy(samples))
}
