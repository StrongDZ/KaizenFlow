package agent

import (
	"math"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"google.golang.org/protobuf/proto"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

const (
	camFront = "rtsp://cam/1"
	camSide  = "rtsp://cam/2"
)

// cameraFrame is what the pipeline sends for one frame of one camera: the
// given ROIs, each tagged with its machine.
func cameraFrame(camera string, tsMs int64, rois ...*gaugev1.RoiResult) *gaugev1.FrameResult {
	return &gaugev1.FrameResult{CameraId: camera, FrameTsMs: tsMs, Rois: rois}
}

// roisOf returns the dial and voltmeter ROIs of frame(), tagged with a machine.
func roisOf(machine string, tsMs int64, pressure float64) (dial, volt *gaugev1.RoiResult) {
	f := frame(tsMs, pressure)
	for _, r := range f.GetRois() {
		r.MachineId = machine
	}
	return f.GetRois()[0], f.GetRois()[1]
}

func (h *harness) telemetryOn(topic string) []*gaugev1.Telemetry {
	var out []*gaugev1.Telemetry
	for _, p := range h.broker.snapshot() {
		if p.topic != topic {
			continue
		}
		var tel gaugev1.Telemetry
		if err := proto.Unmarshal(p.payload, &tel); err != nil {
			h.t.Fatalf("telemetry does not decode: %v", err)
		}
		out = append(out, &tel)
	}
	return out
}

func (h *harness) configureMachine(machine string, version float64, config string) {
	h.t.Helper()
	topic := "denso/DENSO_HN/L03/" + machine + "/config"
	h.eventually("config subscription of "+machine, func() bool { return h.broker.inject(topic, []byte(config)) })
	h.eventually("config of "+machine+" active", func() bool {
		return testutil.ToFloat64(h.metrics.ConfigVersion.WithLabelValues(machine)) == version
	})
}

func measurement(tel *gaugev1.Telemetry, gauge string) *gaugev1.Measurement {
	for _, m := range tel.GetMeasurements() {
		if m.GetGaugeId() == gauge {
			return m
		}
	}
	return nil
}

func TestOneCameraFeedsTheGaugesOfTwoMachines(t *testing.T) {
	h := newHarness(t, t.TempDir(), func(c *Config) {
		c.Machines = append(c.Machines, MachineRef{"DENSO_HN", "L03", "PRESS_02"})
	})
	h.start()
	h.configure("7")
	// The neighbour's dial is on the same camera and has the same gauge ID.
	h.configureMachine("PRESS_02", 3, `{
	  "config_version": 3, "machine_id": "PRESS_02", "plant": "DENSO_HN", "line": "L03",
	  "camera": {"url": "`+camFront+`", "sample_fps": 2}, "window_sec": 1,
	  "gauges": [
	    {"gauge_id": "MAIN_PRESSURE", "type": "analog_dial", "unit": "bar", "roi": [100, 50, 256, 256],
	     "calib": {"center": [128, 128], "min_pt": [52, 204], "max_pt": [204, 204], "min_val": 0, "max_val": 150,
	               "sweep": "cw", "scale": "linear"}}
	  ]}`)

	send := func(tsMs int64) {
		dial1, volt1 := roisOf("PRESS_01", tsMs, 60)
		dial2, _ := roisOf("PRESS_02", tsMs, 90)
		h.frames <- cameraFrame(camFront, tsMs, dial1, volt1, dial2)
	}
	for i := int64(0); i < 4; i++ {
		send(1700000005100 + i*200)
	}
	send(1700000006050) // closes the window of both machines

	h.eventually("telemetry of both machines", func() bool {
		return len(h.telemetry()) == 1 && len(h.telemetryOn("denso/DENSO_HN/L03/PRESS_02/telemetry")) == 1
	})
	first, second := h.telemetry()[0], h.telemetryOn("denso/DENSO_HN/L03/PRESS_02/telemetry")[0]
	if first.GetMachineId() != "PRESS_01" || len(first.GetMeasurements()) != 2 ||
		math.Abs(measurement(first, "MAIN_PRESSURE").GetValue()-60) > 0.1 || measurement(first, "VOLTMETER").GetValue() != 220.5 {
		t.Errorf("PRESS_01: %v", first)
	}
	if second.GetMachineId() != "PRESS_02" || len(second.GetMeasurements()) != 1 ||
		math.Abs(measurement(second, "MAIN_PRESSURE").GetValue()-90) > 0.1 {
		t.Errorf("PRESS_02: %v", second)
	}
	if n := testutil.ToFloat64(h.metrics.FramesDropped.WithLabelValues("unknown_camera")); n != 0 {
		t.Errorf("%v frames of the shared camera were dropped", n)
	}
}

// twoCameraConfig puts the dial on the default camera and the voltmeter on a
// second one.
func twoCameraConfig(version string) string {
	return strings.Replace(strings.Replace(string(stationConfig(version)),
		`"window_sec": 1,`, `"window_sec": 1, "cameras": [{"camera_id": "side", "url": "`+camSide+`", "sample_fps": 2}],`, 1),
		`"gauge_id": "VOLTMETER",`, `"gauge_id": "VOLTMETER", "camera_id": "side",`, 1)
}

func TestSilentCameraOnlyMakesItsOwnGaugesStale(t *testing.T) {
	h := newHarness(t, t.TempDir(), func(c *Config) {
		c.StaleAfter, c.StartupGrace = 120*time.Millisecond, 400*time.Millisecond
	})
	h.start()
	h.configureMachine("PRESS_01", 7, twoCameraConfig("7"))

	second := time.Now().Unix() - 100
	both := func(tsMs int64) {
		dial, volt := roisOf("PRESS_01", tsMs, 60)
		h.frames <- cameraFrame(camFront, tsMs, dial)
		h.frames <- cameraFrame(camSide, tsMs, volt)
	}
	for i := int64(0); i < 4; i++ {
		both(second*1000 + 100 + i*200)
	}
	both((second+1)*1000 + 50)
	h.eventually("a window with both cameras", func() bool { return len(h.telemetry()) == 1 })
	if tel := h.telemetry()[0]; math.Abs(measurement(tel, "MAIN_PRESSURE").GetValue()-60) > 0.1 || measurement(tel, "VOLTMETER").GetValue() != 220.5 {
		t.Fatalf("first window: %v", tel)
	}

	// The side camera goes silent; the front camera keeps the windows moving.
	deadline := time.Now().Add(600 * time.Millisecond)
	for n := second + 1; time.Now().Before(deadline); n++ {
		for i := int64(0); i < 2; i++ {
			dial, _ := roisOf("PRESS_01", n*1000+300+i*300, 75)
			h.frames <- cameraFrame(camFront, n*1000+300+i*300, dial)
		}
		time.Sleep(30 * time.Millisecond)
	}
	h.eventually("the side camera reported stale", func() bool { return testutil.ToFloat64(h.metrics.PipelineStale) == 1 })
	h.eventually("restart command", func() bool { return h.pipeline.count(gaugev1.CommandType_COMMAND_TYPE_RESTART) == 1 })
	// Only the silent stream is reopened: the front camera keeps reading.
	if url := h.pipeline.last(gaugev1.CommandType_COMMAND_TYPE_RESTART).GetCameraUrl(); url != camSide {
		t.Errorf("restart of camera %q, want only the silent one %q", url, camSide)
	}

	all := h.telemetry()
	last := all[len(all)-1]
	dial, volt := measurement(last, "MAIN_PRESSURE"), measurement(last, "VOLTMETER")
	if dial == nil || dial.Value == nil || math.Abs(dial.GetValue()-75) > 0.1 || len(dial.GetFlags()) != 0 {
		t.Errorf("the gauge of the live camera lost its value: %v", dial)
	}
	if volt == nil || volt.Value != nil || len(volt.GetFlags()) != 1 || volt.GetFlags()[0] != gaugev1.Flag_FLAG_STALE {
		t.Errorf("the gauge of the silent camera is not stale: %v", volt)
	}

	// The side camera comes back.
	ts := time.Now().UnixMilli()
	_, back := roisOf("PRESS_01", ts, 75)
	h.frames <- cameraFrame(camSide, ts, back)
	h.eventually("recovery", func() bool { return testutil.ToFloat64(h.metrics.PipelineStale) == 0 })
}

func TestConfigWithAnUnknownCameraIsRejected(t *testing.T) {
	h := newHarness(t, t.TempDir(), nil)
	h.start()
	h.configure("7")
	bad := strings.Replace(string(stationConfig("8")), `"gauge_id": "VOLTMETER",`, `"gauge_id": "VOLTMETER", "camera_id": "nowhere",`, 1)
	h.broker.inject(configTopic, []byte(bad))
	time.Sleep(100 * time.Millisecond)
	if v := testutil.ToFloat64(h.metrics.ConfigVersion.WithLabelValues("PRESS_01")); v != 7 {
		t.Errorf("config version is %v; a config naming an unknown camera must keep the previous one", v)
	}
}
