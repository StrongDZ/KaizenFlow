package sim

import (
	"bytes"
	"encoding/json"
	"math/rand"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

func TestBackoffGrowsExponentiallyWithJitter(t *testing.T) {
	b := NewBackoff(time.Second, 60*time.Second, rand.New(rand.NewSource(1)))
	bases := []time.Duration{1, 2, 4, 8, 16, 32, 60, 60, 60}
	for attempt, base := range bases {
		base *= time.Second
		got := b.Next()
		if got < base/2 || got >= base*3/2 {
			t.Errorf("attempt %d: %v outside [%v, %v)", attempt, got, base/2, base*3/2)
		}
	}
	// Far beyond the point where a naive shift would overflow.
	for i := 0; i < 100; i++ {
		if got := b.Next(); got < 30*time.Second || got >= 90*time.Second {
			t.Fatalf("capped delay out of range: %v", got)
		}
	}
	b.Reset()
	if got := b.Next(); got >= 1500*time.Millisecond {
		t.Errorf("after reset: %v, want below 1.5s", got)
	}
}

func TestBackoffJitterVaries(t *testing.T) {
	b := NewBackoff(time.Second, 60*time.Second, rand.New(rand.NewSource(2)))
	seen := map[time.Duration]bool{}
	for i := 0; i < 20; i++ {
		b.Reset()
		seen[b.Next()] = true
	}
	if len(seen) < 15 {
		t.Errorf("only %d distinct delays in 20 draws", len(seen))
	}
}

func TestBufferIsFIFOAndDropsOldestWhenFull(t *testing.T) {
	b := NewBuffer(3)
	for seq := uint64(1); seq <= 3; seq++ {
		if dropped := b.Push(&item{seq: seq, size: 10}); dropped != nil {
			t.Fatalf("unexpected drop of %d", dropped.seq)
		}
	}
	if dropped := b.Push(&item{seq: 4, size: 10}); dropped == nil || dropped.seq != 1 {
		t.Fatalf("expected seq 1 to be dropped, got %v", dropped)
	}
	if b.Len() != 3 || b.Bytes() != 30 {
		t.Fatalf("len=%d bytes=%d, want 3 and 30", b.Len(), b.Bytes())
	}
	first := b.Pop()
	b.PushFront(first)
	for _, want := range []uint64{2, 3, 4} {
		if got := b.Pop(); got.seq != want {
			t.Fatalf("pop: got %d, want %d", got.seq, want)
		}
	}
	if b.Pop() != nil || b.Len() != 0 || b.Bytes() != 0 {
		t.Fatal("buffer should be empty")
	}
}

func TestParseFaults(t *testing.T) {
	set, err := ParseFaults(" duplicate, disconnect ,bad_schema")
	if err != nil {
		t.Fatal(err)
	}
	if !set.Has(FaultDuplicate) || !set.Has(FaultDisconnect) || !set.Has(FaultBadSchema) || set.Has(FaultClockSkew) {
		t.Errorf("unexpected set: %v", set)
	}
	if got := set.perMessage(); len(got) != 2 {
		t.Errorf("perMessage: %v, disconnect must not be a per-message fault", got)
	}
	if empty, err := ParseFaults(""); err != nil || len(empty) != 0 {
		t.Errorf("empty list: %v, %v", empty, err)
	}
	if _, err := ParseFaults("duplicate,nope"); err == nil || !strings.Contains(err.Error(), "nope") {
		t.Errorf("unknown fault not rejected: %v", err)
	}
}

func TestPickFaultFollowsRate(t *testing.T) {
	rng := rand.New(rand.NewSource(3))
	candidates := []Fault{FaultDuplicate, FaultClockSkew}
	counts := map[Fault]int{}
	for i := 0; i < 10000; i++ {
		counts[pickFault(candidates, 0.05, rng)]++
	}
	faulty := counts[FaultDuplicate] + counts[FaultClockSkew]
	if faulty < 400 || faulty > 600 {
		t.Errorf("%d faulty messages out of 10000 at 5%%", faulty)
	}
	if counts[FaultDuplicate] == 0 || counts[FaultClockSkew] == 0 {
		t.Errorf("faults not spread: %v", counts)
	}
	if pickFault(nil, 1, rng) != FaultNone {
		t.Error("no candidates must mean no fault")
	}
}

func TestBadSchemaPayloadNeverDecodes(t *testing.T) {
	if err := proto.Unmarshal(badSchemaPayload, &gaugev1.Telemetry{}); err == nil {
		t.Fatal("bad_schema payload decoded as Telemetry")
	}
}

func testMachine() (*machine, *rand.Rand) {
	rng := rand.New(rand.NewSource(4))
	return newMachine(DefaultConfig(), 11, rng), rng
}

func TestBuildTelemetryFollowsSchema(t *testing.T) {
	m, rng := testMachine()
	start := time.UnixMilli(1_700_000_000_000)
	tel := m.build("edge-0003", 42, start, start.Add(200*time.Millisecond), rng)

	if tel.GetEdgeId() != "edge-0003" || tel.GetSeq() != 42 || tel.GetMachineId() != "machine_012" {
		t.Errorf("header: %v", tel)
	}
	if tel.GetWindowStartMs() != 1_700_000_000_000 || tel.GetWindowEndMs() != 1_700_000_000_200 {
		t.Errorf("window: %d..%d", tel.GetWindowStartMs(), tel.GetWindowEndMs())
	}
	if tel.GetReplayed() || tel.GetSchemaVersion() != 1 || len(tel.GetMeasurements()) != 4 {
		t.Errorf("unexpected message: %v", tel)
	}
	if m.topic != "denso/SIM/L02/machine_012/telemetry" {
		t.Errorf("topic: %s", m.topic)
	}
	for _, meas := range tel.GetMeasurements() {
		if meas.GetGaugeId() == "" || meas.GetUnit() == "" {
			t.Errorf("incomplete measurement: %v", meas)
		}
		if meas.Value != nil && (meas.GetQuality() < 0.85 || meas.GetQuality() > 1 || meas.GetVMin() > meas.GetValue() || meas.GetVMax() < meas.GetValue()) {
			t.Errorf("inconsistent measurement: %v", meas)
		}
		if meas.Value == nil && len(meas.GetFlags()) == 0 {
			t.Errorf("unreadable measurement without flag: %v", meas)
		}
	}
}

func TestHourMeterNeverDecreases(t *testing.T) {
	m, rng := testMachine()
	start := time.UnixMilli(1_700_000_000_000)
	last := -1.0
	for i := 0; i < 5000; i++ {
		end := start.Add(time.Second)
		for _, meas := range m.build("e", uint64(i), start, end, rng).GetMeasurements() {
			if meas.GetGaugeId() == "TOTAL_HOUR_METER" && meas.Value != nil {
				if meas.GetValue() < last {
					t.Fatalf("hour meter went from %v to %v", last, meas.GetValue())
				}
				last = meas.GetValue()
			}
		}
		start = end
	}
}

func TestClockSkewIsLargeAndNeverAlignedWithWindows(t *testing.T) {
	rng := rand.New(rand.NewSource(5))
	window := 200 * time.Millisecond
	past, future := 0, 0
	for i := 0; i < 2000; i++ {
		tel := &gaugev1.Telemetry{WindowStartMs: 1_000_000, WindowEndMs: 1_000_200}
		applyClockSkew(tel, window, rng)
		skew := tel.GetWindowEndMs() - 1_000_200
		if tel.GetWindowEndMs()-tel.GetWindowStartMs() != 200 {
			t.Fatal("window length changed")
		}
		if skew > -360_000 && skew < 360_000 {
			t.Fatalf("skew %d ms is below 6 minutes", skew)
		}
		if skew%200 == 0 {
			t.Fatalf("skew %d ms is a multiple of the window", skew)
		}
		if skew < 0 {
			past++
		} else {
			future++
		}
	}
	if past == 0 || future == 0 {
		t.Errorf("skew direction not varied: past=%d future=%d", past, future)
	}
}

func TestOutOfRangeChangesOneValue(t *testing.T) {
	m, rng := testMachine()
	start := time.UnixMilli(1_700_000_000_000)
	tel := m.build("e", 1, start, start.Add(time.Second), rng)
	applyOutOfRange(tel)
	big := 0
	for _, meas := range tel.GetMeasurements() {
		if meas.GetGaugeId() != "TOTAL_HOUR_METER" && meas.GetValue() >= 10000 {
			big++
		}
	}
	if big != 1 {
		t.Errorf("%d measurements out of range, want 1", big)
	}
}

func TestItemPayloadSetsReplayed(t *testing.T) {
	it := &item{tel: &gaugev1.Telemetry{Seq: 7}}
	for _, replayed := range []bool{false, true} {
		raw, err := it.payload(replayed)
		if err != nil {
			t.Fatal(err)
		}
		var out gaugev1.Telemetry
		if err := proto.Unmarshal(raw, &out); err != nil {
			t.Fatal(err)
		}
		if out.GetReplayed() != replayed || out.GetSeq() != 7 {
			t.Errorf("replayed=%v: got %v", replayed, &out)
		}
	}
}

func TestSeqLogWritesJSONLines(t *testing.T) {
	var buf bytes.Buffer
	log := NewSeqLog(&buf)
	log.Write(Record{TsMs: 1, EdgeID: "edge-0001", MachineID: "machine_001", Seq: 5, WindowEndMs: 99, Acked: true})
	log.Write(Record{EdgeID: "edge-0001", Seq: 5, Fault: "duplicate", Replayed: true})
	if err := log.Flush(); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("got %d lines", len(lines))
	}
	var first map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &first); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"ts_ms", "edge_id", "machine_id", "seq", "window_end_ms", "fault", "replayed", "acked"} {
		if _, ok := first[key]; !ok {
			t.Errorf("missing key %q in %s", key, lines[0])
		}
	}
	var second Record
	if err := json.Unmarshal([]byte(lines[1]), &second); err != nil {
		t.Fatal(err)
	}
	if second.Fault != "duplicate" || !second.Replayed || second.Acked {
		t.Errorf("second record: %+v", second)
	}
	NewSeqLog(nil).Write(Record{}) // a nil writer must be usable
}

func TestConfigValidateAndNaming(t *testing.T) {
	cfg := DefaultConfig()
	if err := cfg.Validate(); err != nil {
		t.Fatalf("defaults invalid: %v", err)
	}
	cfg.Machines, cfg.MachinesPerEdge = 1000, 4
	if cfg.Edges() != 250 {
		t.Errorf("edges: %d", cfg.Edges())
	}
	cfg.Machines = 1001
	if cfg.Edges() != 251 {
		t.Errorf("edges with remainder: %d", cfg.Edges())
	}
	if EdgeID(0) != "edge-0001" || MachineID(999) != "machine_1000" {
		t.Errorf("ids: %s %s", EdgeID(0), MachineID(999))
	}
	if got := cfg.TopicPrefix(25); got != "denso/SIM/L03/machine_026" {
		t.Errorf("topic prefix: %s", got)
	}

	invalid := map[string]func(*Config){
		"machines":          func(c *Config) { c.Machines = 0 },
		"machines-per-edge": func(c *Config) { c.MachinesPerEdge = 0 },
		"window":            func(c *Config) { c.Window = time.Millisecond },
		"fault-rate":        func(c *Config) { c.FaultRate = 1.5 },
		"buffer-max":        func(c *Config) { c.BufferMax = 0 },
		"disconnect":        func(c *Config) { c.Faults = FaultSet{FaultDisconnect: true}; c.DisconnectFor = 0 },
	}
	for name, breakIt := range invalid {
		c := DefaultConfig()
		breakIt(&c)
		if err := c.Validate(); err == nil {
			t.Errorf("%s: invalid config accepted", name)
		}
	}
}
