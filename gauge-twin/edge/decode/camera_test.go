package decode

import (
	"testing"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

func TestCameraOf(t *testing.T) {
	cfg := &gaugev1.StationConfig{
		Camera: &gaugev1.Camera{Url: "rtsp://front", SampleFps: 2, CameraId: "front"},
		Cameras: []*gaugev1.Camera{
			{CameraId: "side", Url: "rtsp://side", SampleFps: 1},
			{CameraId: "empty"},
		},
	}
	cases := []struct {
		name, cameraID, wantURL string
		wantErr                 bool
	}{
		{"no camera_id means the default camera", "", "rtsp://front", false},
		{"the default camera can be named", "front", "rtsp://front", false},
		{"an additional camera", "side", "rtsp://side", false},
		{"unknown camera", "back", "", true},
		{"camera without url", "empty", "", true},
	}
	for _, c := range cases {
		cam, err := CameraOf(cfg, &gaugev1.Gauge{GaugeId: "G", CameraId: c.cameraID})
		if (err != nil) != c.wantErr || cam.GetUrl() != c.wantURL {
			t.Errorf("%s: got %q, %v; want %q, error %v", c.name, cam.GetUrl(), err, c.wantURL, c.wantErr)
		}
	}
}

func TestCameraOfWithoutDefaultCamera(t *testing.T) {
	cfg := &gaugev1.StationConfig{Cameras: []*gaugev1.Camera{{CameraId: "side", Url: "rtsp://side"}}}
	if _, err := CameraOf(cfg, &gaugev1.Gauge{GaugeId: "G"}); err == nil {
		t.Error("a gauge on the default camera of a config without one must be an error")
	}
	if cam, err := CameraOf(cfg, &gaugev1.Gauge{GaugeId: "G", CameraId: "side"}); err != nil || cam.GetUrl() != "rtsp://side" {
		t.Errorf("got %v, %v", cam, err)
	}
}

func TestCamerasInUse(t *testing.T) {
	cfg := &gaugev1.StationConfig{
		Camera:  &gaugev1.Camera{Url: "rtsp://front"},
		Cameras: []*gaugev1.Camera{{CameraId: "side", Url: "rtsp://side"}, {CameraId: "unused", Url: "rtsp://unused"}},
		Gauges:  []*gaugev1.Gauge{{GaugeId: "A"}, {GaugeId: "B", CameraId: "side"}, {GaugeId: "C"}},
	}
	got, err := CamerasInUse(cfg)
	if err != nil || len(got) != 2 || got[0].GetUrl() != "rtsp://front" || got[1].GetUrl() != "rtsp://side" {
		t.Errorf("got %v, %v; want front then side, each once", got, err)
	}
	cfg.Gauges = append(cfg.Gauges, &gaugev1.Gauge{GaugeId: "D", CameraId: "missing"})
	if _, err := CamerasInUse(cfg); err == nil {
		t.Error("a gauge on an unknown camera must be an error")
	}
}
