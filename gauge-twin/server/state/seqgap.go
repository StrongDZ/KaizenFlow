package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

// Sequence tracking per edge (SPEC section 3.5).
//
// Telemetry of one edge arrives out of order: replayed messages come after
// realtime ones, and an edge serving several machines is spread over several
// Kafka partitions. A missing sequence number is therefore only a candidate:
// it is kept in seqgap:{edge} with the time it was noticed, and counted as
// lost only when it is still missing after the grace period while the edge
// has been online with an empty buffer for that long.
const (
	gapCap       = 10000              // tracked sequence numbers per edge
	gapTTL       = 7 * 24 * time.Hour // of the tracking keys
	edgesSetKey  = "seqgap:edges"     // edges that currently have candidates
	stateOnline  = "online"
	stateOffline = "offline"
)

func seqKey(edge string) string       { return "seq:" + edge }
func gapKey(edge string) string       { return "seqgap:" + edge }
func lostKey(edge string) string      { return "seqlost:" + edge }
func edgeStateKey(edge string) string { return "edge:" + edge + ":state" }
func lastSeenKey(edge string) string  { return "edge:" + edge + ":last_seen" }
func askedKey(edge string) string     { return "seqasked:" + edge }

// observeScript records one received sequence number.
// KEYS: seq, seqgap, seqlost, edges set, seqasked. ARGV: seq, now ms, replayed (0/1), cap, ttl s, edge id.
// Returns {new candidates, late arrivals, reset (0/1), overflow counted as lost}.
var observeScript = redis.NewScript(`
local seq = tonumber(ARGV[1])
local cap = tonumber(ARGV[4])
local max = tonumber(redis.call('GET', KEYS[1]))
if not max then
  redis.call('SET', KEYS[1], seq, 'EX', ARGV[5])
  return {0, 0, 0, 0}
end
if seq == 1 and ARGV[3] == '0' and max > 1 then
  -- A realtime message with seq 1 after higher ones: the edge lost its counter.
  redis.call('SET', KEYS[1], 1, 'EX', ARGV[5])
  redis.call('DEL', KEYS[2], KEYS[3], KEYS[5])
  return {0, 0, 1, 0}
end
if seq > max then
  local from = max + 1
  local overflow = 0
  if seq - from > cap then
    overflow = seq - from - cap
    from = seq - cap
  end
  local added = 0
  for missing = from, seq - 1 do
    redis.call('ZADD', KEYS[2], ARGV[2], missing)
    added = added + 1
  end
  redis.call('SET', KEYS[1], seq, 'EX', ARGV[5])
  if added > 0 then
    local extra = redis.call('ZCARD', KEYS[2]) - cap
    if extra > 0 then
      redis.call('ZREMRANGEBYRANK', KEYS[2], 0, extra - 1)
      overflow = overflow + extra
    end
    redis.call('EXPIRE', KEYS[2], ARGV[5])
    redis.call('SADD', KEYS[4], ARGV[6])
  end
  return {added, 0, 0, overflow}
end
-- An older sequence number: it fills a candidate, or arrives after it was counted as lost.
redis.call('ZREM', KEYS[2], seq)
redis.call('ZREM', KEYS[5], seq)
local late = redis.call('ZREM', KEYS[3], seq)
return {0, late, 0, 0}`)

// sweepScript counts overdue candidates of one edge as lost.
// KEYS: seqgap, seqlost, edge state, edges set. ARGV: now ms, grace ms, cap, ttl s, edge id.
// Returns the number of sequence numbers newly counted as lost.
var sweepScript = redis.NewScript(`
if redis.call('ZCARD', KEYS[1]) == 0 then
  redis.call('SREM', KEYS[4], ARGV[5])
  return 0
end
local st = redis.call('HMGET', KEYS[3], 'state', 'buffer_msgs', 'eligible_since')
if st[1] ~= 'online' or st[2] ~= '0' or not st[3] then
  return 0
end
local cutoff = tonumber(ARGV[1]) - tonumber(ARGV[2])
if tonumber(st[3]) > cutoff then
  return 0
end
local lost = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', cutoff)
for _, seq in ipairs(lost) do
  redis.call('ZREM', KEYS[1], seq)
  redis.call('ZADD', KEYS[2], ARGV[1], seq)
end
if #lost > 0 then
  local extra = redis.call('ZCARD', KEYS[2]) - tonumber(ARGV[3])
  if extra > 0 then
    redis.call('ZREMRANGEBYRANK', KEYS[2], 0, extra - 1)
  end
  redis.call('EXPIRE', KEYS[2], ARGV[4])
end
return #lost`)

// Observation is the outcome of recording one sequence number.
type Observation struct {
	Candidates int64 // sequence numbers newly noticed as missing
	Late       int64 // 1 when this one had already been counted as lost
	Reset      bool  // the edge restarted its counter
	Overflow   int64 // missing numbers beyond the tracking cap, counted as lost at once
}

// SeqTracker keeps the per-edge sequence state in Redis, so several state
// replicas share it.
type SeqTracker struct {
	client *redis.Client
	grace  time.Duration
}

func (t *SeqTracker) Observe(ctx context.Context, edge string, seq uint64, replayed bool, now time.Time) (Observation, error) {
	flag := "0"
	if replayed {
		flag = "1"
	}
	res, err := observeScript.Run(ctx, t.client, []string{seqKey(edge), gapKey(edge), lostKey(edge), edgesSetKey, askedKey(edge)},
		seq, now.UnixMilli(), flag, gapCap, int(gapTTL.Seconds()), edge).Int64Slice()
	if err != nil {
		return Observation{}, err
	}
	return Observation{Candidates: res[0], Late: res[1], Reset: res[2] == 1, Overflow: res[3]}, nil
}

// Sweep counts overdue candidates as lost and returns the count per edge.
func (t *SeqTracker) Sweep(ctx context.Context, now time.Time) (map[string]int64, error) {
	edges, err := t.client.SMembers(ctx, edgesSetKey).Result()
	if err != nil {
		return nil, err
	}
	lost := map[string]int64{}
	for _, edge := range edges {
		n, err := sweepScript.Run(ctx, t.client, []string{gapKey(edge), lostKey(edge), edgeStateKey(edge), edgesSetKey},
			now.UnixMilli(), t.grace.Milliseconds(), gapCap, int(gapTTL.Seconds()), edge).Int64()
		if err != nil {
			return lost, err
		}
		if n > 0 {
			lost[edge] = n
		}
	}
	return lost, nil
}

// SetEdgeState records what the latest heartbeat said. eligible_since marks
// the start of the current period in which the edge is online with an empty
// buffer; the grace period for missing sequence numbers only runs then.
func (t *SeqTracker) SetEdgeState(ctx context.Context, edge string, online bool, bufferMsgs uint64, at time.Time) error {
	key := edgeStateKey(edge)
	pipe := t.client.TxPipeline()
	state := stateOffline
	if online {
		state = stateOnline
		// 120 s: four missed heartbeats mean the edge is gone.
		pipe.Set(ctx, lastSeenKey(edge), at.UnixMilli(), 120*time.Second)
	}
	pipe.HSet(ctx, key, "state", state, "buffer_msgs", bufferMsgs)
	if online && bufferMsgs == 0 {
		pipe.HSetNX(ctx, key, "eligible_since", at.UnixMilli())
	} else {
		pipe.HDel(ctx, key, "eligible_since")
	}
	pipe.Expire(ctx, key, gapTTL)
	_, err := pipe.Exec(ctx)
	return err
}

// SetPlant remembers the plant segment of the edge's MQTT topics; resend
// requests are published under it.
func (t *SeqTracker) SetPlant(ctx context.Context, edge, plant string) error {
	return t.client.HSet(ctx, edgeStateKey(edge), "plant", plant).Err()
}
