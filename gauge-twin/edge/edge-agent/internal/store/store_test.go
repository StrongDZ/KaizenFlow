package store

import (
	"context"
	"encoding/binary"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

var ctx = context.Background()

func open(t *testing.T, maxBytes int64, retention time.Duration) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "buffer.db")
	s, err := Open(path, maxBytes, retention)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s, path
}

// appendN stores n messages whose payload is their own sequence number
// padded to size bytes.
func appendN(t *testing.T, s *Store, n, size int) []Message {
	t.Helper()
	var out []Message
	for i := 0; i < n; i++ {
		m, err := s.Append(ctx, "denso/P/L/M/telemetry", func(seq uint64) ([]byte, error) {
			payload := make([]byte, size)
			binary.BigEndian.PutUint64(payload, seq)
			return payload, nil
		})
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, m)
	}
	return out
}

func seqs(messages []Message) []uint64 {
	out := make([]uint64, len(messages))
	for i, m := range messages {
		out[i] = m.Seq
	}
	return out
}

func TestAppendAssignsContiguousSeqAndPayloadCarriesIt(t *testing.T) {
	s, _ := open(t, 1<<20, time.Hour)
	messages := appendN(t, s, 5, 16)

	if !reflect.DeepEqual(seqs(messages), []uint64{1, 2, 3, 4, 5}) {
		t.Fatalf("seqs: %v", seqs(messages))
	}
	unsent, err := s.Unsent(ctx, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range unsent {
		if binary.BigEndian.Uint64(m.Payload) != m.Seq || m.Acked {
			t.Errorf("message %d: payload seq %d acked=%v", m.Seq, binary.BigEndian.Uint64(m.Payload), m.Acked)
		}
	}
}

func TestSeqContinuesAfterRestartAndAfterEviction(t *testing.T) {
	path := filepath.Join(t.TempDir(), "buffer.db")
	s, err := Open(path, 1<<20, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range appendN(t, s, 3, 16) {
		if err := s.MarkAcked(ctx, m.Seq); err != nil {
			t.Fatal(err)
		}
	}
	// Zero retention: everything acknowledged is removed.
	time.Sleep(2 * time.Millisecond)
	if _, _, err := s.Prune(ctx); err != nil {
		t.Fatal(err)
	}
	_ = s.Close()

	reopened, err := Open(path, 1<<20, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	// The counter must not fall back to 1, or the server would see duplicates.
	if next := appendN(t, reopened, 1, 16)[0].Seq; next != 4 {
		t.Errorf("next seq after restart: %d, want 4", next)
	}
}

func TestUnsentSkipsAcknowledgedAndPagesInOrder(t *testing.T) {
	s, _ := open(t, 1<<20, time.Hour)
	appendN(t, s, 6, 16)
	for _, seq := range []uint64{2, 5} {
		if err := s.MarkAcked(ctx, seq); err != nil {
			t.Fatal(err)
		}
	}

	first, _ := s.Unsent(ctx, 0, 3)
	rest, _ := s.Unsent(ctx, first[len(first)-1].Seq, 10)

	if !reflect.DeepEqual(seqs(first), []uint64{1, 3, 4}) || !reflect.DeepEqual(seqs(rest), []uint64{6}) {
		t.Errorf("first=%v rest=%v", seqs(first), seqs(rest))
	}
	stats, _ := s.Stats(ctx)
	if stats.UnsentMessages != 4 || stats.UnsentBytes <= 0 || stats.TotalBytes <= stats.UnsentBytes {
		t.Errorf("stats: %+v", stats)
	}
}

func TestRangeReturnsMessagesAndMissingRanges(t *testing.T) {
	s, _ := open(t, 1<<20, 0)
	appendN(t, s, 10, 16)
	for _, seq := range []uint64{1, 2, 6} {
		_ = s.MarkAcked(ctx, seq)
	}
	time.Sleep(2 * time.Millisecond)
	if _, _, err := s.Prune(ctx); err != nil { // removes 1, 2 and 6
		t.Fatal(err)
	}

	found, missing, err := s.Range(ctx, 1, 12)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(seqs(found), []uint64{3, 4, 5, 7, 8, 9, 10}) {
		t.Errorf("found: %v", seqs(found))
	}
	if !reflect.DeepEqual(missing, []SeqRange{{1, 2}, {6, 6}, {11, 12}}) {
		t.Errorf("missing: %v", missing)
	}
	if _, _, err := s.Range(ctx, 5, 4); err == nil {
		t.Error("inverted range accepted")
	}
}

func TestRetentionKeepsAcknowledgedMessagesForResend(t *testing.T) {
	s, _ := open(t, 1<<20, 24*time.Hour)
	now := time.UnixMilli(1_700_000_000_000)
	s.now = func() time.Time { return now }
	appendN(t, s, 3, 16)
	_ = s.MarkAcked(ctx, 1)
	_ = s.MarkAcked(ctx, 2)

	now = now.Add(23 * time.Hour)
	if expired, dropped, _ := s.Prune(ctx); expired != 0 || dropped != 0 {
		t.Fatalf("pruned too early: expired=%d dropped=%d", expired, dropped)
	}
	now = now.Add(2 * time.Hour)
	expired, dropped, err := s.Prune(ctx)
	if err != nil || expired != 2 || dropped != 0 {
		t.Fatalf("after 25 h: expired=%d dropped=%d err=%v", expired, dropped, err)
	}
	// The unsent message is never removed by age.
	if unsent, _ := s.Unsent(ctx, 0, 10); !reflect.DeepEqual(seqs(unsent), []uint64{3}) {
		t.Errorf("unsent: %v", seqs(unsent))
	}
}

func TestSizeLimitEvictsAcknowledgedFirstThenOldestUnsent(t *testing.T) {
	// Each message costs 1000 + topic + overhead bytes; the limit fits about five.
	s, _ := open(t, 5500, 24*time.Hour)
	appendN(t, s, 10, 1000)
	for _, seq := range []uint64{1, 2, 3, 8} {
		_ = s.MarkAcked(ctx, seq)
	}

	expired, dropped, err := s.Prune(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// The limit beats the 24 h retention: all 4 acknowledged go, and since 6
	// unsent messages still exceed it, the oldest unsent one goes as well.
	if expired != 4 || dropped != 1 {
		t.Fatalf("expired=%d dropped=%d", expired, dropped)
	}
	unsent, _ := s.Unsent(ctx, 0, 20)
	if !reflect.DeepEqual(seqs(unsent), []uint64{5, 6, 7, 9, 10}) {
		t.Errorf("kept: %v", seqs(unsent))
	}
	if stats, _ := s.Stats(ctx); stats.TotalBytes > 5500 {
		t.Errorf("still over the limit: %+v", stats)
	}
}

func TestMarkAckedIsIdempotent(t *testing.T) {
	s, _ := open(t, 1<<20, time.Hour)
	appendN(t, s, 1, 16)
	for i := 0; i < 2; i++ {
		if err := s.MarkAcked(ctx, 1); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.MarkAcked(ctx, 99); err != nil {
		t.Errorf("acking an unknown seq must not fail: %v", err)
	}
	found, _, _ := s.Range(ctx, 1, 1)
	if len(found) != 1 || !found[0].Acked {
		t.Errorf("found: %+v", found)
	}
}
