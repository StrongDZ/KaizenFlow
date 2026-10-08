package main

import (
	"slices"
	"strings"
	"testing"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

// withCameras returns the spec example with a second camera and its second
// gauge moved to it.
func withCameras(t *testing.T, mutate func(*gaugev1.StationConfig)) *gaugev1.StationConfig {
	t.Helper()
	cfg, err := ParseConfig(specConfig(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.GetGauges()) < 2 {
		t.Fatal("the spec example needs two gauges for these tests")
	}
	cfg.Cameras = []*gaugev1.Camera{{CameraId: "side", Url: "rtsp://10.1.3.22/stream1", SampleFps: 2}}
	cfg.Gauges[1].CameraId = "side"
	if mutate != nil {
		mutate(cfg)
	}
	return cfg
}

func TestValidateCameras(t *testing.T) {
	if problems := Validate(withCameras(t, nil)); len(problems) != 0 {
		t.Fatalf("a gauge on a second camera rejected: %v", problems)
	}
	cases := []struct {
		name   string
		mutate func(*gaugev1.StationConfig)
		want   string // empty: the config is valid
	}{
		{"every gauge on a named camera, no default", func(c *gaugev1.StationConfig) {
			c.Camera = nil
			for _, g := range c.Gauges {
				g.CameraId = "side"
			}
		}, ""},
		{"the default camera may be named and referred to", func(c *gaugev1.StationConfig) {
			c.Camera.CameraId = "front"
			c.Gauges[0].CameraId = "front"
		}, ""},
		{"gauge on the default camera of a config without one", func(c *gaugev1.StationConfig) { c.Camera = nil }, "camera.url is required"},
		{"gauge on an unknown camera", func(c *gaugev1.StationConfig) { c.Gauges[1].CameraId = "back" }, `unknown camera "back"`},
		{"camera without id", func(c *gaugev1.StationConfig) { c.Cameras[0].CameraId = "" }, "cameras[0].camera_id must be"},
		{"camera without url", func(c *gaugev1.StationConfig) { c.Cameras[0].Url = "" }, "cameras[0].url is required"},
		{"camera with a bad rate", func(c *gaugev1.StationConfig) { c.Cameras[0].SampleFps = 0 }, "cameras[0].sample_fps must be between 1 and 30"},
		{"two cameras with one id", func(c *gaugev1.StationConfig) {
			c.Cameras = append(c.Cameras, &gaugev1.Camera{CameraId: "side", Url: "rtsp://other", SampleFps: 2})
		}, "cameras[1]: duplicate camera_id"},
		{"a camera named like the default one", func(c *gaugev1.StationConfig) { c.Camera.CameraId = "side" }, "cameras[0]: duplicate camera_id"},
		{"one stream listed twice", func(c *gaugev1.StationConfig) { c.Cameras[0].Url = c.Camera.Url }, "cameras[0]: same url as another camera"},
	}
	for _, c := range cases {
		problems := Validate(withCameras(t, c.mutate))
		found := slices.ContainsFunc(problems, func(p string) bool { return strings.Contains(p, c.want) })
		if c.want == "" && len(problems) != 0 {
			t.Errorf("%s: rejected: %v", c.name, problems)
		}
		if c.want != "" && !found {
			t.Errorf("%s: got %v, want a problem containing %q", c.name, problems, c.want)
		}
	}
}
