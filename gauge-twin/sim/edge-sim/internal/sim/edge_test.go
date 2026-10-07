package sim

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"google.golang.org/protobuf/proto"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

// fakeBroker is an in-memory Transport that records what it is sent.
type fakeBroker struct {
	mu        sync.Mutex
	down      bool
	published []publication
	wills     []publication // last wills the broker would have delivered
	sessions  []*fakeSession
}

type publication struct {
	clientID string
	topic    string
	payload  []byte
	retain   bool
}

type fakeSession struct {
	broker    *fakeBroker
	clientID  string
	will      Will
	onMessage func(string, []byte)
	topics    []string
	done      chan struct{}
	once      sync.Once
}

func (s *fakeSession) Subscribe(_ context.Context, topics []string) error {
	s.broker.mu.Lock()
	defer s.broker.mu.Unlock()
	s.topics = append(s.topics, topics...)
	return nil
}

// inject delivers a message to the live session subscribed to the topic.
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

func (b *fakeBroker) Connect(_ context.Context, clientID string, will Will, onMessage func(string, []byte)) (Session, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.down {
		return nil, errors.New("broker unreachable")
	}
	s := &fakeSession{broker: b, clientID: clientID, will: will, onMessage: onMessage, done: make(chan struct{})}
	b.sessions = append(b.sessions, s)
	return s, nil
}

func (b *fakeBroker) setDown(down bool) {
	b.mu.Lock()
	b.down = down
	b.mu.Unlock()
}

// killAll drops every connection, as a broker restart or network cut would.
func (b *fakeBroker) killAll() {
	b.mu.Lock()
	sessions := append([]*fakeSession(nil), b.sessions...)
	b.mu.Unlock()
	for _, s := range sessions {
		s.Close(false)
	}
}

func (b *fakeBroker) snapshot() (published, wills []publication) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]publication(nil), b.published...), append([]publication(nil), b.wills...)
}

func (s *fakeSession) Publish(_ context.Context, topic string, payload []byte, retain bool) error {
	select {
	case <-s.done:
		return errors.New("connection closed")
	default:
	}
	s.broker.mu.Lock()
	defer s.broker.mu.Unlock()
	s.broker.published = append(s.broker.published, publication{s.clientID, topic, append([]byte(nil), payload...), retain})
	return nil
}

func (s *fakeSession) Done() <-chan struct{} { return s.done }

func (s *fakeSession) Close(graceful bool) {
	s.once.Do(func() {
		close(s.done)
		if !graceful {
			s.broker.mu.Lock()
			s.broker.wills = append(s.broker.wills, publication{s.clientID, s.will.Topic, s.will.Payload, true})
			s.broker.mu.Unlock()
		}
	})
}

func fastConfig() Config {
	cfg := DefaultConfig()
	cfg.Window = 20 * time.Millisecond
	cfg.Heartbeat = 60 * time.Millisecond
	cfg.BackoffMin, cfg.BackoffMax = 5*time.Millisecond, 20*time.Millisecond
	cfg.Ramp = 0
	cfg.ReplayRate = 1000
	cfg.Duration = 400 * time.Millisecond
	cfg.DrainTimeout = 5 * time.Second
	return cfg
}

type result struct {
	summary  Summary
	records  []Record
	telem    []*gaugev1.Telemetry // decodable telemetry in publish order
	topics   []string             // topic of each entry in telem
	garbage  int                  // telemetry payloads that do not decode
	statuses []*gaugev1.Status
	wills    []publication
}

func runSim(t *testing.T, cfg Config, broker *fakeBroker, during func()) result {
	t.Helper()
	var logBuf bytes.Buffer
	seqlog := NewSeqLog(&logBuf)
	metrics := NewMetrics(prometheus.NewRegistry())
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	if during != nil {
		go during()
	}
	summary, err := Run(context.Background(), cfg, broker, seqlog, metrics, logger)
	if err != nil {
		t.Fatalf("run: %v", err)
	}

	res := result{summary: summary}
	for _, line := range strings.Split(strings.TrimSpace(logBuf.String()), "\n") {
		if line == "" {
			continue
		}
		var rec Record
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			t.Fatalf("bad seq log line %q: %v", line, err)
		}
		res.records = append(res.records, rec)
	}
	published, wills := broker.snapshot()
	res.wills = wills
	for _, p := range published {
		switch {
		case strings.HasSuffix(p.topic, "/telemetry"):
			var tel gaugev1.Telemetry
			if err := proto.Unmarshal(p.payload, &tel); err != nil {
				res.garbage++
				continue
			}
			res.telem = append(res.telem, &tel)
			res.topics = append(res.topics, p.topic)
		case strings.HasSuffix(p.topic, "/status"):
			var st gaugev1.Status
			if err := proto.Unmarshal(p.payload, &st); err != nil {
				t.Fatalf("status does not decode: %v", err)
			}
			if !p.retain {
				t.Error("status must be retained")
			}
			res.statuses = append(res.statuses, &st)
		case strings.HasSuffix(p.topic, "/cmd/resend/ack"):
			// Inspected by the resend test.
		default:
			t.Errorf("unexpected topic %s", p.topic)
		}
	}
	return res
}

// seqsByEdge returns the sorted distinct sequence numbers received per edge.
func seqsByEdge(telem []*gaugev1.Telemetry) map[string][]uint64 {
	seen := map[string]map[uint64]bool{}
	for _, tel := range telem {
		if seen[tel.GetEdgeId()] == nil {
			seen[tel.GetEdgeId()] = map[uint64]bool{}
		}
		seen[tel.GetEdgeId()][tel.GetSeq()] = true
	}
	out := map[string][]uint64{}
	for edge, set := range seen {
		for seq := range set {
			out[edge] = append(out[edge], seq)
		}
		sort.Slice(out[edge], func(i, j int) bool { return out[edge][i] < out[edge][j] })
	}
	return out
}

func assertContiguous(t *testing.T, telem []*gaugev1.Telemetry, edges int) {
	t.Helper()
	byEdge := seqsByEdge(telem)
	if len(byEdge) != edges {
		t.Fatalf("telemetry from %d edges, want %d", len(byEdge), edges)
	}
	for edge, seqs := range byEdge {
		if len(seqs) == 0 || seqs[0] != 1 || seqs[len(seqs)-1] != uint64(len(seqs)) {
			t.Errorf("%s: sequence numbers are not 1..N without gaps: %d values, first %d, last %d",
				edge, len(seqs), seqs[0], seqs[len(seqs)-1])
		}
	}
}

func TestEdgesPublishContiguousSeqAndIncreasingWindows(t *testing.T) {
	cfg := fastConfig()
	cfg.Machines, cfg.MachinesPerEdge = 8, 4
	res := runSim(t, cfg, &fakeBroker{}, nil)

	if res.summary.Unacked != 0 || res.summary.Dropped != 0 || res.summary.PublishErrors != 0 {
		t.Fatalf("unexpected losses: %+v", res.summary)
	}
	if len(res.telem) < 8*5 {
		t.Fatalf("only %d telemetry messages", len(res.telem))
	}
	assertContiguous(t, res.telem, 2)

	lastEnd := map[string]int64{}
	machinesOfEdge := map[string]map[string]bool{}
	for i, tel := range res.telem {
		if !strings.Contains(res.topics[i], "/"+tel.GetMachineId()+"/") {
			t.Errorf("machine %s published on %s", tel.GetMachineId(), res.topics[i])
		}
		if tel.GetReplayed() {
			t.Errorf("seq %d replayed without any outage", tel.GetSeq())
		}
		if prev, ok := lastEnd[tel.GetMachineId()]; ok {
			if tel.GetWindowEndMs() <= prev {
				t.Errorf("%s: window_end_ms %d not after %d", tel.GetMachineId(), tel.GetWindowEndMs(), prev)
			}
			if tel.GetWindowStartMs() != prev {
				t.Errorf("%s: windows are not contiguous", tel.GetMachineId())
			}
		}
		if tel.GetWindowEndMs()-tel.GetWindowStartMs() != cfg.Window.Milliseconds() {
			t.Errorf("window length %d ms", tel.GetWindowEndMs()-tel.GetWindowStartMs())
		}
		lastEnd[tel.GetMachineId()] = tel.GetWindowEndMs()
		if machinesOfEdge[tel.GetEdgeId()] == nil {
			machinesOfEdge[tel.GetEdgeId()] = map[string]bool{}
		}
		machinesOfEdge[tel.GetEdgeId()][tel.GetMachineId()] = true
	}
	for edge, machines := range machinesOfEdge {
		if len(machines) != 4 {
			t.Errorf("%s serves %d machines, want 4", edge, len(machines))
		}
	}
	if int64(len(res.records)) != res.summary.Acked || len(res.records) != len(res.telem) {
		t.Errorf("seq log has %d lines, %d acked, %d received", len(res.records), res.summary.Acked, len(res.telem))
	}
}

func TestStatusHeartbeatLastWillAndCleanShutdown(t *testing.T) {
	cfg := fastConfig()
	cfg.Machines, cfg.MachinesPerEdge = 4, 4
	broker := &fakeBroker{}
	res := runSim(t, cfg, broker, nil)

	if len(res.statuses) < 4 {
		t.Fatalf("only %d status messages in %v", len(res.statuses), cfg.Duration)
	}
	first, last := res.statuses[0], res.statuses[len(res.statuses)-1]
	if first.GetState() != gaugev1.State_STATE_ONLINE || last.GetState() != gaugev1.State_STATE_OFFLINE {
		t.Errorf("first state %v, last state %v", first.GetState(), last.GetState())
	}
	if first.GetEdgeId() != "edge-0001" || len(first.GetMachineIds()) != 4 || first.GetSwVersion() == "" {
		t.Errorf("status content: %v", first)
	}
	if first.GetGpuUtil() < 0 || first.GetGpuUtil() > 1 || first.TemperatureC != nil {
		t.Errorf("gpu_util must be in 0..1 and temperature unset: %v", first)
	}
	// A clean shutdown must not trigger the last will.
	if len(res.wills) != 0 {
		t.Errorf("last will delivered %d times on a clean shutdown", len(res.wills))
	}
	broker.mu.Lock()
	will := broker.sessions[0].will
	broker.mu.Unlock()
	var st gaugev1.Status
	if err := proto.Unmarshal(will.Payload, &st); err != nil {
		t.Fatal(err)
	}
	if will.Topic != "denso/SIM/L01/machine_001/status" || st.GetState() != gaugev1.State_STATE_OFFLINE || len(st.GetMachineIds()) != 4 {
		t.Errorf("last will: topic %s, %v", will.Topic, &st)
	}
}

func TestMessagesAreBufferedWhileOfflineAndReplayed(t *testing.T) {
	cfg := fastConfig()
	cfg.Machines, cfg.MachinesPerEdge = 4, 2
	cfg.Duration = 600 * time.Millisecond
	broker := &fakeBroker{down: true}
	res := runSim(t, cfg, broker, func() {
		time.Sleep(200 * time.Millisecond)
		broker.setDown(false)
	})

	if res.summary.ConnectErrors == 0 {
		t.Error("expected failed connection attempts while the broker was down")
	}
	if res.summary.Unacked != 0 || res.summary.Dropped != 0 {
		t.Fatalf("messages lost: %+v", res.summary)
	}
	assertContiguous(t, res.telem, 2)
	replayed, realtime := 0, 0
	for _, tel := range res.telem {
		if tel.GetReplayed() {
			replayed++
		} else {
			realtime++
		}
	}
	if replayed < 10 || realtime < 10 {
		t.Errorf("replayed=%d realtime=%d, expected plenty of both", replayed, realtime)
	}
	if int64(replayed) != res.summary.Replayed {
		t.Errorf("summary says %d replayed, broker saw %d", res.summary.Replayed, replayed)
	}
	for _, rec := range res.records {
		if !rec.Acked {
			t.Errorf("unacked record in log: %+v", rec)
		}
	}
}

func TestConnectionLossTriggersLastWillAndReconnect(t *testing.T) {
	cfg := fastConfig()
	cfg.Machines = 3
	cfg.Duration = 500 * time.Millisecond
	broker := &fakeBroker{}
	res := runSim(t, cfg, broker, func() {
		time.Sleep(150 * time.Millisecond)
		broker.killAll()
	})

	if res.summary.Reconnects != 3 {
		t.Errorf("reconnects: %d, want 3", res.summary.Reconnects)
	}
	if len(res.wills) != 3 {
		t.Errorf("last wills delivered: %d, want 3", len(res.wills))
	}
	if res.summary.Unacked != 0 {
		t.Fatalf("messages lost: %+v", res.summary)
	}
	assertContiguous(t, res.telem, 3)
}

func TestDisconnectFaultCutsAndRecovers(t *testing.T) {
	cfg := fastConfig()
	cfg.Machines = 4
	cfg.Faults = FaultSet{FaultDisconnect: true}
	cfg.DisconnectEvery, cfg.DisconnectFor = 80*time.Millisecond, 40*time.Millisecond
	cfg.Duration = 800 * time.Millisecond
	res := runSim(t, cfg, &fakeBroker{}, nil)

	if res.summary.Reconnects == 0 || len(res.wills) == 0 {
		t.Fatalf("no simulated cut happened: %+v", res.summary)
	}
	if res.summary.Unacked != 0 || res.summary.Dropped != 0 {
		t.Fatalf("messages lost: %+v", res.summary)
	}
	assertContiguous(t, res.telem, 4)
	if res.summary.Replayed == 0 {
		t.Error("expected replayed messages after the cuts")
	}
}

func TestPerMessageFaultsAreInjectedAndLogged(t *testing.T) {
	cfg := fastConfig()
	cfg.Machines = 5
	cfg.Faults = FaultSet{FaultOutOfRange: true, FaultBadSchema: true, FaultDuplicate: true, FaultClockSkew: true}
	cfg.FaultRate = 0.5
	cfg.Duration = 600 * time.Millisecond
	res := runSim(t, cfg, &fakeBroker{}, nil)

	logged := map[string]int{}
	for _, rec := range res.records {
		logged[rec.Fault]++
		if rec.Fault == string(FaultBadSchema) && rec.Seq != 0 {
			t.Errorf("bad_schema record carries seq %d", rec.Seq)
		}
	}
	for _, f := range []Fault{FaultOutOfRange, FaultBadSchema, FaultDuplicate, FaultClockSkew} {
		if logged[string(f)] == 0 {
			t.Errorf("fault %s never logged: %v", f, logged)
		}
	}
	if res.garbage != logged[string(FaultBadSchema)] {
		t.Errorf("%d undecodable payloads, %d bad_schema records", res.garbage, logged[string(FaultBadSchema)])
	}
	// bad_schema consumes no sequence number, so the others stay gap-free.
	assertContiguous(t, res.telem, 5)

	copies := map[string]int{}
	outOfRange, skewed := 0, 0
	now := time.Now().UnixMilli()
	for _, tel := range res.telem {
		copies[fmt.Sprintf("%s/%d", tel.GetEdgeId(), tel.GetSeq())]++
		for _, meas := range tel.GetMeasurements() {
			// The hour meter legitimately reads above 10000.
			if meas.GetGaugeId() != "TOTAL_HOUR_METER" && meas.GetValue() >= 10000 {
				outOfRange++
			}
		}
		if d := tel.GetWindowEndMs() - now; d > 300_000 || d < -300_000 {
			skewed++
		}
	}
	duplicates := len(res.telem) - len(copies)
	if duplicates != logged[string(FaultDuplicate)] {
		t.Errorf("%d duplicate deliveries, %d duplicate records", duplicates, logged[string(FaultDuplicate)])
	}
	if outOfRange != logged[string(FaultOutOfRange)] || skewed != logged[string(FaultClockSkew)] {
		t.Errorf("out_of_range %d/%d, clock_skew %d/%d (received/logged)",
			outOfRange, logged[string(FaultOutOfRange)], skewed, logged[string(FaultClockSkew)])
	}
}

func TestFullBufferDropsOldestAndReportsLoss(t *testing.T) {
	cfg := fastConfig()
	cfg.Machines = 2
	cfg.BufferMax = 5
	cfg.DrainTimeout = 100 * time.Millisecond
	res := runSim(t, cfg, &fakeBroker{down: true}, nil)

	if res.summary.Acked != 0 || res.summary.Dropped == 0 || res.summary.Unacked != 10 {
		t.Fatalf("summary: %+v", res.summary)
	}
	if int64(len(res.records)) != res.summary.Dropped+res.summary.Unacked {
		t.Errorf("%d log lines for %d dropped + %d unacked", len(res.records), res.summary.Dropped, res.summary.Unacked)
	}
	for _, rec := range res.records {
		if rec.Acked {
			t.Errorf("record marked acked while the broker was down: %+v", rec)
		}
	}
}

// The wall clock of a virtual machine can step or run fast. Windows must
// follow the monotonic clock: exactly one message per machine per elapsed
// window, however far the loop is behind.
func TestProduceEmitsExactlyOneMessagePerElapsedWindow(t *testing.T) {
	cfg := fastConfig()
	cfg.Machines, cfg.MachinesPerEdge = 3, 3
	broker := &fakeBroker{}
	seqlog := NewSeqLog(nil)
	edge := newEdge(cfg, 0, broker, seqlog, NewMetrics(prometheus.NewRegistry()), &Stats{},
		slog.New(slog.NewTextHandler(io.Discard, nil)))
	edge.reconnect = time.NewTimer(time.Hour)
	edge.connect()

	edge.start = time.Now().Add(-10*cfg.Window - cfg.Window/2)
	edge.startWall = time.UnixMilli(1_700_000_000_000)
	edge.produce()
	edge.produce() // nothing new is due

	published, _ := broker.snapshot()
	perMachine := map[string][]int64{}
	for _, p := range published {
		if !strings.HasSuffix(p.topic, "/telemetry") {
			continue
		}
		var tel gaugev1.Telemetry
		if err := proto.Unmarshal(p.payload, &tel); err != nil {
			t.Fatal(err)
		}
		perMachine[tel.GetMachineId()] = append(perMachine[tel.GetMachineId()], tel.GetWindowEndMs())
	}
	if len(perMachine) != 3 {
		t.Fatalf("messages for %d machines, want 3", len(perMachine))
	}
	for machine, ends := range perMachine {
		if len(ends) != 10 {
			t.Errorf("%s: %d messages for 10 elapsed windows", machine, len(ends))
		}
		for i, end := range ends {
			want := int64(1_700_000_000_000) + int64(i+1)*cfg.Window.Milliseconds()
			if end != want {
				t.Errorf("%s: window %d ends at %d, want %d", machine, i, end, want)
			}
		}
	}
}

func TestMessageRateIsBoundedByTheWindow(t *testing.T) {
	cfg := fastConfig()
	cfg.Machines = 4
	res := runSim(t, cfg, &fakeBroker{}, nil)

	limit := int(cfg.Duration/cfg.Window) * cfg.Machines
	if len(res.telem) > limit || len(res.telem) < limit/2 {
		t.Errorf("%d messages in %v, want at most %d (one per machine per window)", len(res.telem), cfg.Duration, limit)
	}
}

func TestOffsetGivesDisjointMachinesAndEdges(t *testing.T) {
	cfg := fastConfig()
	cfg.Machines, cfg.MachinesPerEdge, cfg.Offset = 4, 2, 6
	res := runSim(t, cfg, &fakeBroker{}, nil)

	machines, edges := map[string]bool{}, map[string]bool{}
	for _, tel := range res.telem {
		machines[tel.GetMachineId()] = true
		edges[tel.GetEdgeId()] = true
	}
	wantMachines := map[string]bool{"machine_007": true, "machine_008": true, "machine_009": true, "machine_010": true}
	wantEdges := map[string]bool{"edge-0004": true, "edge-0005": true}
	if !reflect.DeepEqual(machines, wantMachines) || !reflect.DeepEqual(edges, wantEdges) {
		t.Errorf("machines %v, edges %v", machines, edges)
	}
	cfg.Offset = 3
	if err := cfg.Validate(); err == nil {
		t.Error("an offset that splits an edge was accepted")
	}
}

func TestResendRequestIsServedFromMemoryAndAcknowledged(t *testing.T) {
	cfg := fastConfig()
	cfg.Machines = 1
	cfg.Resend, cfg.ResendKeep = true, 10
	cfg.Duration = 900 * time.Millisecond
	broker := &fakeBroker{}
	const resendTopic = "denso/SIM/edge/edge-0001/cmd/resend"
	res := runSim(t, cfg, broker, func() {
		time.Sleep(450 * time.Millisecond) // about 22 messages sent; the oldest are no longer kept
		request, _ := proto.Marshal(&gaugev1.ResendRequest{EdgeId: "edge-0001", FromSeq: 1, ToSeq: 20, RequestId: 77})
		if !broker.inject(resendTopic, request) {
			t.Error("the edge is not subscribed to its resend topic")
		}
		other, _ := proto.Marshal(&gaugev1.ResendRequest{EdgeId: "edge-0002", FromSeq: 1, ToSeq: 2})
		broker.inject(resendTopic, other)
	})

	var ack *gaugev1.ResendAck
	published, _ := broker.snapshot()
	for _, p := range published {
		if p.topic == resendTopic+"/ack" {
			if ack != nil {
				t.Fatal("more than one acknowledgement: the request for another edge was answered")
			}
			ack = &gaugev1.ResendAck{}
			if err := proto.Unmarshal(p.payload, ack); err != nil {
				t.Fatal(err)
			}
		}
	}
	if ack == nil {
		t.Fatal("no resend acknowledgement")
	}
	if ack.GetRequestId() != 77 || ack.GetResent() == 0 || len(ack.GetMissing()) != 1 || ack.GetMissing()[0].GetFromSeq() != 1 {
		t.Fatalf("ack: %v", ack)
	}
	// Everything requested is either resent or reported missing.
	missing := ack.GetMissing()[0].GetToSeq() - ack.GetMissing()[0].GetFromSeq() + 1
	if uint64(ack.GetResent())+missing != 20 {
		t.Errorf("resent %d + missing %d != 20 requested", ack.GetResent(), missing)
	}
	resent := 0
	for _, tel := range res.telem {
		if tel.GetReplayed() {
			resent++
			if tel.GetSeq() <= ack.GetMissing()[0].GetToSeq() || tel.GetSeq() > 20 {
				t.Errorf("seq %d resent outside the kept part of the range", tel.GetSeq())
			}
		}
	}
	if resent != int(ack.GetResent()) || res.summary.Resent != int64(resent) {
		t.Errorf("broker saw %d resent, ack says %d, summary %d", resent, ack.GetResent(), res.summary.Resent)
	}
}

func TestGapFaultSkipsThePublishButKeepsTheMessageForResend(t *testing.T) {
	cfg := fastConfig()
	cfg.Machines = 1
	cfg.Faults, cfg.FaultRate = FaultSet{FaultGap: true}, 0.3
	cfg.Resend, cfg.ResendKeep = true, 1000
	cfg.Duration = 900 * time.Millisecond
	broker := &fakeBroker{}
	res := runSim(t, cfg, broker, func() {
		time.Sleep(500 * time.Millisecond)
		request, _ := proto.Marshal(&gaugev1.ResendRequest{EdgeId: "edge-0001", FromSeq: 1, ToSeq: 15, RequestId: 5})
		broker.inject("denso/SIM/edge/edge-0001/cmd/resend", request)
	})

	skipped := map[uint64]bool{}
	for _, rec := range res.records {
		if rec.Fault == string(FaultGap) {
			if !rec.Acked {
				t.Errorf("seq %d: a gap is logged as acknowledged, the edge believes it was delivered", rec.Seq)
			}
			skipped[uint64(rec.Seq)] = true
		}
	}
	if len(skipped) == 0 {
		t.Fatal("no gap injected")
	}
	realtime, resent := map[uint64]bool{}, map[uint64]bool{}
	var highest uint64
	for _, tel := range res.telem {
		if tel.GetReplayed() {
			resent[tel.GetSeq()] = true
		} else {
			realtime[tel.GetSeq()] = true
		}
		highest = max(highest, tel.GetSeq())
	}
	for seq := range skipped {
		if realtime[seq] {
			t.Errorf("seq %d was published although it is a gap", seq)
		}
		if seq <= 15 && !resent[seq] {
			t.Errorf("seq %d was not resent on request", seq)
		}
	}
	// The counter kept running over the gaps.
	if int(highest) < len(realtime)+1 {
		t.Errorf("highest seq %d with %d published: the gaps did not use sequence numbers", highest, len(realtime))
	}
}

func TestLingerStopsProducingButStillAnswersResendRequests(t *testing.T) {
	cfg := fastConfig()
	cfg.Machines = 1
	cfg.Resend, cfg.ResendKeep = true, 1000
	cfg.Duration, cfg.Linger = 300*time.Millisecond, 500*time.Millisecond
	broker := &fakeBroker{}
	started := time.Now()
	res := runSim(t, cfg, broker, func() {
		time.Sleep(550 * time.Millisecond) // production has ended
		request, _ := proto.Marshal(&gaugev1.ResendRequest{EdgeId: "edge-0001", FromSeq: 1, ToSeq: 3, RequestId: 9})
		broker.inject("denso/SIM/edge/edge-0001/cmd/resend", request)
	})

	if took := time.Since(started); took < 750*time.Millisecond {
		t.Errorf("stopped after %v, before the linger time ended", took)
	}
	realtime, resent := 0, 0
	for _, tel := range res.telem {
		if tel.GetReplayed() {
			resent++
		} else {
			realtime++
		}
	}
	// 300 ms of production at the fast window, not 800 ms.
	if limit := int(450 * time.Millisecond / cfg.Window); realtime == 0 || realtime > limit {
		t.Errorf("%d realtime messages, want at most %d: production went on while lingering", realtime, limit)
	}
	if resent != 3 {
		t.Errorf("%d messages resent while lingering, want 3", resent)
	}
}
