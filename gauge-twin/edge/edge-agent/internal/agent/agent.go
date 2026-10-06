package agent

import (
	"context"
	"fmt"
	"log/slog"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"golang.org/x/time/rate"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	"gauge-twin/edge/decode"
	"gauge-twin/edge/edge-agent/internal/store"
	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

const (
	schemaVersion     = 1
	swVersion         = "edge-agent-0.1"
	maxResendRange    = 10000
	connectTimeout    = 10 * time.Second
	restartEvery      = time.Minute // at most one RESTART command in this period
	replayBatch       = 50
	inboxSize         = 256
	commandResultSize = 16
)

// Pipeline sends a command to the video pipeline and returns its reply.
type Pipeline interface {
	Do(ctx context.Context, cmd *gaugev1.Command) (*gaugev1.CommandReply, error)
}

// machine is the per-camera state.
type machine struct {
	ref MachineRef

	// active is the config the pipeline confirmed; pending waits for that
	// confirmation.
	active      *gaugev1.StationConfig
	pending     *gaugev1.StationConfig
	reloading   bool
	retryAt     time.Time
	aggregators []*decode.Aggregator
	byGauge     map[string]*decode.Aggregator
	windowMs    int64

	haveWindow bool
	window     int64 // index of the open window: frame_ts_ms / windowMs
	lastEndMs  int64 // end of the last emitted window
	lastFrame  time.Time
	// seenFrame is false until the pipeline delivered a frame since the last
	// config activation or pipeline restart; until then the longer startup
	// grace applies (opening a camera stream takes a while).
	seenFrame bool
	stale     bool
}

type inbound struct {
	topic   string
	payload []byte
}

type commandResult struct {
	machine string
	version uint32
	kind    gaugev1.CommandType
	reply   *gaugev1.CommandReply
	err     error
}

// resendJob is a resend request being served.
type resendJob struct {
	request  *gaugev1.ResendRequest
	messages []store.Message
	missing  []store.SeqRange
	next     int
	resent   uint32
}

// Agent owns all runtime state; everything runs on the goroutine of Run.
type Agent struct {
	cfg       Config
	transport Transport
	pipeline  Pipeline
	store     *store.Store
	metrics   *Metrics
	logger    *slog.Logger
	rng       *rand.Rand

	machines map[string]*machine
	frames   <-chan *gaugev1.FrameResult
	inbox    chan inbound
	commands chan commandResult

	sess       Session
	everOnline bool
	backoff    time.Duration
	limiter    *rate.Limiter
	reconnect  *time.Timer
	replay     *time.Timer
	replayOn   bool
	backlog    bool // unsent messages may exist in the store
	queue      []store.Message
	resends    []*resendJob

	framesSinceStatus int
	lastStatus        time.Time
	lastRestart       time.Time // last RESTART command; it restarts the whole pipeline
}

// New builds an agent. frames delivers the pipeline output.
func New(cfg Config, tr Transport, pipeline Pipeline, st *store.Store, frames <-chan *gaugev1.FrameResult,
	metrics *Metrics, logger *slog.Logger) (*Agent, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	a := &Agent{
		cfg: cfg, transport: tr, pipeline: pipeline, store: st, metrics: metrics,
		logger:   logger.With("edge_id", cfg.EdgeID),
		rng:      rand.New(rand.NewSource(time.Now().UnixNano())),
		machines: map[string]*machine{},
		frames:   frames,
		inbox:    make(chan inbound, inboxSize),
		commands: make(chan commandResult, commandResultSize),
		backoff:  cfg.BackoffMin,
		limiter:  rate.NewLimiter(rate.Limit(cfg.ReplayRate), 1),
		backlog:  true, // messages of a previous run may be waiting
	}
	for _, ref := range cfg.Machines {
		a.machines[ref.Machine] = &machine{ref: ref}
	}
	return a, nil
}

// Run drives the agent until ctx is cancelled.
func (a *Agent) Run(ctx context.Context) {
	if err := os.MkdirAll(a.cfg.ConfigDir, 0o755); err != nil {
		a.logger.Error("create config directory", "error", err)
	}
	now := time.Now()
	a.lastStatus = now
	for _, m := range a.machines {
		m.lastFrame = now
		a.loadStoredConfig(m)
	}

	tick := time.NewTicker(a.cfg.Tick)
	defer tick.Stop()
	heartbeat := time.NewTicker(a.cfg.Heartbeat)
	defer heartbeat.Stop()
	a.reconnect = time.NewTimer(0)
	defer a.reconnect.Stop()
	a.replay = time.NewTimer(time.Hour)
	a.replay.Stop()
	defer a.replay.Stop()
	lastPrune := now

	for {
		var lost <-chan struct{}
		var replay <-chan time.Time
		if a.sess != nil {
			lost = a.sess.Done()
			if a.backlog || len(a.queue) > 0 || len(a.resends) > 0 {
				if !a.replayOn {
					a.replay.Reset(a.limiter.Reserve().Delay())
					a.replayOn = true
				}
				replay = a.replay.C
			}
		}

		select {
		case <-ctx.Done():
			a.shutdown()
			return
		case frame, ok := <-a.frames:
			if !ok {
				a.frames = nil
				continue
			}
			a.handleFrame(frame)
		case msg := <-a.inbox:
			a.handleMessage(msg)
		case res := <-a.commands:
			a.handleCommandResult(res)
		case now := <-tick.C:
			a.watchdog(now)
			a.retryReloads(now)
			if now.Sub(lastPrune) >= a.cfg.PruneEvery {
				lastPrune = now
				a.prune()
			}
		case <-heartbeat.C:
			a.publishStatus(gaugev1.State_STATE_ONLINE)
		case <-lost:
			a.logger.Warn("mqtt connection lost")
			a.dropSession()
		case <-a.reconnect.C:
			a.connect()
		case <-replay:
			a.replayOn = false
			a.replayOne()
		}
	}
}

// ------------------------------------------------------------- frames ----

func (a *Agent) handleFrame(frame *gaugev1.FrameResult) {
	a.metrics.Frames.Inc()
	a.framesSinceStatus++
	m, ok := a.machines[frame.GetCameraId()]
	if !ok {
		a.metrics.FramesDropped.WithLabelValues("unknown_camera").Inc()
		return
	}
	m.lastFrame, m.seenFrame = time.Now(), true
	if m.stale {
		m.stale = false
		a.metrics.PipelineStale.Dec()
		a.logger.Info("pipeline is producing frames again", "machine_id", m.ref.Machine)
	}
	if m.active == nil {
		a.metrics.FramesDropped.WithLabelValues("no_config").Inc()
		return
	}
	// Windows follow the frame timestamps, never the local clock.
	index := frame.GetFrameTsMs() / m.windowMs
	switch {
	case !m.haveWindow:
		m.haveWindow, m.window = true, index
	case index < m.window:
		a.metrics.FramesDropped.WithLabelValues("late").Inc()
		return
	case index > m.window:
		a.closeWindow(m, (m.window+1)*m.windowMs, false)
		m.window = index
	}
	for _, roi := range frame.GetRois() {
		if agg, ok := m.byGauge[roi.GetGaugeId()]; ok {
			agg.Add(agg.Gauge.Read(frame.GetFrameTsMs(), roi, a.cfg.Decode))
		}
	}
}

// closeWindow emits the telemetry of the window ending at endMs, if any
// measurement is due.
func (a *Agent) closeWindow(m *machine, endMs int64, stale bool) {
	if endMs <= m.lastEndMs {
		return
	}
	var due []*gaugev1.Measurement
	for _, agg := range m.aggregators {
		if res := agg.Close(endMs, stale); res.Due {
			due = append(due, res.Measurement)
		}
	}
	m.lastEndMs = endMs
	if len(due) == 0 {
		return
	}
	tel := &gaugev1.Telemetry{
		SchemaVersion: schemaVersion,
		EdgeId:        a.cfg.EdgeID,
		MachineId:     m.ref.Machine,
		WindowStartMs: endMs - m.windowMs,
		WindowEndMs:   endMs,
		ConfigVersion: m.active.GetConfigVersion(),
		ModelVersion:  modelVersion(m.active),
		Measurements:  due,
	}
	// Written to disk first; only then published.
	msg, err := a.store.Append(context.Background(), a.cfg.machineTopic(m.ref, "telemetry"), func(seq uint64) ([]byte, error) {
		tel.Seq = seq
		return proto.Marshal(tel)
	})
	if err != nil {
		a.logger.Error("buffer write failed; telemetry lost", "error", err, "machine_id", m.ref.Machine)
		return
	}
	if a.sess == nil {
		a.backlog = true
		return
	}
	a.deliver(msg, msg.Payload, "realtime")
}

func modelVersion(cfg *gaugev1.StationConfig) string {
	names := make([]string, 0, len(cfg.GetModelVersions()))
	for name := range cfg.GetModelVersions() {
		names = append(names, name)
	}
	sort.Strings(names)
	parts := make([]string, len(names))
	for i, name := range names {
		parts[i] = name + "=" + cfg.GetModelVersions()[name]
	}
	return strings.Join(parts, ",")
}

// watchdog reacts to a silent pipeline: the affected machine reports
// FLAG_STALE measurements and the pipeline is told to restart.
func (a *Agent) watchdog(now time.Time) {
	restart := false
	for _, m := range a.machines {
		limit := a.cfg.StaleAfter
		if !m.seenFrame {
			limit = a.cfg.StartupGrace
		}
		if m.active == nil || now.Sub(m.lastFrame) < limit {
			continue
		}
		if !m.stale {
			m.stale = true
			a.metrics.PipelineStale.Inc()
			a.logger.Warn("pipeline produced no frame", "machine_id", m.ref.Machine, "for", now.Sub(m.lastFrame).String())
		}
		// Frames received before the silence belong to their own window.
		if m.haveWindow {
			a.closeWindow(m, (m.window+1)*m.windowMs, false)
			m.haveWindow = false
		}
		// One stale report per StaleAfter, on a window aligned like the others.
		endMs := (now.UnixMilli() / m.windowMs) * m.windowMs
		if endMs-m.lastEndMs >= a.cfg.StaleAfter.Milliseconds() || m.lastEndMs == 0 {
			a.closeWindow(m, endMs, true)
		}
		restart = true
	}
	// RESTART restarts the whole pipeline, so it is sent at most once per
	// period and every camera gets the startup grace again.
	if restart && now.Sub(a.lastRestart) >= restartEvery {
		a.lastRestart = now
		for _, m := range a.machines {
			m.seenFrame, m.lastFrame = false, now
		}
		a.command(a.machines[a.cfg.Machines[0].Machine], &gaugev1.Command{Type: gaugev1.CommandType_COMMAND_TYPE_RESTART})
	}
}

// --------------------------------------------------------------- mqtt ----

func (a *Agent) onMessage(topic string, payload []byte) {
	select {
	case a.inbox <- inbound{topic, append([]byte(nil), payload...)}:
	default:
		a.logger.Warn("inbox full, dropping message", "topic", topic)
	}
}

func (a *Agent) connect() {
	if a.sess != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), connectTimeout)
	defer cancel()
	// The will is built now, so its ts_ms is the connect time.
	will := Will{Topic: a.cfg.statusTopic(), Payload: a.status(gaugev1.State_STATE_OFFLINE)}
	sess, err := a.transport.Connect(ctx, a.cfg.EdgeID, will, a.onMessage)
	if err == nil {
		topics := []string{a.cfg.resendTopic()}
		for _, ref := range a.cfg.Machines {
			topics = append(topics, a.cfg.machineTopic(ref, "config"))
		}
		if err = sess.Subscribe(ctx, topics); err != nil {
			sess.Close(false)
		}
	}
	if err != nil {
		// Exponential backoff with +-50% jitter, capped.
		wait := time.Duration(float64(a.backoff) * (0.5 + a.rng.Float64()))
		a.backoff = min(a.backoff*2, a.cfg.BackoffMax)
		a.logger.Warn("mqtt connect failed", "error", err, "retry_in", wait.String())
		a.reconnect.Reset(wait)
		return
	}
	a.sess = sess
	a.backoff = a.cfg.BackoffMin
	a.backlog = true
	a.metrics.Connected.Set(1)
	if a.everOnline {
		a.metrics.Reconnects.Inc()
	}
	a.everOnline = true
	a.logger.Info("mqtt connected")
	a.publishStatus(gaugev1.State_STATE_ONLINE)
}

// dropSession abandons the connection and schedules a reconnect.
func (a *Agent) dropSession() {
	if a.sess == nil {
		return
	}
	a.sess.Close(false)
	a.sess = nil
	a.metrics.Connected.Set(0)
	wait := time.Duration(float64(a.backoff) * (0.5 + a.rng.Float64()))
	a.backoff = min(a.backoff*2, a.cfg.BackoffMax)
	a.reconnect.Reset(wait)
}

func (a *Agent) publish(topic string, payload []byte, retain bool) error {
	ctx, cancel := context.WithTimeout(context.Background(), a.cfg.PublishTimeout)
	defer cancel()
	if err := a.sess.Publish(ctx, topic, payload, retain); err != nil {
		a.metrics.PublishErrors.Inc()
		return err
	}
	return nil
}

// deliver publishes a stored message and marks it acknowledged. On failure
// the message simply stays unsent in the store and is replayed later.
func (a *Agent) deliver(msg store.Message, payload []byte, kind string) bool {
	if err := a.publish(msg.Topic, payload, false); err != nil {
		a.logger.Warn("publish failed", "error", err, "seq", msg.Seq)
		a.backlog = true
		a.dropSession()
		return false
	}
	if !msg.Acked {
		if err := a.store.MarkAcked(context.Background(), msg.Seq); err != nil {
			a.logger.Error("buffer update failed", "error", err, "seq", msg.Seq)
		}
	}
	a.metrics.Sent.WithLabelValues(kind).Inc()
	return true
}

// asReplayed returns the payload with replayed = true.
func asReplayed(payload []byte) ([]byte, error) {
	var tel gaugev1.Telemetry
	if err := proto.Unmarshal(payload, &tel); err != nil {
		return nil, err
	}
	tel.Replayed = true
	return proto.Marshal(&tel)
}

// replayOne sends one buffered or requested message; the caller rate-limits.
// The offline backlog goes before resend requests.
func (a *Agent) replayOne() {
	if a.sess == nil {
		return
	}
	if len(a.queue) == 0 && a.backlog {
		unsent, err := a.store.Unsent(context.Background(), 0, replayBatch)
		if err != nil {
			a.logger.Error("buffer read failed", "error", err)
			return
		}
		a.queue = unsent
		a.backlog = len(unsent) == replayBatch
	}
	if len(a.queue) > 0 {
		msg := a.queue[0]
		a.queue = a.queue[1:]
		payload, err := asReplayed(msg.Payload)
		if err != nil {
			a.logger.Error("stored message does not decode; skipping", "seq", msg.Seq, "error", err)
			_ = a.store.MarkAcked(context.Background(), msg.Seq)
			return
		}
		if !a.deliver(msg, payload, "replay") {
			a.queue = nil
		}
		return
	}
	if len(a.resends) > 0 {
		a.resendOne()
	}
}

func (a *Agent) status(state gaugev1.State) []byte {
	primary := a.machines[a.cfg.Machines[0].Machine]
	st := &gaugev1.Status{
		EdgeId:    a.cfg.EdgeID,
		TsMs:      time.Now().UnixMilli(),
		State:     state,
		SwVersion: swVersion,
	}
	for _, ref := range a.cfg.Machines {
		st.MachineIds = append(st.MachineIds, ref.Machine)
	}
	// Only a config the pipeline confirmed is reported.
	if primary.active != nil {
		st.ConfigVersion = primary.active.GetConfigVersion()
		st.ModelVersion = modelVersion(primary.active)
	}
	if elapsed := time.Since(a.lastStatus).Seconds(); elapsed > 0 {
		st.FpsActual = float32(float64(a.framesSinceStatus) / elapsed / float64(len(a.cfg.Machines)))
	}
	if stats, err := a.store.Stats(context.Background()); err == nil {
		st.BufferBytes, st.BufferMsgs = uint64(stats.TotalBytes), uint64(stats.UnsentMessages)
		a.metrics.BufferBytes.Set(float64(stats.TotalBytes))
		a.metrics.BufferMessages.Set(float64(stats.UnsentMessages))
	}
	payload, _ := proto.Marshal(st)
	return payload
}

func (a *Agent) publishStatus(state gaugev1.State) {
	payload := a.status(state)
	if a.sess == nil {
		return
	}
	a.framesSinceStatus, a.lastStatus = 0, time.Now()
	if err := a.publish(a.cfg.statusTopic(), payload, true); err != nil {
		a.logger.Warn("status publish failed", "error", err)
		a.dropSession()
	}
}

func (a *Agent) prune() {
	expired, dropped, err := a.store.Prune(context.Background())
	if err != nil {
		a.logger.Error("buffer prune failed", "error", err)
		return
	}
	if dropped > 0 {
		a.metrics.BufferDropped.Add(float64(dropped))
		a.logger.Error("buffer full: unsent messages dropped", "dropped", dropped)
	}
	if expired > 0 {
		a.logger.Debug("buffer pruned", "expired", expired)
	}
}

func (a *Agent) shutdown() {
	// Close the open windows so the last readings are not lost.
	for _, m := range a.machines {
		if m.active != nil && m.haveWindow {
			a.closeWindow(m, (m.window+1)*m.windowMs, false)
		}
	}
	if a.sess != nil {
		a.publishStatus(gaugev1.State_STATE_OFFLINE)
	}
	if a.sess != nil {
		a.sess.Close(true)
		a.sess = nil
		a.metrics.Connected.Set(0)
	}
}

// ------------------------------------------------------------ messages ----

func (a *Agent) handleMessage(msg inbound) {
	if msg.topic == a.cfg.resendTopic() {
		a.handleResend(msg.payload)
		return
	}
	for _, m := range a.machines {
		if msg.topic == a.cfg.machineTopic(m.ref, "config") {
			a.handleConfig(m, msg.payload)
			return
		}
	}
	a.logger.Warn("message on unexpected topic", "topic", msg.topic)
}

func (a *Agent) configPath(m *machine) string {
	return filepath.Join(a.cfg.ConfigDir, m.ref.Machine+".json")
}

func parseConfig(payload []byte, machineID string) (*gaugev1.StationConfig, []*decode.Gauge, error) {
	var cfg gaugev1.StationConfig
	if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(payload, &cfg); err != nil {
		return nil, nil, fmt.Errorf("decode config: %w", err)
	}
	if cfg.GetMachineId() != machineID {
		return nil, nil, fmt.Errorf("config is for machine %q", cfg.GetMachineId())
	}
	if cfg.GetWindowSec() == 0 {
		return nil, nil, fmt.Errorf("window_sec must be positive")
	}
	gauges := make([]*decode.Gauge, 0, len(cfg.GetGauges()))
	for _, g := range cfg.GetGauges() {
		gauge, err := decode.NewGauge(g)
		if err != nil {
			return nil, nil, err
		}
		gauges = append(gauges, gauge)
	}
	return &cfg, gauges, nil
}

// handleConfig stores a newer config for the pipeline and asks it to reload.
// The config only becomes active once the pipeline confirmed.
func (a *Agent) handleConfig(m *machine, payload []byte) {
	if len(payload) == 0 {
		return // a cleared retained message
	}
	cfg, _, err := parseConfig(payload, m.ref.Machine)
	if err != nil {
		a.logger.Error("config rejected", "machine_id", m.ref.Machine, "error", err)
		return
	}
	current := uint32(0)
	if m.active != nil {
		current = m.active.GetConfigVersion()
	}
	if m.pending != nil {
		current = max(current, m.pending.GetConfigVersion())
	}
	if cfg.GetConfigVersion() <= current {
		return
	}
	// Written atomically: the pipeline must never read a partial file.
	tmp := a.configPath(m) + ".tmp"
	err = os.WriteFile(tmp, payload, 0o644)
	if err == nil {
		err = os.Rename(tmp, a.configPath(m))
	}
	if err != nil {
		a.logger.Error("config write failed", "machine_id", m.ref.Machine, "error", err)
		return
	}
	a.logger.Info("new config received", "machine_id", m.ref.Machine, "config_version", cfg.GetConfigVersion())
	m.pending = cfg
	a.requestReload(m)
}

// loadStoredConfig picks up the config of a previous run. The pipeline has to
// confirm it again before it is used.
func (a *Agent) loadStoredConfig(m *machine) {
	payload, err := os.ReadFile(a.configPath(m))
	if err != nil {
		return
	}
	cfg, _, err := parseConfig(payload, m.ref.Machine)
	if err != nil {
		a.logger.Warn("stored config ignored", "machine_id", m.ref.Machine, "error", err)
		return
	}
	m.pending = cfg
	a.requestReload(m)
}

func (a *Agent) requestReload(m *machine) {
	if m.reloading || m.pending == nil {
		return
	}
	m.reloading = true
	a.command(m, &gaugev1.Command{
		Type: gaugev1.CommandType_COMMAND_TYPE_RELOAD_CONFIG, ConfigVersion: m.pending.GetConfigVersion(), MachineId: m.ref.Machine,
	})
}

// command runs a pipeline command in the background; the result comes back
// through the event loop.
func (a *Agent) command(m *machine, cmd *gaugev1.Command) {
	go func() {
		reply, err := a.pipeline.Do(context.Background(), cmd)
		a.commands <- commandResult{machine: m.ref.Machine, version: cmd.GetConfigVersion(), kind: cmd.GetType(), reply: reply, err: err}
	}()
}

func (a *Agent) handleCommandResult(res commandResult) {
	m := a.machines[res.machine]
	ok := res.err == nil && res.reply.GetOk()
	result := "ok"
	if !ok {
		result = "failed"
	}
	a.metrics.Commands.WithLabelValues(res.kind.String(), result).Inc()
	if res.kind != gaugev1.CommandType_COMMAND_TYPE_RELOAD_CONFIG {
		if !ok {
			a.logger.Warn("pipeline command failed", "type", res.kind.String(), "error", res.err, "reply", res.reply.GetError())
		}
		return
	}
	m.reloading = false
	if !ok {
		a.logger.Warn("pipeline did not load the config; keeping the previous one", "machine_id", m.ref.Machine,
			"config_version", res.version, "error", res.err, "reply", res.reply.GetError())
		m.retryAt = time.Now().Add(a.cfg.ReloadRetry)
		return
	}
	if m.pending == nil || m.pending.GetConfigVersion() != res.version {
		// A newer config arrived while this one was loading.
		a.requestReload(m)
		return
	}
	a.activate(m)
}

// activate switches the decoder to the confirmed config.
func (a *Agent) activate(m *machine) {
	payload, _ := protojson.Marshal(m.pending)
	_, gauges, err := parseConfig(payload, m.ref.Machine)
	if err != nil {
		a.logger.Error("confirmed config does not build", "machine_id", m.ref.Machine, "error", err)
		m.pending = nil
		return
	}
	// The open window belongs to the old config: close it with the old decoders.
	if m.active != nil && m.haveWindow {
		a.closeWindow(m, (m.window+1)*m.windowMs, false)
	}
	m.active, m.pending = m.pending, nil
	m.windowMs = int64(m.active.GetWindowSec()) * 1000
	m.aggregators = m.aggregators[:0]
	m.byGauge = map[string]*decode.Aggregator{}
	for _, gauge := range gauges {
		agg := decode.NewAggregator(gauge, a.cfg.Decode)
		m.aggregators = append(m.aggregators, agg)
		m.byGauge[gauge.ID] = agg
	}
	m.haveWindow = false
	m.lastFrame, m.seenFrame = time.Now(), false
	a.metrics.ConfigVersion.WithLabelValues(m.ref.Machine).Set(float64(m.active.GetConfigVersion()))
	a.logger.Info("config active", "machine_id", m.ref.Machine, "config_version", m.active.GetConfigVersion())
	// The heartbeat reports the new version only now.
	a.publishStatus(gaugev1.State_STATE_ONLINE)
}

func (a *Agent) retryReloads(now time.Time) {
	for _, m := range a.machines {
		if m.pending != nil && !m.reloading && !now.Before(m.retryAt) {
			a.requestReload(m)
		}
	}
}

// --------------------------------------------------------------- resend ----

func (a *Agent) handleResend(payload []byte) {
	var req gaugev1.ResendRequest
	if err := proto.Unmarshal(payload, &req); err != nil {
		a.logger.Warn("undecodable resend request", "error", err)
		return
	}
	if req.GetEdgeId() != a.cfg.EdgeID {
		return
	}
	a.metrics.Resends.Inc()
	job := &resendJob{request: &req}
	switch {
	case req.GetToSeq() < req.GetFromSeq():
		a.ackResend(job, "to_seq is below from_seq")
		return
	case req.GetToSeq()-req.GetFromSeq() >= maxResendRange:
		a.ackResend(job, fmt.Sprintf("range exceeds %d sequence numbers", maxResendRange))
		return
	}
	messages, missing, err := a.store.Range(context.Background(), req.GetFromSeq(), req.GetToSeq())
	if err != nil {
		a.ackResend(job, "buffer read failed")
		return
	}
	job.messages, job.missing = messages, missing
	a.logger.Info("resend requested", "from_seq", req.GetFromSeq(), "to_seq", req.GetToSeq(),
		"available", len(messages), "missing_ranges", len(missing))
	if len(messages) == 0 {
		a.ackResend(job, "")
		return
	}
	a.resends = append(a.resends, job)
}

// resendOne publishes the next message of the oldest resend request.
func (a *Agent) resendOne() {
	job := a.resends[0]
	msg := job.messages[job.next]
	payload, err := asReplayed(msg.Payload)
	if err == nil {
		if !a.deliver(msg, payload, "resend") {
			return // retried after the reconnect
		}
		job.resent++
	}
	job.next++
	if job.next == len(job.messages) {
		a.resends = a.resends[1:]
		a.ackResend(job, "")
	}
}

func (a *Agent) ackResend(job *resendJob, reason string) {
	ack := &gaugev1.ResendAck{EdgeId: a.cfg.EdgeID, RequestId: job.request.GetRequestId(), Resent: job.resent, Error: reason}
	for _, r := range job.missing {
		ack.Missing = append(ack.Missing, &gaugev1.SeqRange{FromSeq: r.From, ToSeq: r.To})
	}
	payload, _ := proto.Marshal(ack)
	if a.sess == nil {
		return
	}
	if err := a.publish(a.cfg.resendAckTopic(), payload, false); err != nil {
		a.logger.Warn("resend ack failed", "error", err)
		a.dropSession()
	}
}
