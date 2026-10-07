package sim

import (
	"context"
	"fmt"
	"log/slog"
	"math/rand"
	"time"

	"golang.org/x/time/rate"
	"google.golang.org/protobuf/proto"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

const connectTimeout = 10 * time.Second

// Edge simulates one edge agent: a single MQTT connection publishing for one
// or more machines. All of its state is owned by the goroutine running Run.
type Edge struct {
	cfg       Config
	id        string
	machines  []*machine
	transport Transport
	seqlog    *SeqLog
	metrics   *Metrics
	stats     *Stats
	logger    *slog.Logger
	rng       *rand.Rand

	// Status and the last will go to the status topic of the first machine;
	// the message lists every machine of the edge.
	statusTopic string
	machineIDs  []string
	perMessage  []Fault

	// Windows are scheduled on the monotonic clock: window k of every machine
	// covers [startWall + k*Window, startWall + (k+1)*Window). The wall clock
	// is read once, so a clock step or a fast-running clock (both happen in
	// virtual machines) can neither burst nor reorder messages.
	start     time.Time // carries the monotonic reading
	startWall time.Time
	produced  int64 // windows already emitted

	seq       uint64
	buf       *Buffer
	sess      Session
	connected bool // had at least one successful connection
	backoff   *Backoff
	limiter   *rate.Limiter

	// Resend support: the last messages by sequence number, requests waiting
	// to be served, and the inbox fed by the MQTT callback.
	resendTopic string
	kept        map[uint64]*item
	keptOrder   []uint64
	resends     []*resendJob
	inbox       chan []byte

	reconnect   *time.Timer
	replay      *time.Timer
	replayArmed bool
}

func newEdge(cfg Config, index int, tr Transport, seqlog *SeqLog, m *Metrics, stats *Stats, logger *slog.Logger) *Edge {
	// The offset shifts both machine and edge numbering, so instances started
	// with different offsets never share an id.
	index += cfg.Offset / cfg.MachinesPerEdge
	rng := rand.New(rand.NewSource(cfg.Seed + int64(index)*7919))
	first := index * cfg.MachinesPerEdge
	last := min(first+cfg.MachinesPerEdge, cfg.Offset+cfg.Machines)
	e := &Edge{
		cfg:         cfg,
		id:          EdgeID(index),
		transport:   tr,
		seqlog:      seqlog,
		metrics:     m,
		stats:       stats,
		logger:      logger.With("edge_id", EdgeID(index)),
		rng:         rng,
		statusTopic: cfg.TopicPrefix(first) + "/status",
		perMessage:  cfg.Faults.perMessage(),
		buf:         NewBuffer(cfg.BufferMax),
		backoff:     NewBackoff(cfg.BackoffMin, cfg.BackoffMax, rng),
		limiter:     rate.NewLimiter(rate.Limit(cfg.ReplayRate), 1),
	}
	e.resendTopic = fmt.Sprintf("denso/%s/edge/%s/cmd/resend", cfg.Plant, e.id)
	e.kept = map[uint64]*item{}
	e.inbox = make(chan []byte, 64)
	for i := first; i < last; i++ {
		e.machines = append(e.machines, newMachine(cfg, i, rng))
		e.machineIDs = append(e.machineIDs, MachineID(i))
	}
	return e
}

// Run drives the edge until ctx is cancelled, then drains and disconnects.
func (e *Edge) Run(ctx context.Context, startDelay time.Duration) {
	select {
	case <-ctx.Done():
		return
	case <-time.After(startDelay):
	}

	e.start = time.Now()
	e.startWall = e.start.Truncate(time.Millisecond) // Truncate drops the monotonic reading
	tick := time.NewTimer(e.cfg.Window)
	defer tick.Stop()
	heartbeat := time.NewTicker(e.cfg.Heartbeat)
	defer heartbeat.Stop()
	e.reconnect = time.NewTimer(0) // connect right away
	defer e.reconnect.Stop()
	e.replay = time.NewTimer(time.Hour)
	e.replay.Stop()
	defer e.replay.Stop()

	var cut <-chan time.Time
	var cutTimer *time.Timer
	if e.cfg.Faults.Has(FaultDisconnect) {
		cutTimer = time.NewTimer(e.nextCut())
		defer cutTimer.Stop()
		cut = cutTimer.C
	}

	for {
		var lost <-chan struct{}
		var replay <-chan time.Time
		if e.sess != nil {
			lost = e.sess.Done()
			if e.buf.Len() > 0 || len(e.resends) > 0 {
				if !e.replayArmed {
					e.replay.Reset(e.limiter.Reserve().Delay())
					e.replayArmed = true
				}
				replay = e.replay.C
			}
		}

		select {
		case <-ctx.Done():
			e.shutdown()
			return
		case <-tick.C:
			if !e.cfg.produceUntil.IsZero() && time.Now().After(e.cfg.produceUntil) {
				continue // lingering: connected, answering resend requests only
			}
			e.produce()
			next := e.start.Add(time.Duration(e.produced+1) * e.cfg.Window)
			tick.Reset(max(0, time.Until(next)))
		case <-heartbeat.C:
			e.publishStatus(gaugev1.State_STATE_ONLINE)
		case <-lost:
			e.logger.Warn("connection lost")
			e.dropSession(e.backoff.Next())
		case <-e.reconnect.C:
			e.connect()
		case <-replay:
			e.replayArmed = false
			// The offline backlog goes before resend requests.
			if it := e.buf.Pop(); it != nil {
				e.metrics.BufferMessages.Dec()
				e.send(it, true)
			} else if len(e.resends) > 0 {
				e.resendOne()
			}
		case payload := <-e.inbox:
			e.handleResend(payload)
		case <-cut:
			if e.sess != nil {
				e.logger.Info("fault: cutting connection", "for", e.cfg.DisconnectFor.String())
				e.count(FaultDisconnect)
				e.dropSession(e.cfg.DisconnectFor)
			}
			cutTimer.Reset(e.nextCut())
		}
	}
}

// nextCut draws the time until the next simulated network cut.
func (e *Edge) nextCut() time.Duration {
	return time.Duration(e.rng.ExpFloat64() * float64(e.cfg.DisconnectEvery))
}

func (e *Edge) count(f Fault) {
	e.metrics.Faults.WithLabelValues(string(f)).Inc()
	e.stats.Faults.Add(1)
}

// produce builds and sends one message per machine for every window that has
// ended, catching up if the loop was delayed. Windows are contiguous, so
// window_end_ms strictly increases for each machine.
func (e *Edge) produce() {
	due := int64(time.Since(e.start) / e.cfg.Window)
	for ; e.produced < due; e.produced++ {
		start := e.startWall.Add(time.Duration(e.produced) * e.cfg.Window)
		end := start.Add(e.cfg.Window)
		for _, m := range e.machines {
			e.send(e.next(m, start, end), false)
		}
	}
}

// next creates the next message of a machine, possibly with a fault.
func (e *Edge) next(m *machine, start, end time.Time) *item {
	fault := pickFault(e.perMessage, e.cfg.FaultRate, e.rng)
	// A gap is only noticed between two sequence numbers that arrive: the
	// server knows nothing before the first one it sees and nothing after
	// the last. The first messages of an edge and the last ones before
	// production ends are therefore never skipped.
	if fault == FaultGap && (e.seq < 3 ||
		(!e.cfg.produceUntil.IsZero() && time.Until(e.cfg.produceUntil) < 5*e.cfg.Window)) {
		fault = FaultNone
	}
	if fault != FaultNone {
		e.count(fault)
	}
	if fault == FaultBadSchema {
		return &item{raw: badSchemaPayload, topic: m.topic, machineID: m.id,
			windowEndMs: end.UnixMilli(), fault: fault, size: len(badSchemaPayload)}
	}
	e.seq++
	tel := m.build(e.id, e.seq, start, end, e.rng)
	switch fault {
	case FaultOutOfRange:
		applyOutOfRange(tel)
	case FaultClockSkew:
		applyClockSkew(tel, e.cfg.Window, e.rng)
	}
	it := &item{tel: tel, topic: m.topic, machineID: m.id, seq: e.seq,
		windowEndMs: tel.GetWindowEndMs(), fault: fault, size: proto.Size(tel)}
	if e.cfg.Resend || fault == FaultGap {
		e.keep(it)
	}
	return it
}

// send publishes a message, or buffers it when the edge is offline or the
// publish fails. fromBuffer marks messages drained from the offline buffer.
func (e *Edge) send(it *item, fromBuffer bool) {
	if it.fault == FaultGap && !fromBuffer {
		// Logged as acknowledged: to the edge this message was delivered, so
		// the sequence check expects it in the database.
		e.seqlog.Write(e.record(it, FaultGap, false, true))
		return
	}
	if e.sess == nil {
		e.enqueue(it, fromBuffer)
		return
	}
	payload, err := it.payload(fromBuffer)
	if err != nil {
		e.logger.Error("marshal telemetry", "error", err)
		return
	}
	if err := e.publish(it.topic, payload, false); err != nil {
		e.logger.Warn("publish failed", "error", err, "seq", it.seq)
		e.enqueue(it, fromBuffer)
		e.dropSession(e.backoff.Next())
		return
	}
	fault := it.fault
	if fault == FaultDuplicate {
		fault = FaultNone // the first copy is a normal message
	}
	e.acked(it, fault, fromBuffer)

	if it.fault == FaultDuplicate && !fromBuffer {
		if err := e.publish(it.topic, payload, false); err != nil {
			e.dropSession(e.backoff.Next())
			return
		}
		e.acked(it, FaultDuplicate, false)
	}
}

func (e *Edge) publish(topic string, payload []byte, retain bool) error {
	ctx, cancel := context.WithTimeout(context.Background(), e.cfg.PublishTimeout)
	defer cancel()
	started := time.Now()
	err := e.sess.Publish(ctx, topic, payload, retain)
	if err != nil {
		e.metrics.PublishErrors.Inc()
		e.stats.PublishErrors.Add(1)
		return err
	}
	e.metrics.PublishDuration.Observe(time.Since(started).Seconds())
	return nil
}

func (e *Edge) acked(it *item, fault Fault, replayed bool) {
	kind := "realtime"
	if replayed {
		kind = "replay"
		e.stats.Replayed.Add(1)
	}
	e.metrics.Sent.WithLabelValues(kind).Inc()
	e.stats.Acked.Add(1)
	e.seqlog.Write(e.record(it, fault, replayed, true))
}

func (e *Edge) record(it *item, fault Fault, replayed, acked bool) Record {
	return Record{TsMs: time.Now().UnixMilli(), EdgeID: e.id, MachineID: it.machineID, Seq: it.seq,
		WindowEndMs: it.windowEndMs, Fault: string(fault), Replayed: replayed, Acked: acked}
}

// enqueue stores a message in the offline buffer. A message that came out of
// the buffer goes back to the front so the order is kept.
func (e *Edge) enqueue(it *item, front bool) {
	e.metrics.BufferMessages.Inc()
	if front {
		e.buf.PushFront(it)
		return
	}
	if dropped := e.buf.Push(it); dropped != nil {
		e.metrics.BufferMessages.Dec()
		e.metrics.BufferDropped.Inc()
		e.stats.Dropped.Add(1)
		e.seqlog.Write(e.record(dropped, dropped.fault, false, false))
	}
}

// dropSession abandons the current connection without a DISCONNECT (so the
// broker publishes the last will) and schedules the next connection attempt.
func (e *Edge) dropSession(retryIn time.Duration) {
	if e.sess == nil {
		return
	}
	e.sess.Close(false)
	e.sess = nil
	e.metrics.ConnectedEdges.Dec()
	e.reconnect.Reset(retryIn)
}

func (e *Edge) status(state gaugev1.State) []byte {
	payload, _ := proto.Marshal(&gaugev1.Status{
		EdgeId:        e.id,
		MachineIds:    e.machineIDs,
		TsMs:          time.Now().UnixMilli(),
		State:         state,
		SwVersion:     swVersion,
		ConfigVersion: configVersion,
		ModelVersion:  modelVersion,
		FpsActual:     sampleFPS,
		GpuUtil:       float32(0.2 + 0.4*e.rng.Float64()),
		RamBytes:      uint64(2<<30) + uint64(e.rng.Intn(1<<30)),
		BufferBytes:   uint64(e.buf.Bytes()),
		BufferMsgs:    uint64(e.buf.Len()),
	})
	return payload
}

func (e *Edge) connect() {
	if e.sess != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), connectTimeout)
	defer cancel()
	// The will is built now, so its ts_ms is the connect time.
	will := Will{Topic: e.statusTopic, Payload: e.status(gaugev1.State_STATE_OFFLINE)}
	sess, err := e.transport.Connect(ctx, e.id, will, e.onMessage)
	if err != nil {
		e.metrics.ConnectErrors.Inc()
		e.stats.ConnectErrors.Add(1)
		retry := e.backoff.Next()
		e.logger.Warn("connect failed", "error", err, "retry_in", retry.String())
		e.reconnect.Reset(retry)
		return
	}
	e.sess = sess
	e.backoff.Reset()
	e.metrics.ConnectedEdges.Inc()
	if e.connected {
		e.metrics.Reconnects.Inc()
		e.stats.Reconnects.Add(1)
		e.logger.Info("reconnected", "buffered", e.buf.Len())
	}
	e.connected = true
	if e.cfg.Resend {
		if err := sess.Subscribe(ctx, []string{e.resendTopic}); err != nil {
			e.logger.Warn("subscribe failed", "error", err)
			e.dropSession(e.backoff.Next())
			return
		}
	}
	e.publishStatus(gaugev1.State_STATE_ONLINE)
}

func (e *Edge) publishStatus(state gaugev1.State) {
	if e.sess == nil {
		return
	}
	if err := e.publish(e.statusTopic, e.status(state), true); err != nil {
		e.logger.Warn("status publish failed", "error", err)
		e.dropSession(e.backoff.Next())
		return
	}
	e.metrics.StatusSent.Inc()
}

// shutdown flushes the offline buffer (rate limited, bounded by DrainTimeout),
// announces STATE_OFFLINE and disconnects cleanly. Whatever could not be
// delivered is written to the sequence log as not acknowledged.
func (e *Edge) shutdown() {
	ctx, cancel := context.WithTimeout(context.Background(), e.cfg.DrainTimeout)
	defer cancel()
	if e.sess == nil && e.buf.Len() > 0 {
		e.connect()
	}
	for e.sess != nil && e.buf.Len() > 0 {
		if err := e.limiter.Wait(ctx); err != nil {
			break
		}
		e.metrics.BufferMessages.Dec()
		e.send(e.buf.Pop(), true)
	}
	if e.sess != nil {
		e.publishStatus(gaugev1.State_STATE_OFFLINE)
	}
	if e.sess != nil {
		e.sess.Close(true)
		e.sess = nil
		e.metrics.ConnectedEdges.Dec()
	}
	for it := e.buf.Pop(); it != nil; it = e.buf.Pop() {
		e.metrics.BufferMessages.Dec()
		e.stats.Unacked.Add(1)
		e.seqlog.Write(e.record(it, it.fault, false, false))
	}
}

// ---------------------------------------------------------------- resend ----

const maxResendRange = 10000

// resendJob is a resend request being served.
type resendJob struct {
	request *gaugev1.ResendRequest
	items   []*item
	missing []*gaugev1.SeqRange
	next    int
	resent  uint32
}

func (e *Edge) onMessage(_ string, payload []byte) {
	select {
	case e.inbox <- append([]byte(nil), payload...):
	default: // a flood of requests: the server asks again later
	}
}

// keep remembers a message for later resend requests, evicting the oldest.
func (e *Edge) keep(it *item) {
	e.kept[it.seq] = it
	e.keptOrder = append(e.keptOrder, it.seq)
	if len(e.keptOrder) > e.cfg.ResendKeep {
		delete(e.kept, e.keptOrder[0])
		e.keptOrder = e.keptOrder[1:]
	}
}

// handleResend queues the requested range; what is no longer kept is
// reported as missing in the acknowledgement.
func (e *Edge) handleResend(payload []byte) {
	var req gaugev1.ResendRequest
	if err := proto.Unmarshal(payload, &req); err != nil || req.GetEdgeId() != e.id {
		return
	}
	job := &resendJob{request: &req}
	if req.GetToSeq() < req.GetFromSeq() || req.GetToSeq()-req.GetFromSeq() >= maxResendRange {
		e.ackResend(job, "invalid range")
		return
	}
	var gap *gaugev1.SeqRange
	for seq := req.GetFromSeq(); seq <= req.GetToSeq(); seq++ {
		if it, ok := e.kept[seq]; ok {
			job.items = append(job.items, it)
			gap = nil
			continue
		}
		if gap == nil {
			gap = &gaugev1.SeqRange{FromSeq: seq, ToSeq: seq}
			job.missing = append(job.missing, gap)
		}
		gap.ToSeq = seq
	}
	if len(job.items) == 0 {
		e.ackResend(job, "")
		return
	}
	e.resends = append(e.resends, job)
}

// resendOne publishes the next message of the oldest request; the caller
// applies the replay rate limit.
func (e *Edge) resendOne() {
	job := e.resends[0]
	it := job.items[job.next]
	payload, err := it.payload(true)
	if err == nil {
		if err := e.publish(it.topic, payload, false); err != nil {
			e.dropSession(e.backoff.Next())
			return // continued after the reconnect
		}
		job.resent++
		e.stats.Resent.Add(1)
		e.metrics.Sent.WithLabelValues("resend").Inc()
		e.seqlog.Write(e.record(it, FaultNone, true, true))
	}
	job.next++
	if job.next == len(job.items) {
		e.resends = e.resends[1:]
		e.ackResend(job, "")
	}
}

func (e *Edge) ackResend(job *resendJob, reason string) {
	if e.sess == nil {
		return
	}
	payload, _ := proto.Marshal(&gaugev1.ResendAck{EdgeId: e.id, RequestId: job.request.GetRequestId(),
		Resent: job.resent, Missing: job.missing, Error: reason})
	if err := e.publish(e.resendTopic+"/ack", payload, false); err != nil {
		e.dropSession(e.backoff.Next())
	}
}
