package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"

	"google.golang.org/protobuf/encoding/protojson"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

// Identifiers end up in MQTT topics and Kafka keys: no slashes or wildcards.
var identifier = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)

var (
	gaugeTypes = map[string]bool{"analog_dial": true, "seg7": true, "timer_mmss": true, "rolling_counter": true}
	sweeps     = map[string]bool{"cw": true, "ccw": true}
	scales     = map[string]bool{"linear": true}
	colors     = map[string]bool{"red_led": true, "green_led": true, "lcd": true}
)

// ParseConfig decodes a station config from its JSON form. Besides the proto
// JSON it accepts quad as [[x, y], ...], the form used in the spec. Unknown
// fields are rejected so that a typo cannot silently drop a setting.
func ParseConfig(body []byte) (*gaugev1.StationConfig, error) {
	var doc map[string]any
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}
	if gauges, ok := doc["gauges"].([]any); ok {
		for _, g := range gauges {
			gauge, ok := g.(map[string]any)
			if !ok {
				continue
			}
			quad, ok := gauge["quad"].([]any)
			if !ok {
				continue
			}
			for i, p := range quad {
				if pair, ok := p.([]any); ok {
					if len(pair) != 2 {
						return nil, errors.New("quad points must be [x, y]")
					}
					quad[i] = map[string]any{"x": pair[0], "y": pair[1]}
				}
			}
		}
	}
	normalised, err := json.Marshal(doc)
	if err != nil {
		return nil, err
	}
	var cfg gaugev1.StationConfig
	if err := protojson.Unmarshal(normalised, &cfg); err != nil {
		return nil, fmt.Errorf("not a station config: %w", err)
	}
	return &cfg, nil
}

// Validate returns every problem of a station config, or nil.
func Validate(cfg *gaugev1.StationConfig) []string {
	var problems []string
	add := func(format string, args ...any) { problems = append(problems, fmt.Sprintf(format, args...)) }

	for name, value := range map[string]string{"machine_id": cfg.GetMachineId(), "plant": cfg.GetPlant(), "line": cfg.GetLine()} {
		if !identifier.MatchString(value) {
			add("%s must be 1-64 characters of A-Z a-z 0-9 _ . -", name)
		}
	}
	if cfg.GetWindowSec() < 1 {
		add("window_sec must be at least 1")
	}
	if cfg.GetCamera().GetUrl() == "" {
		add("camera.url is required")
	}
	if fps := cfg.GetCamera().GetSampleFps(); fps < 1 || fps > 30 {
		add("camera.sample_fps must be between 1 and 30")
	}
	if len(cfg.GetGauges()) == 0 {
		add("at least one gauge is required")
	}
	seen := map[string]bool{}
	for i, g := range cfg.GetGauges() {
		name := g.GetGaugeId()
		if !identifier.MatchString(name) {
			add("gauges[%d].gauge_id must be 1-64 characters of A-Z a-z 0-9 _ . -", i)
			name = fmt.Sprintf("gauges[%d]", i)
		}
		if seen[g.GetGaugeId()] {
			add("%s: duplicate gauge_id", name)
		}
		seen[g.GetGaugeId()] = true
		if roi := g.GetRoi(); len(roi) != 4 || roi[0] < 0 || roi[1] < 0 || roi[2] <= 0 || roi[3] <= 0 {
			add("%s: roi must be [x, y, width, height] with a positive size", name)
		}
		if n := len(g.GetQuad()); n != 0 && n != 4 {
			add("%s: quad must have 0 or 4 points (TL, TR, BR, BL)", name)
		}
		if g.RectSize != nil && g.GetRectSize() == 0 {
			add("%s: rect_size must be positive", name)
		}
		if r := g.GetRules(); r != nil {
			if r.Min != nil && r.Max != nil && r.GetMin() >= r.GetMax() {
				add("%s: rules.min must be below rules.max", name)
			}
			if r.GetMaxRatePerS() < 0 || r.GetDeadband() < 0 {
				add("%s: rules.max_rate_per_s and rules.deadband must not be negative", name)
			}
		}
		calib := g.GetCalib()
		if calib.Color != nil && !colors[calib.GetColor()] {
			add("%s: calib.color must be one of red_led, green_led, lcd", name)
		}
		switch g.GetType() {
		case "analog_dial":
			if len(calib.GetCenter()) != 2 || len(calib.GetMinPt()) != 2 || len(calib.GetMaxPt()) != 2 {
				add("%s: calib.center, min_pt and max_pt must be [x, y]", name)
			}
			if calib.MinVal == nil || calib.MaxVal == nil || calib.GetMinVal() >= calib.GetMaxVal() {
				add("%s: calib.min_val must be below calib.max_val", name)
			}
			if !sweeps[calib.GetSweep()] {
				add("%s: calib.sweep must be cw or ccw", name)
			}
			if !scales[calib.GetScale()] {
				add("%s: calib.scale must be linear", name)
			}
		case "seg7":
			if d := calib.GetDigits(); d < 1 || d > 8 {
				add("%s: calib.digits must be between 1 and 8", name)
			}
			if calib.DecimalPos == nil || calib.GetDecimalPos() > calib.GetDigits() {
				add("%s: calib.decimal_pos must be between 0 and digits", name)
			}
			if calib.Color == nil {
				add("%s: calib.color is required", name)
			}
		case "timer_mmss":
			if calib.GetDigits() != 4 || calib.GetColonAfter() != 2 {
				add("%s: timer_mmss needs calib.digits = 4 and calib.colon_after = 2", name)
			}
		case "rolling_counter":
			if d := calib.GetDigits(); d < 1 || d > 10 {
				add("%s: calib.digits must be between 1 and 10", name)
			}
			if calib.GetDecimalDigits() >= calib.GetDigits() {
				add("%s: calib.decimal_digits must be below digits", name)
			}
		default:
			if !gaugeTypes[g.GetType()] {
				add("%s: type must be one of analog_dial, seg7, timer_mmss, rolling_counter", name)
			}
		}
	}
	return problems
}
