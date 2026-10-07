package agent

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"google.golang.org/protobuf/proto"

	"gauge-twin/edge/edge-agent/internal/store"
	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

// ---------------------------------------------------------------- fakes ----

type publication struct {
	topic   string
	payload []byte
	retain  bool
}

type fakeBroker struct {
	mu        sync.Mutex
	down      bool
	published []publication
	sessions  []*fakeSession
}

type fakeSession struct {
	broker    *fakeBroker
	onMessage func(string, []byte)
	topics    []string
	done      chan struct{}
	once      sync.Once
}

func (b *fakeBroker) Connect(_ context.Context, _ string, _ Will, onMessage func(string, []byte)) (Session, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.down {
		return nil, errors.New("broker unreachable")
	}
	s := &fakeSession{broker: b, onMessage: onMessage, done: make(chan struct{})}
	b.sessions = append(b.sessions, s)
	return s, nil
}

func (b *fakeBroker) setDown(down bool) {
	b.mu.Lock()
	b.down = down
	b.mu.Unlock()
}

// inject delivers a message to the live session, as the broker would for a
// subscribed topic.
func (b *fakeBroker) inject(topic string, payload []byte) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	for i := len(b.sessions) - 1; i >= 0; i-- {
		s := b.sessions[i]
		select {
		case <-s.done:
			continue
		default:
		}
		for _, t := range s.topics {
			if t == topic {
				go s.onMessage(topic, payload)
				return true
			}
		}
	}
	return false
}

func (b *fakeBroker) snapshot() []publication {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]publication(nil), b.published...)
}

func (s *fakeSession) Publish(_ context.Context, topic string, payload []byte, retain bool) error {
	select {
	case <-s.done:
		return errors.New("connection closed")
	default:
	}
	s.broker.mu.Lock()
	defer s.broker.mu.Unlock()
	s.broker.published = append(s.broker.published, publication{topic, append([]byte(nil), payload...), retain})
	return nil
}

func (s *fakeSession) Subscribe(_ context.Context, topics []string) error {
	s.broker.mu.Lock()
	defer s.broker.mu.Unlock()
	s.topics = append(s.topics, topics...)
	return nil
}

func (s *fakeSession) Done() <-chan struct{} { return s.done }
func (s *fakeSession) Close(bool)            { s.once.Do(func() { close(s.done) }) }

// fakePipeline answers commands; fail makes the first n reloads fail.
type fakePipeline struct {
	mu       sync.Mutex
	commands []*gaugev1.Command
	fail     int
}

func (p *fakePipeline) Do(_ context.Context, cmd *gaugev1.Command) (*gaugev1.CommandReply, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.commands = append(p.commands, proto.Clone(cmd).(*gaugev1.Command))
	if cmd.GetType() == gaugev1.CommandType_COMMAND_TYPE_RELOAD_CONFIG && p.fail > 0 {
		p.fail--
		return &gaugev1.CommandReply{CommandId: cmd.GetCommandId(), Ok: false, Error: "engine build failed"}, nil
	}
	return &gaugev1.CommandReply{CommandId: cmd.GetCommandId(), Ok: true}, nil
}

func (p *fakePipeline) count(kind gaugev1.CommandType) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	n := 0
	for _, c := range p.commands {
		if c.GetType() == kind {
			n++
		}
	}
	return n
}

// -------------------------------------------------------------- harness ----

const (
	telemetryTopic = "denso/DENSO_HN/L03/PRESS_01/telemetry"
	statusTopic    = "denso/DENSO_HN/L03/PRESS_01/status"
	configTopic    = "denso/DENSO_HN/L03/PRESS_01/config"
	resendTopic    = "denso/DENSO_HN/edge/edge-7/cmd/resend"
)

// stationConfig is a frontal dial (0..150 bar at frame position 100,50) and a
// 4-digit voltmeter, with 1 s windows.
func stationConfig(version string) []byte {
	return []byte(`{
	  "config_version": ` + version + `, "machine_id": "PRESS_01", "plant": "DENSO_HN", "line": "L03",
	  "camera": {"url": "rtsp://cam/1", "sample_fps": 2}, "window_sec": 1,
	  "gauges": [
	    {"gauge_id": "MAIN_PRESSURE", "type": "analog_dial", "unit": "bar", "roi": [100, 50, 256, 256],
	     "calib": {"center": [128, 128], "min_pt": [52, 204], "max_pt": [204, 204], "min_val": 0, "max_val": 150,
	               "sweep": "cw", "scale": "linear"}},
	    {"gauge_id": "VOLTMETER", "type": "seg7", "unit": "V", "roi": [500, 50, 128, 48],
	     "calib": {"digits": 4, "decimal_pos": 3, "color": "red_led"}}
	  ],
	  "model_versions": {"dial_pose": "dial-0.3", "digit_cls": "digit-0.2"}
	}`)
}

// frame builds pipeline output: the dial needle at a value and the voltmeter
// showing 220.5.
func frame(tsMs int64, pressure float64) *gaugev1.FrameResult {
	angle := (135 + pressure/150*270) * math.Pi / 180
	conf := []float32{0.9, 0.9, 0.9, 0.9, 0.9}
	dial := &gaugev1.RoiResult{
		GaugeId: "MAIN_PRESSURE", KpConf: conf, Sharpness: 200,
		Keypoints: []*gaugev1.Keypoint{{X: 228, Y: 178}, {}, {}, {},
			{X: float32(228 + 100*math.Cos(angle)), Y: float32(178 + 100*math.Sin(angle))}},
	}
	volt := &gaugev1.RoiResult{GaugeId: "VOLTMETER", Sharpness: 200}
	for _, digit := range []int{2, 2, 0, 5} {
		probs := make([]float32, 12)
		probs[digit] = 1
		volt.SlotProbs = append(volt.SlotProbs, &gaugev1.SlotProbs{Probs: probs})
	}
	return &gaugev1.FrameResult{CameraId: "PRESS_01", FrameTsMs: tsMs, Rois: []*gaugev1.RoiResult{dial, volt}}
}

type harness struct {
	t        *testing.T
	cfg      Config
	broker   *fakeBroker
	pipeline *fakePipeline
	store    *store.Store
	metrics  *Metrics
	frames   chan *gaugev1.FrameResult
	stop     context.CancelFunc
	done     chan struct{}
}

func newHarness(t *testing.T, dir string, mutate func(*Config)) *harness {
	t.Helper()
	cfg := DefaultConfig()
	cfg.EdgeID = "edge-7"
	cfg.Machines = []MachineRef{{"DENSO_HN", "L03", "PRESS_01"}}
	cfg.ConfigDir = filepath.Join(dir, "config")
	cfg.Tick, cfg.Heartbeat = 10*time.Millisecond, 40*time.Millisecond
	cfg.ReloadRetry = 30 * time.Millisecond
	cfg.ReplayRate = 2000
	cfg.BackoffMin, cfg.BackoffMax = 5*time.Millisecond, 20*time.Millisecond
	if mutate != nil {
		mutate(&cfg)
	}
	st, err := store.Open(filepath.Join(dir, "buffer.db"), 1<<20, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	return &harness{t: t, cfg: cfg, broker: &fakeBroker{}, pipeline: &fakePipeline{}, store: st,
		metrics: NewMetrics(prometheus.NewRegistry()), frames: make(chan *gaugev1.FrameResult, 100)}
}

func (h *harness) start() {
	h.t.Helper()
	agent, err := New(h.cfg, h.broker, h.pipeline, h.store, h.frames, h.metrics, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		h.t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	h.stop, h.done = cancel, make(chan struct{})
	go func() {
		defer close(h.done)
		agent.Run(ctx)
	}()
	h.t.Cleanup(h.shutdown)
}

func (h *harness) shutdown() {
	if h.stop != nil {
		h.stop()
		<-h.done
		h.stop = nil
		_ = h.store.Close()
	}
}

func (h *harness) eventually(what string, cond func() bool) {
	h.t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			h.t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (h *harness) telemetry() []*gaugev1.Telemetry {
	var out []*gaugev1.Telemetry
	for _, p := range h.broker.snapshot() {
		if p.topic != telemetryTopic {
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

func (h *harness) statuses() []*gaugev1.Status {
	var out []*gaugev1.Status
	for _, p := range h.broker.snapshot() {
		if p.topic != statusTopic {
			continue
		}
		var st gaugev1.Status
		if err := proto.Unmarshal(p.payload, &st); err != nil {
			h.t.Fatal(err)
		}
		if !p.retain {
			h.t.Error("status must be retained")
		}
		out = append(out, &st)
	}
	return out
}

// configure delivers the config over MQTT and waits until it is active.
func (h *harness) configure(version string) {
	h.t.Helper()
	h.eventually("config subscription", func() bool { return h.broker.inject(configTopic, stationConfig(version)) })
	h.eventually("config "+version+" active", func() bool {
		st := h.statuses()
		return len(st) > 0 && st[len(st)-1].GetConfigVersion() > 0 && strings.HasPrefix(version, itoa(st[len(st)-1].GetConfigVersion()))
	})
}

func itoa(v uint32) string {
	if v == 0 {
		return "0"
	}
	var digits []byte
	for v > 0 {
		digits = append([]byte{byte('0' + v%10)}, digits...)
		v /= 10
	}
	return string(digits)
}

// window sends 4 frames inside second n and one frame of the next second,
// which closes the window [n*1000, (n+1)*1000).
func (h *harness) window(n int64, pressure float64) {
	for i := int64(0); i < 4; i++ {
		h.frames <- frame(n*1000+100+i*200, pressure)
	}
	h.frames <- frame((n+1)*1000+50, pressure)
}

func value(m *gaugev1.Measurement) float64 { return m.GetValue() }

// ----------------------------------------------------------------- tests ----

func TestConfigIsAppliedAndFramesBecomeTelemetry(t *testing.T) {
	h := newHarness(t, t.TempDir(), nil)
	h.start()
	h.configure("7")

	if _, err := os.Stat(filepath.Join(h.cfg.ConfigDir, "PRESS_01.json")); err != nil {
		t.Errorf("config file for the pipeline: %v", err)
	}
	reload := h.pipeline.commands[0]
	if reload.GetType() != gaugev1.CommandType_COMMAND_TYPE_RELOAD_CONFIG || reload.GetConfigVersion() != 7 || reload.GetMachineId() != "PRESS_01" {
		t.Errorf("reload command: %v", reload)
	}

	h.window(1700000000, 60)
	h.eventually("telemetry", func() bool { return len(h.telemetry()) == 1 })
	tel := h.telemetry()[0]

	if tel.GetSeq() != 1 || tel.GetEdgeId() != "edge-7" || tel.GetMachineId() != "PRESS_01" || tel.GetReplayed() {
		t.Errorf("header: %v", tel)
	}
	if tel.GetWindowStartMs() != 1700000000000 || tel.GetWindowEndMs() != 1700000001000 {
		t.Errorf("window: %d..%d", tel.GetWindowStartMs(), tel.GetWindowEndMs())
	}
	if tel.GetConfigVersion() != 7 || tel.GetModelVersion() != "dial_pose=dial-0.3,digit_cls=digit-0.2" {
		t.Errorf("versions: %d %q", tel.GetConfigVersion(), tel.GetModelVersion())
	}
	if len(tel.GetMeasurements()) != 2 {
		t.Fatalf("measurements: %v", tel.GetMeasurements())
	}
	dial, volt := tel.GetMeasurements()[0], tel.GetMeasurements()[1]
	if dial.GetGaugeId() != "MAIN_PRESSURE" || math.Abs(value(dial)-60) > 0.1 || dial.GetNFrames() != 4 || dial.GetUnit() != "bar" {
		t.Errorf("dial: %v", dial)
	}
	if volt.GetGaugeId() != "VOLTMETER" || value(volt) != 220.5 || volt.GetQuality() < 0.9 {
		t.Errorf("voltmeter: %v", volt)
	}
}

func TestConfigVersionIsReportedOnlyAfterThePipelineConfirms(t *testing.T) {
	h := newHarness(t, t.TempDir(), nil)
	h.pipeline.fail = 3
	h.start()
	h.eventually("config subscription", func() bool { return h.broker.inject(configTopic, stationConfig("7")) })
	h.eventually("failed reloads", func() bool { return h.pipeline.count(gaugev1.CommandType_COMMAND_TYPE_RELOAD_CONFIG) >= 2 })

	// Not confirmed yet: frames are not decoded and the heartbeat reports no config.
	h.window(1700000000, 60)
	for _, st := range h.statuses() {
		if st.GetConfigVersion() != 0 {
			t.Fatalf("version %d reported before the pipeline confirmed", st.GetConfigVersion())
		}
	}

	h.eventually("config active after retries", func() bool {
		st := h.statuses()
		return len(st) > 0 && st[len(st)-1].GetConfigVersion() == 7
	})
	if got := h.pipeline.count(gaugev1.CommandType_COMMAND_TYPE_RELOAD_CONFIG); got != 4 {
		t.Errorf("%d reload commands, want 4 (3 failures, then success)", got)
	}
	if len(h.telemetry()) != 0 {
		t.Errorf("telemetry was produced without a confirmed config")
	}
	if testutil.ToFloat64(h.metrics.FramesDropped.WithLabelValues("no_config")) == 0 {
		t.Error("frames without config were not counted")
	}
}

func TestOlderOrEqualConfigIsIgnored(t *testing.T) {
	h := newHarness(t, t.TempDir(), nil)
	h.start()
	h.configure("7")
	h.broker.inject(configTopic, stationConfig("6"))
	h.broker.inject(configTopic, stationConfig("7"))
	h.configure("9")

	if got := h.pipeline.count(gaugev1.CommandType_COMMAND_TYPE_RELOAD_CONFIG); got != 2 {
		t.Errorf("%d reloads, want 2 (versions 7 and 9)", got)
	}
}

func TestTelemetryIsBufferedOfflineAndReplayed(t *testing.T) {
	dir := t.TempDir()
	h := newHarness(t, dir, nil)
	// A config from a previous run lets the agent work without the broker.
	if err := os.MkdirAll(h.cfg.ConfigDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(h.cfg.ConfigDir, "PRESS_01.json"), stationConfig("7"), 0o644); err != nil {
		t.Fatal(err)
	}
	h.broker.setDown(true)
	h.start()
	h.eventually("stored config confirmed", func() bool { return h.pipeline.count(gaugev1.CommandType_COMMAND_TYPE_RELOAD_CONFIG) == 1 })
	time.Sleep(30 * time.Millisecond)

	for n := int64(0); n < 5; n++ {
		h.window(1700000000+n, 50+float64(n))
	}
	h.eventually("5 buffered messages", func() bool {
		stats, _ := h.store.Stats(context.Background())
		return stats.UnsentMessages == 5
	})
	if len(h.broker.snapshot()) != 0 {
		t.Fatal("something was published while the broker was down")
	}

	h.broker.setDown(false)
	h.eventually("replay", func() bool { return len(h.telemetry()) == 5 })
	for i, tel := range h.telemetry() {
		if tel.GetSeq() != uint64(i+1) || !tel.GetReplayed() {
			t.Errorf("message %d: seq %d replayed=%v", i, tel.GetSeq(), tel.GetReplayed())
		}
	}
	h.eventually("buffer drained", func() bool {
		stats, _ := h.store.Stats(context.Background())
		return stats.UnsentMessages == 0
	})

	// Back online: new telemetry is realtime. The next frames first close the
	// window left open above (seq 6), then their own (seq 7).
	h.window(1700000010, 70)
	h.eventually("realtime messages", func() bool { return len(h.telemetry()) == 7 })
	for i, tel := range h.telemetry()[5:] {
		if tel.GetSeq() != uint64(6+i) || tel.GetReplayed() {
			t.Errorf("realtime message: seq %d replayed=%v", tel.GetSeq(), tel.GetReplayed())
		}
	}
}

func TestSequenceAndBufferSurviveARestart(t *testing.T) {
	dir := t.TempDir()
	first := newHarness(t, dir, nil)
	_ = os.MkdirAll(first.cfg.ConfigDir, 0o755)
	_ = os.WriteFile(filepath.Join(first.cfg.ConfigDir, "PRESS_01.json"), stationConfig("7"), 0o644)
	first.broker.setDown(true)
	first.start()
	first.eventually("config confirmed", func() bool { return first.pipeline.count(gaugev1.CommandType_COMMAND_TYPE_RELOAD_CONFIG) == 1 })
	time.Sleep(30 * time.Millisecond)
	for n := int64(0); n < 3; n++ {
		first.window(1700000000+n, 50)
	}
	first.eventually("3 buffered", func() bool {
		stats, _ := first.store.Stats(context.Background())
		return stats.UnsentMessages >= 3
	})
	first.shutdown() // closes the open window too: 4 messages in total

	second := newHarness(t, dir, nil)
	second.start()
	second.eventually("replay after restart", func() bool { return len(second.telemetry()) == 4 })
	for i, tel := range second.telemetry() {
		if tel.GetSeq() != uint64(i+1) || !tel.GetReplayed() {
			t.Errorf("message %d: seq %d replayed=%v", i, tel.GetSeq(), tel.GetReplayed())
		}
	}
	second.eventually("config confirmed again", func() bool {
		st := second.statuses()
		return len(st) > 0 && st[len(st)-1].GetConfigVersion() == 7
	})
	second.window(1700000100, 50)
	second.eventually("next message", func() bool { return len(second.telemetry()) == 5 })
	if next := second.telemetry()[4]; next.GetSeq() != 5 {
		t.Errorf("seq after restart: %d, want 5", next.GetSeq())
	}
}

func TestResendRequestRepublishesAndReportsMissingRanges(t *testing.T) {
	h := newHarness(t, t.TempDir(), nil)
	h.start()
	h.configure("7")
	for n := int64(0); n < 6; n++ {
		h.window(1700000000+n, 50)
	}
	h.eventually("6 messages", func() bool { return len(h.telemetry()) == 6 })

	acks := func() []*gaugev1.ResendAck {
		var out []*gaugev1.ResendAck
		for _, p := range h.broker.snapshot() {
			if p.topic == resendTopic+"/ack" {
				var ack gaugev1.ResendAck
				_ = proto.Unmarshal(p.payload, &ack)
				out = append(out, &ack)
			}
		}
		return out
	}
	request := func(id, from, to uint64, edge string) {
		payload, _ := proto.Marshal(&gaugev1.ResendRequest{EdgeId: edge, FromSeq: from, ToSeq: to, RequestId: id})
		if !h.broker.inject(resendTopic, payload) {
			t.Fatal("the agent is not subscribed to its resend topic")
		}
	}

	request(1, 2, 4, "edge-7")
	h.eventually("first ack", func() bool { return len(acks()) == 1 })
	if ack := acks()[0]; ack.GetRequestId() != 1 || ack.GetResent() != 3 || len(ack.GetMissing()) != 0 || ack.GetError() != "" {
		t.Errorf("ack 1: %v", ack)
	}
	all := h.telemetry()
	if len(all) != 9 {
		t.Fatalf("%d telemetry messages, want 6 + 3 resent", len(all))
	}
	for i, tel := range all[6:] {
		if tel.GetSeq() != uint64(i+2) || !tel.GetReplayed() {
			t.Errorf("resent %d: seq %d replayed=%v", i, tel.GetSeq(), tel.GetReplayed())
		}
	}

	// Seq 7..9 were never produced: reported as not in the buffer.
	request(2, 5, 9, "edge-7")
	h.eventually("second ack", func() bool { return len(acks()) == 2 })
	ack := acks()[1]
	if ack.GetResent() != 2 || len(ack.GetMissing()) != 1 || ack.GetMissing()[0].GetFromSeq() != 7 || ack.GetMissing()[0].GetToSeq() != 9 {
		t.Errorf("ack 2: %v", ack)
	}

	request(3, 1, 10001, "edge-7")
	h.eventually("third ack", func() bool { return len(acks()) == 3 })
	if ack := acks()[2]; ack.GetError() == "" || ack.GetResent() != 0 {
		t.Errorf("oversized range must be refused: %v", ack)
	}

	// A request for another edge is ignored.
	request(4, 1, 2, "edge-8")
	time.Sleep(50 * time.Millisecond)
	if len(acks()) != 3 {
		t.Errorf("a request for another edge was answered")
	}
}

func TestSilentPipelineIsReportedStaleAndToldToRestart(t *testing.T) {
	h := newHarness(t, t.TempDir(), func(c *Config) {
		c.StaleAfter, c.StartupGrace = 120*time.Millisecond, 400*time.Millisecond
	})
	h.start()
	h.configure("7")

	// Before the first frame the longer startup grace applies: opening a
	// camera takes time and must not trigger a restart.
	time.Sleep(250 * time.Millisecond)
	if len(h.telemetry()) != 0 || h.pipeline.count(gaugev1.CommandType_COMMAND_TYPE_RESTART) != 0 {
		t.Fatal("stale declared within the startup grace")
	}
	h.window(time.Now().Unix()-10, 60)
	h.eventually("first window", func() bool { return len(h.telemetry()) == 1 })

	// The frame left in the open window is flushed with its own timestamps,
	// then the silence is reported.
	isStale := func(tel *gaugev1.Telemetry) bool {
		for _, m := range tel.GetMeasurements() {
			if m.Value != nil || len(m.GetFlags()) != 1 || m.GetFlags()[0] != gaugev1.Flag_FLAG_STALE {
				return false
			}
		}
		return len(tel.GetMeasurements()) == 2
	}
	h.eventually("stale telemetry", func() bool {
		all := h.telemetry()
		return len(all) >= 3 && isStale(all[len(all)-1])
	})
	all := h.telemetry()
	if flushed := all[1]; isStale(flushed) || flushed.GetWindowEndMs() != all[0].GetWindowEndMs()+1000 {
		t.Errorf("open window not flushed in its own window: %v", flushed)
	}
	if stale := all[len(all)-1]; stale.GetWindowEndMs() <= all[1].GetWindowEndMs() {
		t.Errorf("stale window is not after the data: %v", stale)
	}
	h.eventually("restart command", func() bool { return h.pipeline.count(gaugev1.CommandType_COMMAND_TYPE_RESTART) == 1 })
	if testutil.ToFloat64(h.metrics.PipelineStale) != 1 {
		t.Error("stale gauge not set")
	}

	// Frames again: the machine recovers and no second restart is sent.
	h.window(time.Now().Unix()+5, 60)
	h.eventually("recovery", func() bool { return testutil.ToFloat64(h.metrics.PipelineStale) == 0 })
	if h.pipeline.count(gaugev1.CommandType_COMMAND_TYPE_RESTART) != 1 {
		t.Error("more than one restart for a single outage")
	}
}

func TestLateAndUnknownFramesAreDropped(t *testing.T) {
	h := newHarness(t, t.TempDir(), nil)
	h.start()
	h.configure("7")

	h.window(1700000005, 60)
	h.frames <- frame(1700000001500, 10) // a window that was already closed
	other := frame(1700000006500, 10)
	other.CameraId = "SOMEONE_ELSE"
	h.frames <- other
	h.window(1700000006, 60)

	h.eventually("two windows", func() bool { return len(h.telemetry()) == 2 })
	for _, tel := range h.telemetry() {
		if v := value(tel.GetMeasurements()[0]); math.Abs(v-60) > 0.1 {
			t.Errorf("a dropped frame leaked into a window: %v", v)
		}
	}
	if testutil.ToFloat64(h.metrics.FramesDropped.WithLabelValues("late")) != 1 ||
		testutil.ToFloat64(h.metrics.FramesDropped.WithLabelValues("unknown_camera")) != 1 {
		t.Error("dropped frames not counted")
	}
}

func TestShutdownFlushesTheOpenWindowAndGoesOffline(t *testing.T) {
	h := newHarness(t, t.TempDir(), nil)
	h.start()
	h.configure("7")
	h.frames <- frame(1700000000200, 42)
	h.frames <- frame(1700000000700, 42)
	h.eventually("frames consumed", func() bool { return testutil.ToFloat64(h.metrics.Frames) == 2 })

	h.shutdown()

	tel := h.telemetry()
	if len(tel) != 1 || math.Abs(value(tel[0].GetMeasurements()[0])-42) > 0.1 {
		t.Fatalf("open window not flushed: %v", tel)
	}
	st := h.statuses()
	if last := st[len(st)-1]; last.GetState() != gaugev1.State_STATE_OFFLINE || len(last.GetMachineIds()) != 1 {
		t.Errorf("last status: %v", last)
	}
}

func TestParseMachinesAndTopics(t *testing.T) {
	machines, err := ParseMachines(" DENSO_HN/L03/PRESS_01 , DENSO_HN/L03/PRESS_02")
	if err != nil || len(machines) != 2 || machines[1].Machine != "PRESS_02" {
		t.Fatalf("got %v, %v", machines, err)
	}
	if _, err := ParseMachines("DENSO_HN/PRESS_01"); err == nil {
		t.Error("malformed machine accepted")
	}
	cfg := DefaultConfig()
	cfg.EdgeID, cfg.Machines, cfg.ConfigDir = "edge-7", machines, "/tmp/x"
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	if cfg.statusTopic() != "denso/DENSO_HN/L03/PRESS_01/status" || cfg.resendTopic() != "denso/DENSO_HN/edge/edge-7/cmd/resend" ||
		cfg.resendAckTopic() != "denso/DENSO_HN/edge/edge-7/cmd/resend/ack" {
		t.Errorf("topics: %s %s %s", cfg.statusTopic(), cfg.resendTopic(), cfg.resendAckTopic())
	}
	cfg.Machines = append(cfg.Machines, machines[0])
	if err := cfg.Validate(); err == nil {
		t.Error("duplicate machine accepted")
	}
}
