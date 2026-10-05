// Package store is the offline buffer of edge-agent: every telemetry message
// is written to SQLite (WAL) before it is published.
//
// A message stays "unsent" until the broker acknowledged it. Acknowledged
// messages are kept for a retention period so the server can ask for them
// again (cmd/resend). The size limit wins over the retention: when the buffer
// is full, the oldest acknowledged messages go first and unsent ones last.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"time"

	_ "modernc.org/sqlite" // pure-Go SQLite driver
)

// rowOverhead approximates the bytes a row costs besides topic and payload.
const rowOverhead = 48

// Message is one stored telemetry message.
type Message struct {
	Seq     uint64
	Topic   string
	Payload []byte
	Acked   bool
}

// SeqRange is an inclusive range of sequence numbers.
type SeqRange struct{ From, To uint64 }

// Stats describes the buffer for the heartbeat and metrics.
type Stats struct {
	UnsentMessages int64
	UnsentBytes    int64
	TotalBytes     int64
}

// Store is safe for concurrent use.
type Store struct {
	db        *sql.DB
	mu        sync.Mutex
	maxBytes  int64
	retention time.Duration
	now       func() time.Time
}

const schema = `
CREATE TABLE IF NOT EXISTS message (
  seq        INTEGER PRIMARY KEY,
  topic      TEXT    NOT NULL,
  payload    BLOB    NOT NULL,
  size       INTEGER NOT NULL,
  created_ms INTEGER NOT NULL,
  acked_ms   INTEGER
);
CREATE INDEX IF NOT EXISTS message_unsent ON message (seq) WHERE acked_ms IS NULL;
CREATE INDEX IF NOT EXISTS message_acked ON message (acked_ms) WHERE acked_ms IS NOT NULL;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT OR IGNORE INTO meta (key, value) VALUES ('next_seq', 1);
`

// Open opens or creates the buffer at path. maxBytes bounds the stored
// payload bytes and retention is how long acknowledged messages are kept.
func Open(path string, maxBytes int64, retention time.Duration) (*Store, error) {
	dsn := "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(5000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// One connection: SQLite has a single writer anyway.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("init buffer %s: %w", path, err)
	}
	return &Store{db: db, maxBytes: maxBytes, retention: retention, now: time.Now}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// Append assigns the next sequence number, lets build create the payload
// that carries it, and stores the message as unsent. The sequence number is
// persistent: it keeps counting across restarts.
func (s *Store) Append(ctx context.Context, topic string, build func(seq uint64) ([]byte, error)) (Message, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Message{}, err
	}
	defer func() { _ = tx.Rollback() }()

	var seq uint64
	if err := tx.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = 'next_seq'`).Scan(&seq); err != nil {
		return Message{}, err
	}
	payload, err := build(seq)
	if err != nil {
		return Message{}, err
	}
	size := int64(len(payload) + len(topic) + rowOverhead)
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO message (seq, topic, payload, size, created_ms) VALUES (?, ?, ?, ?, ?)`,
		seq, topic, payload, size, s.now().UnixMilli()); err != nil {
		return Message{}, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE meta SET value = ? WHERE key = 'next_seq'`, seq+1); err != nil {
		return Message{}, err
	}
	if err := tx.Commit(); err != nil {
		return Message{}, err
	}
	return Message{Seq: seq, Topic: topic, Payload: payload}, nil
}

// MarkAcked records that the broker acknowledged a message.
func (s *Store) MarkAcked(ctx context.Context, seq uint64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `UPDATE message SET acked_ms = ? WHERE seq = ? AND acked_ms IS NULL`,
		s.now().UnixMilli(), seq)
	return err
}

func (s *Store) query(ctx context.Context, query string, args ...any) ([]Message, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Message
	for rows.Next() {
		var m Message
		var acked sql.NullInt64
		if err := rows.Scan(&m.Seq, &m.Topic, &m.Payload, &acked); err != nil {
			return nil, err
		}
		m.Acked = acked.Valid
		out = append(out, m)
	}
	return out, rows.Err()
}

// Unsent returns up to limit unacknowledged messages with seq > after,
// oldest first.
func (s *Store) Unsent(ctx context.Context, after uint64, limit int) ([]Message, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.query(ctx,
		`SELECT seq, topic, payload, acked_ms FROM message WHERE acked_ms IS NULL AND seq > ? ORDER BY seq LIMIT ?`,
		after, limit)
}

// Range returns the stored messages with from <= seq <= to and the
// sub-ranges that are no longer (or not yet) in the buffer.
func (s *Store) Range(ctx context.Context, from, to uint64) ([]Message, []SeqRange, error) {
	if to < from {
		return nil, nil, errors.New("to_seq is below from_seq")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	found, err := s.query(ctx,
		`SELECT seq, topic, payload, acked_ms FROM message WHERE seq BETWEEN ? AND ? ORDER BY seq`, from, to)
	if err != nil {
		return nil, nil, err
	}
	var missing []SeqRange
	next := from
	for _, m := range found {
		if m.Seq > next {
			missing = append(missing, SeqRange{next, m.Seq - 1})
		}
		next = m.Seq + 1
	}
	if next <= to {
		missing = append(missing, SeqRange{next, to})
	}
	return found, missing, nil
}

// Prune enforces the retention and the size limit. It returns how many
// acknowledged messages were removed and how many unsent ones had to be
// dropped; the latter is data loss and must be reported.
func (s *Store) Prune(ctx context.Context) (expired, dropped int64, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cutoff := s.now().Add(-s.retention).UnixMilli()
	res, err := s.db.ExecContext(ctx, `DELETE FROM message WHERE acked_ms IS NOT NULL AND acked_ms < ?`, cutoff)
	if err != nil {
		return 0, 0, err
	}
	expired, _ = res.RowsAffected()

	for {
		var total int64
		if err := s.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(size), 0) FROM message`).Scan(&total); err != nil {
			return expired, dropped, err
		}
		excess := total - s.maxBytes
		if excess <= 0 {
			return expired, dropped, nil
		}
		// Oldest acknowledged messages first; unsent ones only when nothing else is left.
		n, err := s.evict(ctx, "acked_ms IS NOT NULL", excess)
		if err != nil {
			return expired, dropped, err
		}
		if n > 0 {
			expired += n
			continue
		}
		if n, err = s.evict(ctx, "acked_ms IS NULL", excess); err != nil || n == 0 {
			return expired, dropped, err
		}
		dropped += n
	}
}

// evict deletes the oldest messages matching cond until at least excess bytes
// are freed (or a batch is exhausted) and returns how many it removed.
func (s *Store) evict(ctx context.Context, cond string, excess int64) (int64, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT seq, size FROM message WHERE `+cond+` ORDER BY seq LIMIT 1000`)
	if err != nil {
		return 0, err
	}
	var last uint64
	var freed int64
	found := false
	for rows.Next() && freed < excess {
		var size int64
		if err := rows.Scan(&last, &size); err != nil {
			_ = rows.Close()
			return 0, err
		}
		freed += size
		found = true
	}
	if err := rows.Close(); err != nil || !found {
		return 0, err
	}
	res, err := s.db.ExecContext(ctx, `DELETE FROM message WHERE `+cond+` AND seq <= ?`, last)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// Stats returns the current buffer usage.
func (s *Store) Stats(ctx context.Context) (Stats, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var st Stats
	err := s.db.QueryRowContext(ctx, `SELECT
		COUNT(*) FILTER (WHERE acked_ms IS NULL),
		COALESCE(SUM(size) FILTER (WHERE acked_ms IS NULL), 0),
		COALESCE(SUM(size), 0) FROM message`).Scan(&st.UnsentMessages, &st.UnsentBytes, &st.TotalBytes)
	return st, err
}
