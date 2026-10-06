package sim

import (
	"fmt"
	"math"
	"math/rand"
	"time"

	"google.golang.org/protobuf/proto"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

const (
	schemaVersion = 1
	configVersion = 1
	modelVersion  = "sim-0.1"
	swVersion     = "edge-sim-0.1"
	// framesPerWindow assumes sample_fps = 2 and is scaled by the window length.
	sampleFPS = 2.0
)

// machine holds the simulated physical state of one machine.
type machine struct {
	id    string
	topic string // telemetry topic
	// Slowly varying state behind the readings.
	pressurePhase float64
	voltage       float64
	hours         float64
	timerOffset   float64
}

func newMachine(cfg Config, index int, rng *rand.Rand) *machine {
	return &machine{
		id:            MachineID(index),
		topic:         cfg.TopicPrefix(index) + "/telemetry",
		pressurePhase: rng.Float64() * 2 * math.Pi,
		voltage:       []float64{200, 220, 380}[rng.Intn(3)],
		hours:         1000 + rng.Float64()*20000,
		timerOffset:   rng.Float64() * 45,
	}
}

// item is one message on its way to the broker.
type item struct {
	tel         *gaugev1.Telemetry // nil for bad_schema
	raw         []byte             // payload override for bad_schema
	topic       string
	machineID   string
	seq         uint64 // 0 for bad_schema, which carries no sequence number
	windowEndMs int64
	fault       Fault
	size        int
}

// payload serialises the message; replayed marks it as drained from the buffer.
func (it *item) payload(replayed bool) ([]byte, error) {
	if it.raw != nil {
		return it.raw, nil
	}
	it.tel.Replayed = replayed
	return proto.Marshal(it.tel)
}

func measurement(id, unit string, value, spread float64, frames uint32, rng *rand.Rand) *gaugev1.Measurement {
	return &gaugev1.Measurement{
		GaugeId: id,
		Value:   &value,
		VMin:    value - spread,
		VMax:    value + spread,
		NFrames: frames,
		Quality: float32(0.85 + 0.14*rng.Float64()),
		Unit:    unit,
	}
}

// build creates the telemetry of one machine for the window [start, end).
func (m *machine) build(edgeID string, seq uint64, start, end time.Time, rng *rand.Rand) *gaugev1.Telemetry {
	seconds := float64(end.UnixMilli()) / 1000.0
	window := end.Sub(start).Seconds()
	frames := uint32(math.Max(1, math.Round(sampleFPS*window)))

	pressure := 75 + 35*math.Sin(seconds*2*math.Pi/3.0+m.pressurePhase) + rng.NormFloat64()
	voltage := math.Round((m.voltage+rng.NormFloat64()*0.6)*10) / 10
	timer := math.Floor(math.Mod(seconds+m.timerOffset, 45))
	m.hours += window / 3600.0
	hours := math.Floor(m.hours*10) / 10

	measurements := []*gaugev1.Measurement{
		measurement("MAIN_PRESSURE", "bar", pressure, 4, frames, rng),
		measurement("VOLTMETER", "V", voltage, 0.5, frames, rng),
		measurement("CYCLE_TIMER", "s", timer, 0, frames, rng),
		measurement("TOTAL_HOUR_METER", "h", hours, 0, frames, rng),
	}
	// Now and then a gauge cannot be read: value unset, flag set, low quality.
	if rng.Float64() < 0.01 {
		unreadable := measurements[rng.Intn(len(measurements))]
		unreadable.Value, unreadable.VMin, unreadable.VMax = nil, 0, 0
		unreadable.NFrames, unreadable.NRejected = 0, frames
		unreadable.Quality = 0
		unreadable.Flags = []gaugev1.Flag{gaugev1.Flag_FLAG_BLUR}
	}

	return &gaugev1.Telemetry{
		SchemaVersion: schemaVersion,
		EdgeId:        edgeID,
		Seq:           seq,
		MachineId:     m.id,
		WindowStartMs: start.UnixMilli(),
		WindowEndMs:   end.UnixMilli(),
		ConfigVersion: configVersion,
		ModelVersion:  modelVersion,
		Measurements:  measurements,
	}
}

// StationConfigJSON is the station config matching what a simulated machine
// reports, in the JSON form config-api accepts. Load tests register it so
// that ingest validates the simulated telemetry like real data.
func StationConfigJSON(cfg Config, index int) []byte {
	machine := MachineID(index)
	return []byte(fmt.Sprintf(`{
  "machine_id": %q, "plant": %q, "line": "L%02d",
  "camera": {"url": "rtsp://mediamtx:8554/%s", "sample_fps": 2},
  "window_sec": %d,
  "gauges": [
    {"gauge_id": "MAIN_PRESSURE", "type": "analog_dial", "unit": "bar", "roi": [812, 344, 260, 260],
     "calib": {"center": [130, 131], "min_pt": [52, 205], "max_pt": [208, 205], "min_val": 0, "max_val": 150,
               "sweep": "cw", "scale": "linear"},
     "rules": {"min": 0, "max": 150, "max_rate_per_s": 120}},
    {"gauge_id": "VOLTMETER", "type": "seg7", "unit": "V", "roi": [1210, 402, 180, 64],
     "calib": {"digits": 4, "decimal_pos": 3, "color": "red_led"}, "rules": {"min": 0, "max": 500}},
    {"gauge_id": "CYCLE_TIMER", "type": "timer_mmss", "unit": "s", "roi": [1210, 500, 180, 64],
     "calib": {"digits": 4, "colon_after": 2}},
    {"gauge_id": "TOTAL_HOUR_METER", "type": "rolling_counter", "unit": "h", "roi": [600, 620, 220, 70],
     "calib": {"digits": 6, "decimal_digits": 1}, "rules": {"monotonic": true, "report_interval_s": 300}}
  ]
}
`, machine, cfg.Plant, index/10+1, machine, max(1, int(cfg.Window.Seconds()))))
}
