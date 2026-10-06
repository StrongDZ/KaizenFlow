package sim

import (
	"bufio"
	"encoding/json"
	"io"
	"sync"
)

// Record is one line of the sequence log, the file load tests compare against
// the database. A line is written for every publish the broker acknowledged
// (acked = true) and, at shutdown, for every message that never got through
// (acked = false).
//
// Expected rows on the server: distinct (edge_id, seq) with acked = true.
// Lines with fault "bad_schema" carry seq 0 and must end up in the rejected
// topic; lines with fault "duplicate" repeat an (edge_id, seq) already logged.
type Record struct {
	TsMs        int64  `json:"ts_ms"`
	EdgeID      string `json:"edge_id"`
	MachineID   string `json:"machine_id"`
	Seq         uint64 `json:"seq"`
	WindowEndMs int64  `json:"window_end_ms"`
	Fault       string `json:"fault"`
	Replayed    bool   `json:"replayed"`
	Acked       bool   `json:"acked"`
}

// SeqLog writes Records as JSON lines; it is safe for concurrent use.
type SeqLog struct {
	mu  sync.Mutex
	w   *bufio.Writer
	enc *json.Encoder
	err error
}

// NewSeqLog wraps a writer; a nil writer discards every record.
func NewSeqLog(w io.Writer) *SeqLog {
	if w == nil {
		w = io.Discard
	}
	buffered := bufio.NewWriterSize(w, 1<<16)
	return &SeqLog{w: buffered, enc: json.NewEncoder(buffered)}
}

func (l *SeqLog) Write(r Record) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.enc.Encode(r); err != nil && l.err == nil {
		l.err = err
	}
}

// Flush writes buffered lines out and returns the first error seen so far.
func (l *SeqLog) Flush() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.w.Flush(); err != nil && l.err == nil {
		l.err = err
	}
	return l.err
}
