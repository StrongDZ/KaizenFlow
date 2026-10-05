package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"net"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/eclipse/paho.golang/paho"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"
	"google.golang.org/protobuf/proto"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
	"gauge-twin/server/pkg/topics"
)

// Resend (SPEC section 3.5): a sequence number still missing after
// RESEND_AFTER while the edge is online with an empty buffer is asked for
// once. What the edge answers it no longer holds is counted as lost at once;
// what never arrives is counted by the regular sweep after the grace period.
const (
	maxResendRange = 10000 // sequence numbers per request (resend.proto)
	requestIDKey   = "resend:request_id"
)

// claimScript picks the candidates of one edge that are due and not asked for
// yet, and marks them as asked.
// KEYS: seqgap, seqasked, edge state. ARGV: now ms, min age ms, cap, ttl s.
// Returns {plant, seq...}, or nothing when the edge cannot be asked now.
var claimScript = redis.NewScript(`
local st = redis.call('HMGET', KEYS[3], 'state', 'buffer_msgs', 'plant')
if st[1] ~= 'online' or st[2] ~= '0' or not st[3] then
  return {}
end
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - tonumber(ARGV[2]))
local out = {st[3]}
for _, seq in ipairs(due) do
  if not redis.call('ZSCORE', KEYS[2], seq) then
    redis.call('ZADD', KEYS[2], ARGV[1], seq)
    out[#out + 1] = seq
  end
end
if #out > 1 then
  local extra = redis.call('ZCARD', KEYS[2]) - tonumber(ARGV[3])
  if extra > 0 then
    redis.call('ZREMRANGEBYRANK', KEYS[2], 0, extra - 1)
  end
  redis.call('EXPIRE', KEYS[2], ARGV[4])
end
return out`)

// giveUpScript counts the candidates in [from, to] as lost: the edge said it
// no longer holds them.
// KEYS: seqgap, seqlost. ARGV: now ms, from, to, cap, ttl s.
var giveUpScript = redis.NewScript(`
local moved = 0
for seq = tonumber(ARGV[2]), tonumber(ARGV[3]) do
  if redis.call('ZREM', KEYS[1], seq) == 1 then
    redis.call('ZADD', KEYS[2], ARGV[1], seq)
    moved = moved + 1
  end
end
if moved > 0 then
  local extra = redis.call('ZCARD', KEYS[2]) - tonumber(ARGV[4])
  if extra > 0 then
    redis.call('ZREMRANGEBYRANK', KEYS[2], 0, extra - 1)
  end
  redis.call('EXPIRE', KEYS[2], ARGV[5])
end
return moved`)

// Claim returns the plant and the sequence numbers to ask the edge for, in
// ascending order. They will not be returned again.
func (t *SeqTracker) Claim(ctx context.Context, edge string, minAge time.Duration, now time.Time) (string, []uint64, error) {
	res, err := claimScript.Run(ctx, t.client, []string{gapKey(edge), askedKey(edge), edgeStateKey(edge)},
		now.UnixMilli(), minAge.Milliseconds(), gapCap, int(gapTTL.Seconds())).StringSlice()
	if err != nil || len(res) < 2 {
		return "", nil, err
	}
	seqs := make([]uint64, 0, len(res)-1)
	for _, raw := range res[1:] {
		seq, err := strconv.ParseUint(raw, 10, 64)
		if err != nil {
			return "", nil, fmt.Errorf("candidate %q: %w", raw, err)
		}
		seqs = append(seqs, seq)
	}
	sort.Slice(seqs, func(i, j int) bool { return seqs[i] < seqs[j] })
	return res[0], seqs, nil
}

// Unclaim lets a range be asked for again, after its request could not be sent.
func (t *SeqTracker) Unclaim(ctx context.Context, edge string, r *gaugev1.SeqRange) error {
	members := make([]any, 0, r.GetToSeq()-r.GetFromSeq()+1)
	for seq := r.GetFromSeq(); seq <= r.GetToSeq(); seq++ {
		members = append(members, seq)
	}
	return t.client.ZRem(ctx, askedKey(edge), members...).Err()
}

// GiveUp counts the candidates within the range as lost and returns how many.
func (t *SeqTracker) GiveUp(ctx context.Context, edge string, r *gaugev1.SeqRange, now time.Time) (int64, error) {
	return giveUpScript.Run(ctx, t.client, []string{gapKey(edge), lostKey(edge)},
		now.UnixMilli(), r.GetFromSeq(), r.GetToSeq(), gapCap, int(gapTTL.Seconds())).Int64()
}

// seqRanges groups ascending sequence numbers into inclusive ranges of
// consecutive numbers, none longer than a request may be.
func seqRanges(seqs []uint64) []*gaugev1.SeqRange {
	var out []*gaugev1.SeqRange
	for _, seq := range seqs {
		if n := len(out); n > 0 && out[n-1].ToSeq+1 == seq && seq-out[n-1].FromSeq < maxResendRange {
			out[n-1].ToSeq = seq
			continue
		}
		out = append(out, &gaugev1.SeqRange{FromSeq: seq, ToSeq: seq})
	}
	return out
}

// RequestPublisher sends a resend request to the broker.
type RequestPublisher interface {
	Publish(ctx context.Context, topic string, payload []byte) error
}

// ResendMetrics of the resend path.
type ResendMetrics struct {
	Requests  prometheus.Counter
	Requested prometheus.Counter
	Acks      *prometheus.CounterVec
	Resent    prometheus.Counter
	Connected prometheus.Gauge
}

func NewResendMetrics(reg prometheus.Registerer) *ResendMetrics {
	m := &ResendMetrics{
		Requests: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "state_resend_requests_total", Help: "Resend requests published to edges."}),
		Requested: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "state_resend_requested_messages_total", Help: "Sequence numbers asked for in resend requests."}),
		Acks: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "state_resend_acks_total", Help: "Resend acknowledgements received, by result."}, []string{"result"}),
		Resent: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "state_resend_resent_messages_total", Help: "Messages the edges reported as published again."}),
		Connected: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "state_mqtt_connected", Help: "1 while the MQTT connection used for resend requests is up."}),
	}
	reg.MustRegister(m.Requests, m.Requested, m.Acks, m.Resent, m.Connected)
	return m
}

// Resender asks edges for missing telemetry and processes their answers.
type Resender struct {
	tracker *SeqTracker
	pub     RequestPublisher
	prefix  string
	after   time.Duration
	metrics *ResendMetrics
	gaps    *prometheus.CounterVec // edge_seq_gap_total
	logger  *slog.Logger
}

// Run asks every edge with due candidates once.
func (r *Resender) Run(ctx context.Context, now time.Time) {
	edges, err := r.tracker.client.SMembers(ctx, edgesSetKey).Result()
	if err != nil {
		r.logger.Warn("resend: listing edges failed", "error", err)
		return
	}
	for _, edge := range edges {
		plant, seqs, err := r.tracker.Claim(ctx, edge, r.after, now)
		if err != nil {
			r.logger.Warn("resend: claim failed", "edge_id", edge, "error", err)
			continue
		}
		for _, rng := range seqRanges(seqs) {
			if err := r.request(ctx, plant, edge, rng); err != nil {
				r.logger.Warn("resend: request not sent", "edge_id", edge, "error", err)
				if err := r.tracker.Unclaim(ctx, edge, rng); err != nil {
					r.logger.Warn("resend: unclaim failed", "edge_id", edge, "error", err)
				}
			}
		}
	}
}

func (r *Resender) request(ctx context.Context, plant, edge string, rng *gaugev1.SeqRange) error {
	id, err := r.tracker.client.Incr(ctx, requestIDKey).Result()
	if err != nil {
		return err
	}
	payload, err := proto.Marshal(&gaugev1.ResendRequest{EdgeId: edge, FromSeq: rng.FromSeq, ToSeq: rng.ToSeq, RequestId: uint64(id)})
	if err != nil {
		return err
	}
	if err := r.pub.Publish(ctx, topics.ResendTopic(r.prefix, plant, edge), payload); err != nil {
		return err
	}
	r.metrics.Requests.Inc()
	r.metrics.Requested.Add(float64(rng.ToSeq - rng.FromSeq + 1))
	r.logger.Info("resend requested", "edge_id", edge, "from_seq", rng.FromSeq, "to_seq", rng.ToSeq, "request_id", id)
	return nil
}

// HandleAck processes one ResendAck payload.
func (r *Resender) HandleAck(ctx context.Context, payload []byte) {
	var ack gaugev1.ResendAck
	if err := proto.Unmarshal(payload, &ack); err != nil || ack.GetEdgeId() == "" {
		r.metrics.Acks.WithLabelValues("invalid").Inc()
		return
	}
	if ack.GetError() != "" {
		r.metrics.Acks.WithLabelValues("rejected").Inc()
		r.logger.Warn("resend rejected by the edge", "edge_id", ack.GetEdgeId(), "request_id", ack.GetRequestId(), "error", ack.GetError())
		return
	}
	r.metrics.Resent.Add(float64(ack.GetResent()))
	result := "complete"
	for _, rng := range ack.GetMissing() {
		if rng.GetToSeq() < rng.GetFromSeq() || rng.GetToSeq()-rng.GetFromSeq() >= maxResendRange {
			continue
		}
		result = "partial"
		lost, err := r.tracker.GiveUp(ctx, ack.GetEdgeId(), rng, time.Now())
		if err != nil {
			// The sweep counts them after the grace period instead.
			r.logger.Warn("resend: recording unavailable messages failed", "edge_id", ack.GetEdgeId(), "error", err)
			continue
		}
		if lost > 0 {
			r.gaps.WithLabelValues(ack.GetEdgeId()).Add(float64(lost))
			r.logger.Warn("telemetry lost: the edge no longer holds it", "edge_id", ack.GetEdgeId(), "messages", lost)
		}
	}
	r.metrics.Acks.WithLabelValues(result).Inc()
}

// MQTTLink is the MQTT connection of state: it publishes resend requests and
// receives the acknowledgements. Requests are best effort; one that is not
// answered is covered by the gap sweep.
type MQTTLink struct {
	Broker, ClientID, Prefix, ShareGroup string
	OnAck                                func(payload []byte)
	Metrics                              *ResendMetrics
	Logger                               *slog.Logger

	mu     sync.Mutex
	client *paho.Client
}

// Publish sends one QoS 1 message and waits for the broker to confirm it.
func (l *MQTTLink) Publish(ctx context.Context, topic string, payload []byte) error {
	l.mu.Lock()
	client := l.client
	l.mu.Unlock()
	if client == nil {
		return errors.New("mqtt not connected")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err := client.Publish(ctx, &paho.Publish{Topic: topic, QoS: 1, Payload: payload})
	return err
}

// Run keeps the connection up until ctx is cancelled.
func (l *MQTTLink) Run(ctx context.Context) {
	delay := time.Second
	for ctx.Err() == nil {
		started := time.Now()
		err := l.session(ctx)
		if ctx.Err() != nil {
			return
		}
		if time.Since(started) > 30*time.Second {
			delay = time.Second
		}
		wait := time.Duration(float64(delay) * (0.5 + rand.Float64()))
		l.Logger.Warn("mqtt session ended", "error", err, "retry_in", wait.String())
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		delay = min(delay*2, 30*time.Second)
	}
}

func (l *MQTTLink) session(ctx context.Context) error {
	connectCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var dialer net.Dialer
	conn, err := dialer.DialContext(connectCtx, "tcp", l.Broker)
	if err != nil {
		return fmt.Errorf("dial %s: %w", l.Broker, err)
	}
	defer conn.Close()

	clientErr := make(chan error, 1)
	report := func(err error) {
		select {
		case clientErr <- err:
		default:
		}
	}
	client := paho.NewClient(paho.ClientConfig{
		ClientID: l.ClientID,
		Conn:     conn,
		OnPublishReceived: []func(paho.PublishReceived) (bool, error){
			func(pr paho.PublishReceived) (bool, error) {
				l.OnAck(pr.Packet.Payload)
				return true, nil
			},
		},
		OnClientError: report,
		OnServerDisconnect: func(d *paho.Disconnect) {
			report(fmt.Errorf("server disconnected: reason code 0x%02x", d.ReasonCode))
		},
	})
	ack, err := client.Connect(connectCtx, &paho.Connect{ClientID: l.ClientID, KeepAlive: 30, CleanStart: true})
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	if ack.ReasonCode != 0 {
		return fmt.Errorf("connect refused: reason code 0x%02x", ack.ReasonCode)
	}
	if _, err := client.Subscribe(connectCtx, &paho.Subscribe{Subscriptions: []paho.SubscribeOptions{
		{Topic: topics.SharedResendAckFilter(l.ShareGroup, l.Prefix), QoS: 1},
	}}); err != nil {
		return fmt.Errorf("subscribe: %w", err)
	}

	l.mu.Lock()
	l.client = client
	l.mu.Unlock()
	l.Metrics.Connected.Set(1)
	l.Logger.Info("mqtt connected for resend requests", "broker", l.Broker)
	defer func() {
		l.mu.Lock()
		l.client = nil
		l.mu.Unlock()
		l.Metrics.Connected.Set(0)
	}()

	select {
	case <-client.Done():
		return errors.New("connection closed")
	case err := <-clientErr:
		return err
	case <-ctx.Done():
		_ = client.Disconnect(&paho.Disconnect{ReasonCode: 0})
		return nil
	}
}
