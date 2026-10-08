package agent

import (
	"math"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

const (
	watchTopic   = "denso/DENSO_HN/L03/PRESS_01/watch"
	previewTopic = "denso/DENSO_HN/L03/PRESS_01/preview"
)

func (h *harness) previews() []*gaugev1.Preview {
	var out []*gaugev1.Preview
	for _, p := range h.broker.snapshot() {
		if p.topic != previewTopic {
			continue
		}
		if p.retain {
			h.t.Error("a preview must not be retained: it is only for whoever watches now")
		}
		var pv gaugev1.Preview
		if err := proto.Unmarshal(p.payload, &pv); err != nil {
			h.t.Fatalf("preview does not decode: %v", err)
		}
		out = append(out, &pv)
	}
	return out
}

// previewFrame is a frame of the front camera carrying an image, as the
// pipeline sends while a PREVIEW command is in force.
func previewFrame(tsMs int64, pressure float64) *gaugev1.FrameResult {
	dial, volt := roisOf("PRESS_01", tsMs, pressure)
	f := cameraFrame(camFront, tsMs, dial, volt)
	f.PreviewJpeg, f.FrameWidth, f.FrameHeight = []byte("JPEG"), 1920, 1080
	return f
}

func (h *harness) watch(seconds uint32) {
	h.t.Helper()
	payload, _ := proto.Marshal(&gaugev1.PreviewRequest{Seconds: seconds})
	if !h.broker.inject(watchTopic, payload) {
		h.t.Fatal("the agent is not subscribed to the watch topic")
	}
}

func (h *harness) previewCommands() []*gaugev1.Command {
	h.pipeline.mu.Lock()
	defer h.pipeline.mu.Unlock()
	var out []*gaugev1.Command
	for _, c := range h.pipeline.commands {
		if c.GetType() == gaugev1.CommandType_COMMAND_TYPE_PREVIEW {
			out = append(out, c)
		}
	}
	return out
}

func TestPreviewIsPublishedOnlyWhileSomebodyWatches(t *testing.T) {
	h := newHarness(t, t.TempDir(), nil)
	h.start()
	h.configure("7")

	// Nobody watches: an image that came along anyway goes nowhere.
	h.frames <- previewFrame(1700000005100, 60)
	h.frames <- previewFrame(1700000005300, 60)
	time.Sleep(60 * time.Millisecond)
	if n := len(h.previews()); n != 0 {
		t.Fatalf("%d previews published although nobody watches", n)
	}

	h.watch(5)
	h.eventually("the pipeline is told to send images", func() bool { return len(h.previewCommands()) == 1 })
	if cmd := h.previewCommands()[0]; cmd.GetCameraUrl() != camFront || cmd.GetPreviewSeconds() != 5 {
		t.Errorf("preview command: %v", cmd)
	}

	h.frames <- previewFrame(1700000005500, 75)
	h.eventually("a preview", func() bool { return len(h.previews()) == 1 })
	pv := h.previews()[0]
	if pv.GetMachineId() != "PRESS_01" || pv.GetCameraId() != "" || pv.GetFrameTsMs() != 1700000005500 ||
		string(pv.GetJpeg()) != "JPEG" || pv.GetFrameWidth() != 1920 || pv.GetFrameHeight() != 1080 {
		t.Errorf("preview: %v", pv)
	}
	// The numbers are what was read on this very frame.
	if len(pv.GetReadings()) != 2 {
		t.Fatalf("readings: %v", pv.GetReadings())
	}
	dial, volt := pv.GetReadings()[0], pv.GetReadings()[1]
	if dial.GetGaugeId() != "MAIN_PRESSURE" || dial.Value == nil || math.Abs(dial.GetValue()-75) > 0.1 || dial.GetConfidence() <= 0 {
		t.Errorf("dial reading: %v", dial)
	}
	if volt.GetGaugeId() != "VOLTMETER" || volt.GetValue() != 220.5 {
		t.Errorf("voltmeter reading: %v", volt)
	}

	// A frame without an image is not a preview.
	plain := previewFrame(1700000005700, 75)
	plain.PreviewJpeg = nil
	h.frames <- plain
	time.Sleep(60 * time.Millisecond)
	if n := len(h.previews()); n != 1 {
		t.Errorf("%d previews, want 1", n)
	}
	// Telemetry is untouched by all this.
	h.frames <- previewFrame(1700000006050, 75)
	h.eventually("telemetry of the window", func() bool { return len(h.telemetry()) == 1 })
}

func TestPreviewStopsWhenTheWatchExpires(t *testing.T) {
	h := newHarness(t, t.TempDir(), nil)
	h.start()
	h.configure("7")

	h.watch(1)
	h.eventually("preview command", func() bool { return len(h.previewCommands()) == 1 })
	h.frames <- previewFrame(1700000005100, 60)
	h.eventually("a preview while watched", func() bool { return len(h.previews()) == 1 })

	time.Sleep(1100 * time.Millisecond)
	h.frames <- previewFrame(1700000005300, 60)
	time.Sleep(60 * time.Millisecond)
	if n := len(h.previews()); n != 1 {
		t.Errorf("%d previews after the watch expired, want 1", n)
	}
}

func TestWatchLengthIsBounded(t *testing.T) {
	h := newHarness(t, t.TempDir(), nil)
	h.start()
	h.configure("7")
	h.watch(0)    // no length given
	h.watch(9999) // far too long
	h.eventually("two preview commands", func() bool { return len(h.previewCommands()) == 2 })
	// The commands run in the background, so they may arrive in either order.
	a, b := h.previewCommands()[0].GetPreviewSeconds(), h.previewCommands()[1].GetPreviewSeconds()
	if min(a, b) != 10 || max(a, b) != 60 {
		t.Errorf("preview lengths %d and %d, want 10 and 60", a, b)
	}
}
