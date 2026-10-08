package decode

import (
	"fmt"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

// CameraOf returns the camera that sees a gauge: the entry of cfg.Cameras (or
// the default camera) named by the gauge's camera_id, the default camera when
// the gauge names none. The edge, config-api and the read API all resolve a
// gauge through this function, so they agree on which stream a ROI is in.
func CameraOf(cfg *gaugev1.StationConfig, g *gaugev1.Gauge) (*gaugev1.Camera, error) {
	id := g.GetCameraId()
	var cam *gaugev1.Camera
	switch {
	case id == "" || (cfg.GetCamera() != nil && cfg.GetCamera().GetCameraId() == id):
		cam = cfg.GetCamera()
	default:
		for _, c := range cfg.GetCameras() {
			if c.GetCameraId() == id {
				cam = c
				break
			}
		}
	}
	switch {
	case cam == nil && id == "":
		return nil, fmt.Errorf("gauge %s: the config has no default camera", g.GetGaugeId())
	case cam == nil:
		return nil, fmt.Errorf("gauge %s: unknown camera %q", g.GetGaugeId(), id)
	case cam.GetUrl() == "":
		return nil, fmt.Errorf("gauge %s: camera %q has no url", g.GetGaugeId(), id)
	}
	return cam, nil
}

// CamerasInUse lists the cameras the gauges of a config are read from, each
// url once, in the order the gauges name them.
func CamerasInUse(cfg *gaugev1.StationConfig) ([]*gaugev1.Camera, error) {
	var out []*gaugev1.Camera
	seen := map[string]bool{}
	for _, g := range cfg.GetGauges() {
		cam, err := CameraOf(cfg, g)
		if err != nil {
			return nil, err
		}
		if !seen[cam.GetUrl()] {
			seen[cam.GetUrl()] = true
			out = append(out, cam)
		}
	}
	return out, nil
}
