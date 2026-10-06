//go:build integration

package main

// Integration tests against Redis and TimescaleDB (migrated). Run with
// `make test-integration` after `make up && make migrate`.

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/redis/go-redis/v9"
	"github.com/twmb/franz-go/pkg/kgo"
	"google.golang.org/protobuf/proto"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

var ctx = context.Background()

func testTracker(t *testing.T) (*SeqTracker, string) {
	t.Helper()
	addr := os.Getenv("STATE_TEST_REDIS")
	if addr == "" {
		t.Skip("STATE_TEST_REDIS is not set")
	}
	client := redis.NewClient(&redis.Options{Addr: addr})
	edge := fmt.Sprintf("itest-edge-%d", time.Now().UnixNano())
	t.Cleanup(func() {
		client.Del(ctx, seqKey(edge), gapKey(edge), lostKey(edge), edgeStateKey(edge), lastSeenKey(edge), askedKey(edge))
		client.SRem(ctx, edgesSetKey, edge)
		_ = client.Close()
	})
	return &SeqTracker{client: client, grace: 10 * time.Minute}, edge
}

func observe(t *testing.T, tr *SeqTracker, edge string, seq uint64, replayed bool, at time.Time) Observation {
	t.Helper()
	obs, err := tr.Observe(ctx, edge, seq, replayed, at)
	if err != nil {
		t.Fatal(err)
	}
	return obs
}

func lostCount(t *testing.T, tr *SeqTracker, edge string, at time.Time) int64 {
	t.Helper()
	lost, err := tr.Sweep(ctx, at)
	if err != nil {
		t.Fatal(err)
	}
	return lost[edge]
}

func TestIntegrationOutOfOrderArrivalIsNotAGap(t *testing.T) {
	tr, edge := testTracker(t)
	t0 := time.Now()
	for _, seq := range []uint64{1, 2, 3} {
		observe(t, tr, edge, seq, false, t0)
	}
	// 4..6 were buffered at the edge; 7 arrives first, then the replay.
	if obs := observe(t, tr, edge, 7, false, t0); obs.Candidates != 3 {
		t.Fatalf("candidates: %+v", obs)
	}
	for _, seq := range []uint64{4, 5, 6} {
		if obs := observe(t, tr, edge, seq, true, t0.Add(time.Second)); obs.Late != 0 || obs.Candidates != 0 {
			t.Errorf("replay of %d: %+v", seq, obs)
		}
	}
	_ = tr.SetEdgeState(ctx, edge, true, 0, t0)
	if n := lostCount(t, tr, edge, t0.Add(time.Hour)); n != 0 {
		t.Errorf("%d counted as lost although every number arrived", n)
	}
	if left := tr.client.ZCard(ctx, gapKey(edge)).Val(); left != 0 {
		t.Errorf("%d candidates left", left)
	}
}

func TestIntegrationGapCountsOnlyAfterGraceWithEdgeOnlineAndBufferEmpty(t *testing.T) {
	tr, edge := testTracker(t)
	t0 := time.Now()
	observe(t, tr, edge, 1, false, t0)
	observe(t, tr, edge, 5, false, t0) // 2, 3, 4 missing

	// The edge still reports a non-empty buffer: the missing ones may be in it.
	_ = tr.SetEdgeState(ctx, edge, true, 3, t0)
	if n := lostCount(t, tr, edge, t0.Add(time.Hour)); n != 0 {
		t.Fatalf("counted %d while the edge buffer was not empty", n)
	}
	// Offline: nothing can be concluded either.
	_ = tr.SetEdgeState(ctx, edge, false, 0, t0.Add(time.Hour))
	if n := lostCount(t, tr, edge, t0.Add(2*time.Hour)); n != 0 {
		t.Fatalf("counted %d while the edge was offline", n)
	}
	// Online with an empty buffer from t1: the 10 minutes start now.
	t1 := t0.Add(2 * time.Hour)
	_ = tr.SetEdgeState(ctx, edge, true, 0, t1)
	_ = tr.SetEdgeState(ctx, edge, true, 0, t1.Add(30*time.Second)) // a later heartbeat must not restart the clock
	if n := lostCount(t, tr, edge, t1.Add(9*time.Minute)); n != 0 {
		t.Fatalf("counted %d before the grace period ended", n)
	}
	if n := lostCount(t, tr, edge, t1.Add(11*time.Minute)); n != 3 {
		t.Fatalf("counted %d after the grace period, want 3", n)
	}
	if n := lostCount(t, tr, edge, t1.Add(12*time.Minute)); n != 0 {
		t.Errorf("counted %d twice", n)
	}

	// One of them shows up after all: late, and no longer lost.
	if obs := observe(t, tr, edge, 3, true, t1.Add(13*time.Minute)); obs.Late != 1 {
		t.Errorf("late arrival: %+v", obs)
	}
	if obs := observe(t, tr, edge, 3, true, t1.Add(14*time.Minute)); obs.Late != 0 {
		t.Errorf("counted late twice: %+v", obs)
	}
}

func TestIntegrationCounterRestartIsNotAGapButAReplayOfSeqOneIsNotARestart(t *testing.T) {
	tr, edge := testTracker(t)
	t0 := time.Now()
	observe(t, tr, edge, 50, false, t0) // the first message seen: nothing known before it
	if obs := observe(t, tr, edge, 1, true, t0); obs.Reset {
		t.Fatal("a replayed seq 1 must not look like a restart")
	}
	if obs := observe(t, tr, edge, 1, false, t0); !obs.Reset {
		t.Fatal("a realtime seq 1 after seq 50 is a restarted counter")
	}
	if obs := observe(t, tr, edge, 2, false, t0); obs.Candidates != 0 {
		t.Errorf("after the restart: %+v", obs)
	}
}

func TestIntegrationHugeGapIsCappedAndTheExcessCountedAtOnce(t *testing.T) {
	tr, edge := testTracker(t)
	t0 := time.Now()
	observe(t, tr, edge, 1, false, t0)

	obs := observe(t, tr, edge, 25002, false, t0) // 25000 missing

	if obs.Candidates != gapCap || obs.Overflow != 25000-gapCap {
		t.Errorf("observation: %+v", obs)
	}
	if size := tr.client.ZCard(ctx, gapKey(edge)).Val(); size != gapCap {
		t.Errorf("tracked %d, want %d", size, gapCap)
	}
	if ttl := tr.client.TTL(ctx, gapKey(edge)).Val(); ttl <= 0 || ttl > gapTTL {
		t.Errorf("ttl: %v", ttl)
	}
}

func TestIntegrationStatusUpdatesEdgeNodeAndUsesTheReceiveTimeForOffline(t *testing.T) {
	url := os.Getenv("STATE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("STATE_TEST_DATABASE_URL is not set")
	}
	tr, edge := testTracker(t)
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM edge_node WHERE edge_id = $1`, edge) })
	metrics := NewMetrics(prometheus.NewRegistry())
	svc := &Service{edges: &pgEdges{pool}, tracker: tr, metrics: metrics, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}

	connected := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	record := func(state gaugev1.State, received time.Time, buffer uint64) *kgo.Record {
		payload, _ := proto.Marshal(&gaugev1.Status{EdgeId: edge, MachineIds: []string{"M1", "M2"}, TsMs: connected.UnixMilli(),
			State: state, SwVersion: "edge-agent-0.1", ConfigVersion: 7, BufferBytes: 4096, BufferMsgs: buffer})
		return &kgo.Record{Value: payload, Timestamp: received}
	}
	heartbeat := time.Now().Add(-time.Minute).Truncate(time.Millisecond)
	if err := svc.HandleStatus(ctx, record(gaugev1.State_STATE_ONLINE, heartbeat, 0)); err != nil {
		t.Fatal(err)
	}

	var status, version string
	var machines []string
	var lastSeen, updated time.Time
	var configVersion int
	read := func() {
		if err := pool.QueryRow(ctx, `SELECT status, sw_version, machine_ids, last_seen, updated_at, config_version FROM edge_node WHERE edge_id = $1`,
			edge).Scan(&status, &version, &machines, &lastSeen, &updated, &configVersion); err != nil {
			t.Fatal(err)
		}
	}
	read()
	if status != "online" || version != "edge-agent-0.1" || len(machines) != 2 || !lastSeen.Equal(heartbeat) || configVersion != 7 {
		t.Errorf("online row: %s %s %v %v %d", status, version, machines, lastSeen, configVersion)
	}
	if online, _ := svc.edges.CountOnline(ctx, 120*time.Second); online < 1 {
		t.Error("edge not counted as online")
	}
	if ttl := tr.client.TTL(ctx, lastSeenKey(edge)).Val(); ttl <= 0 || ttl > 120*time.Second {
		t.Errorf("last_seen ttl: %v", ttl)
	}
	if testutil.ToFloat64(metrics.BufferBytes.WithLabelValues(edge)) != 4096 {
		t.Error("buffer metric not set")
	}

	// The last will: its ts_ms is the connect time, an hour ago. The offline
	// moment is when the server received it.
	offlineAt := time.Now().Truncate(time.Millisecond)
	if err := svc.HandleStatus(ctx, record(gaugev1.State_STATE_OFFLINE, offlineAt, 0)); err != nil {
		t.Fatal(err)
	}
	read()
	if status != "offline" || !updated.Equal(offlineAt) || !lastSeen.Equal(heartbeat) {
		t.Errorf("offline row: %s updated=%v last_seen=%v", status, updated, lastSeen)
	}
	if state := tr.client.HGet(ctx, edgeStateKey(edge), "state").Val(); state != "offline" {
		t.Errorf("redis state: %s", state)
	}
	if tr.client.HExists(ctx, edgeStateKey(edge), "eligible_since").Val() {
		t.Error("an offline edge must not be eligible for gap counting")
	}

	// A redelivered older heartbeat must not bring the edge back online.
	if err := svc.HandleStatus(ctx, record(gaugev1.State_STATE_ONLINE, heartbeat, 0)); err != nil {
		t.Fatal(err)
	}
	read()
	if status != "offline" {
		t.Errorf("an older status overwrote a newer one: %s", status)
	}
}

type fakePublisher struct {
	mu       sync.Mutex
	fail     bool
	requests map[string][]*gaugev1.ResendRequest
}

func (f *fakePublisher) Publish(_ context.Context, topic string, payload []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail {
		return fmt.Errorf("broker away")
	}
	var req gaugev1.ResendRequest
	if err := proto.Unmarshal(payload, &req); err != nil {
		return err
	}
	if f.requests == nil {
		f.requests = map[string][]*gaugev1.ResendRequest{}
	}
	f.requests[topic] = append(f.requests[topic], &req)
	return nil
}

func testResender(t *testing.T) (*Resender, *fakePublisher, *Metrics, string) {
	tr, edge := testTracker(t)
	pub := &fakePublisher{}
	metrics := NewMetrics(prometheus.NewRegistry())
	r := &Resender{tracker: tr, pub: pub, prefix: "denso", after: time.Minute, metrics: NewResendMetrics(prometheus.NewRegistry()),
		gaps: metrics.SeqGap, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	return r, pub, metrics, edge
}

func TestIntegrationResendAsksOnceForDueGapsOfAnOnlineEdgeWithEmptyBuffer(t *testing.T) {
	r, pub, _, edge := testResender(t)
	tr := r.tracker
	topic := "denso/P1/edge/" + edge + "/cmd/resend"
	t0 := time.Now()
	observe(t, tr, edge, 1, false, t0)
	observe(t, tr, edge, 5, false, t0) // 2, 3, 4 missing
	observe(t, tr, edge, 7, false, t0) // 6 missing
	_ = tr.SetPlant(ctx, edge, "P1")

	// Still draining its buffer: the missing ones may come by themselves.
	_ = tr.SetEdgeState(ctx, edge, true, 2, t0)
	r.Run(ctx, t0.Add(2*time.Minute))
	// Empty buffer but the gaps are too fresh.
	_ = tr.SetEdgeState(ctx, edge, true, 0, t0)
	r.Run(ctx, t0.Add(30*time.Second))
	if len(pub.requests[topic]) != 0 {
		t.Fatalf("asked too early: %v", pub.requests[topic])
	}

	r.Run(ctx, t0.Add(2*time.Minute))
	got := pub.requests[topic]
	if len(got) != 2 || got[0].FromSeq != 2 || got[0].ToSeq != 4 || got[1].FromSeq != 6 || got[1].ToSeq != 6 {
		t.Fatalf("requests: %v", got)
	}
	if got[0].EdgeId != edge || got[0].RequestId == 0 || got[0].RequestId == got[1].RequestId {
		t.Errorf("request fields: %v", got)
	}
	r.Run(ctx, t0.Add(3*time.Minute))
	if len(pub.requests[topic]) != 2 {
		t.Errorf("asked twice: %v", pub.requests[topic])
	}

	// The resent messages fill the gaps; nothing is lost afterwards.
	for _, seq := range []uint64{2, 3, 4, 6} {
		observe(t, tr, edge, seq, true, t0.Add(4*time.Minute))
	}
	if n := lostCount(t, tr, edge, t0.Add(time.Hour)); n != 0 {
		t.Errorf("%d counted as lost after the resend", n)
	}
	if left := tr.client.ZCard(ctx, askedKey(edge)).Val(); left != 0 {
		t.Errorf("%d asked markers left", left)
	}
}

func TestIntegrationResendThatCouldNotBeSentIsTriedAgain(t *testing.T) {
	r, pub, _, edge := testResender(t)
	tr := r.tracker
	t0 := time.Now()
	observe(t, tr, edge, 1, false, t0)
	observe(t, tr, edge, 4, false, t0)
	_ = tr.SetPlant(ctx, edge, "P1")
	_ = tr.SetEdgeState(ctx, edge, true, 0, t0)

	pub.fail = true
	r.Run(ctx, t0.Add(2*time.Minute))
	pub.fail = false
	r.Run(ctx, t0.Add(3*time.Minute))

	got := pub.requests["denso/P1/edge/"+edge+"/cmd/resend"]
	if len(got) != 1 || got[0].FromSeq != 2 || got[0].ToSeq != 3 {
		t.Errorf("requests: %v", got)
	}
}

func TestIntegrationResendAckCountsWhatTheEdgeNoLongerHoldsAsLostAtOnce(t *testing.T) {
	r, _, metrics, edge := testResender(t)
	tr := r.tracker
	t0 := time.Now()
	observe(t, tr, edge, 1, false, t0)
	observe(t, tr, edge, 6, false, t0) // 2..5 missing
	_ = tr.SetPlant(ctx, edge, "P1")
	_ = tr.SetEdgeState(ctx, edge, true, 0, t0)
	r.Run(ctx, t0.Add(2*time.Minute))

	ack, _ := proto.Marshal(&gaugev1.ResendAck{EdgeId: edge, RequestId: 1, Resent: 2,
		Missing: []*gaugev1.SeqRange{{FromSeq: 2, ToSeq: 3}}})
	r.HandleAck(ctx, ack)
	r.HandleAck(ctx, ack) // a redelivered ack must not count twice
	r.HandleAck(ctx, []byte{0xff})

	if lost := testutil.ToFloat64(metrics.SeqGap.WithLabelValues(edge)); lost != 2 {
		t.Errorf("lost: %v, want 2", lost)
	}
	if left := tr.client.ZCard(ctx, gapKey(edge)).Val(); left != 2 {
		t.Errorf("%d candidates left, want 4 and 5", left)
	}
	if testutil.ToFloat64(r.metrics.Acks.WithLabelValues("partial")) != 2 || testutil.ToFloat64(r.metrics.Acks.WithLabelValues("invalid")) != 1 ||
		testutil.ToFloat64(r.metrics.Resent) != 4 {
		t.Error("ack metrics wrong")
	}
	// One of the given-up ones arrives after all: late, not lost.
	if obs := observe(t, tr, edge, 2, true, t0.Add(3*time.Minute)); obs.Late != 1 {
		t.Errorf("late arrival: %+v", obs)
	}
}
