// Tests for the code generated from schemas/proto. The generated packages are
// not committed; run `make proto` first.
package gen_test

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

const stationConfigPath = "../../schemas/testdata/station_config.json"

// The station config of SPEC section 3.1 must parse without unknown fields
// and serialize back to the same JSON document.
func TestStationConfigMatchesSpecJSON(t *testing.T) {
	raw, err := os.ReadFile(stationConfigPath)
	if err != nil {
		t.Fatal(err)
	}

	var cfg gaugev1.StationConfig
	if err := protojson.Unmarshal(raw, &cfg); err != nil {
		t.Fatalf("spec JSON does not match config.proto: %v", err)
	}

	if cfg.GetConfigVersion() != 7 || cfg.GetMachineId() != "STAMPING_PRESS_01" {
		t.Errorf("unexpected header: version=%d machine=%q", cfg.GetConfigVersion(), cfg.GetMachineId())
	}
	if got := len(cfg.GetGauges()); got != 4 {
		t.Fatalf("gauges: got %d, want 4", got)
	}
	dial := cfg.GetGauges()[0]
	if dial.GetType() != "analog_dial" || dial.GetCalib().GetMaxVal() != 150 || dial.GetRules().GetDeadband() != 0.5 {
		t.Errorf("unexpected dial gauge: %v", dial)
	}
	if dial.GetCalib().MinVal == nil {
		t.Error("min_val = 0 must be kept as an explicit value")
	}
	if cfg.GetGauges()[2].GetRules() != nil {
		t.Error("gauge without rules must have nil rules")
	}

	out, err := protojson.MarshalOptions{UseProtoNames: true}.Marshal(&cfg)
	if err != nil {
		t.Fatal(err)
	}
	var want, got any
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(want, got) {
		t.Errorf("JSON round trip differs\nwant: %v\ngot:  %v", want, got)
	}
}

// An unreadable gauge is sent with value unset, which must stay
// distinguishable from a real reading of 0.
func TestMeasurementValuePresence(t *testing.T) {
	zero := 0.0
	in := &gaugev1.Telemetry{
		SchemaVersion: 1,
		EdgeId:        "edge-1",
		Seq:           42,
		MachineId:     "STAMPING_PRESS_01",
		Measurements: []*gaugev1.Measurement{
			{GaugeId: "UNREADABLE", Flags: []gaugev1.Flag{gaugev1.Flag_FLAG_BLUR}},
			{GaugeId: "ZERO", Value: &zero, Quality: 0.9},
		},
	}

	wire, err := proto.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	var out gaugev1.Telemetry
	if err := proto.Unmarshal(wire, &out); err != nil {
		t.Fatal(err)
	}

	if out.GetSeq() != 42 {
		t.Errorf("seq: got %d, want 42", out.GetSeq())
	}
	if out.GetMeasurements()[0].Value != nil {
		t.Error("unset value must stay unset")
	}
	if v := out.GetMeasurements()[1].Value; v == nil || *v != 0 {
		t.Error("explicit zero value must be preserved")
	}
}

// Flag numbers are stored in gauge_reading.flags and must match the spec.
func TestFlagNumbersMatchSpec(t *testing.T) {
	want := map[string]int32{
		"FLAG_UNSPECIFIED": 0, "FLAG_BLUR": 1, "FLAG_GLARE": 2, "FLAG_OCCLUDED": 3,
		"FLAG_OUT_OF_RANGE": 4, "FLAG_RATE_LIMIT": 5, "FLAG_NON_MONOTONIC": 6,
		"FLAG_FORMAT_INVALID": 7, "FLAG_ROI_DRIFT": 8, "FLAG_STALE": 9,
		"FLAG_CLOCK_SKEW": 10, "FLAG_NO_CONFIG": 11,
	}
	if !reflect.DeepEqual(gaugev1.Flag_value, want) {
		t.Errorf("flag numbers changed: %v", gaugev1.Flag_value)
	}
}

func TestFrameResultRoundTrip(t *testing.T) {
	in := &gaugev1.FrameResult{
		CameraId:  "cam-1",
		FrameTsMs: 1_700_000_000_000,
		Rois: []*gaugev1.RoiResult{{
			GaugeId:    "VOLTMETER",
			SlotProbs:  []*gaugev1.SlotProbs{{Probs: make([]float32, 12)}},
			Sharpness:  120.5,
			GlareRatio: 0.02,
		}},
	}
	wire, err := proto.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	var out gaugev1.FrameResult
	if err := proto.Unmarshal(wire, &out); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(in, &out) {
		t.Errorf("round trip differs: %v", &out)
	}
}
