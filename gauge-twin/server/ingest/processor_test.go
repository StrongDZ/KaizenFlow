package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/twmb/franz-go/pkg/kgo"
	"google.golang.org/protobuf/proto"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
	"gauge-twin/server/pkg/validate"
)

// ---------------------------------------------------------------- fakes ----

type rowKey struct {
	machine, gauge string
	ts             int64
}

// fakeReadings behaves like the real table: a primary key on
// (machine, gauge, ts) and a unique key on the Kafka position of rejects.
type fakeReadings struct {
	mu       sync.Mutex
	rows     map[rowKey]validate.Row
	rejected map[int64]Rejected
	failures []error // returned, in order, before writes start succeeding
	poison   string  // rows of this machine always fail with a data error
	writes   int
}

func newFakeReadings() *fakeReadings {
	return &fakeReadings{rows: map[rowKey]validate.Row{}, rejected: map[int64]Rejected{}}
}

func (f *fakeReadings) Write(_ context.Context, rows []validate.Row, rejected []Rejected) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.writes++
	if len(f.failures) > 0 {
		err := f.failures[0]
		f.failures = f.failures[1:]
		return 0, err
	}
	for _, r := range rows {
		if f.poison != "" && r.MachineID == f.poison {
			return 0, DataError{errors.New("invalid byte sequence")}
		}
	}
	var inserted int64
	for _, r := range rows {
		key := rowKey{r.MachineID, r.GaugeID, r.TsMs}
		if _, exists := f.rows[key]; !exists {
			f.rows[key] = r
			inserted++
		}
	}
	for _, r := range rejected {
		f.rejected[r.Record.Offset] = r
	}
	return inserted, nil
}

type fakeState struct {
	mu         sync.Mutex
	latest     map[GaugeKey]validate.Previous
	hourMeters map[string]float64
	failures   int
}

func newFakeState() *fakeState {
	return &fakeState{latest: map[GaugeKey]validate.Previous{}, hourMeters: map[string]float64{}}
}

func (s *fakeState) Load(_ context.Context, gauges []GaugeKey, machines []string) (map[GaugeKey]validate.Previous, map[string]float64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failures > 0 {
		s.failures--
		return nil, nil, errors.New("redis unavailable")
	}
	latest, hours := map[GaugeKey]validate.Previous{}, map[string]float64{}
	for _, g := range gauges {
		if prev, ok := s.latest[g]; ok {
			latest[g] = prev
		}
	}
	for _, m := range machines {
		if v, ok := s.hourMeters[m]; ok {
			hours[m] = v
		}
	}
	return latest, hours, nil
}

func (s *fakeState) Apply(_ context.Context, rows []validate.Row) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range rows {
		if !r.UpdateLatest {
			continue
		}
		key := GaugeKey{r.MachineID, r.GaugeID}
		if prev, ok := s.latest[key]; !ok || prev.TsMs < r.TsMs {
			s.latest[key] = validate.Previous{Value: *r.Value, TsMs: r.TsMs, OK: true}
		}
		if r.Monotonic && *r.Value > s.hourMeters[r.MachineID] {
			s.hourMeters[r.MachineID] = *r.Value
		}
	}
	return nil
}

type fakeConfigs map[string]validate.MachineConfig

func (c fakeConfigs) Machine(id string) validate.MachineConfig { return c[id] }

type forwarded struct {
	topic, reason string
	offset        int64
}

type fakeForwarder struct {
	mu   sync.Mutex
	sent []forwarded
}

func (f *fakeForwarder) Forward(_ context.Context, topic string, source *kgo.Record, reason, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, forwarded{topic, reason, source.Offset})
	return nil
}

// -------------------------------------------------------------- harness ----

var testNow = time.UnixMilli(1_700_000_000_000)

func fp(v float64) *float64 { return &v }

type harness struct {
	processor *Processor
	readings  *fakeReadings
	state     *fakeState
	forwarder *fakeForwarder
	metrics   *Metrics
	offset    int64
}

func newHarness() *harness {
	configs := fakeConfigs{"M1": {
		"MAIN_PRESSURE":    {Type: "analog_dial", Min: fp(0), Max: fp(130), MaxRatePerS: fp(30)},
		"TOTAL_HOUR_METER": {Type: "rolling_counter", Monotonic: true},
	}, "M2": {"MAIN_PRESSURE": {Type: "analog_dial", Min: fp(0), Max: fp(130)}}}
	h := &harness{readings: newFakeReadings(), state: newFakeState(), forwarder: &fakeForwarder{},
		metrics: NewMetrics(prometheus.NewRegistry())}
	h.processor = NewProcessor(configs, h.readings, h.state, h.forwarder, h.metrics, slog.New(slog.NewTextHandler(io.Discard, nil)))
	h.processor.now = func() time.Time { return testNow }
	h.processor.backoffMin, h.processor.backoffMax = time.Millisecond, 4*time.Millisecond
	return h
}

func (h *harness) record(value []byte) *kgo.Record {
	h.offset++
	return &kgo.Record{Topic: "gauge.telemetry", Partition: 3, Offset: h.offset, Value: value, Timestamp: testNow}
}

// message builds a telemetry record ending `ago` before the test clock.
func (h *harness) message(machine string, seq uint64, ago time.Duration, replayed bool, values map[string]float64) *kgo.Record {
	end := testNow.Add(-ago).UnixMilli()
	tel := &gaugev1.Telemetry{EdgeId: "edge-1", Seq: seq, MachineId: machine, WindowStartMs: end - 1000, WindowEndMs: end, Replayed: replayed}
	for _, gauge := range []string{"MAIN_PRESSURE", "TOTAL_HOUR_METER"} {
		if v, ok := values[gauge]; ok {
			v := v
			tel.Measurements = append(tel.Measurements, &gaugev1.Measurement{GaugeId: gauge, Value: &v, Quality: 0.9})
		}
	}
	payload, _ := proto.Marshal(tel)
	return h.record(payload)
}

func (h *harness) row(machine, gauge string, ago time.Duration) (validate.Row, bool) {
	row, ok := h.readings.rows[rowKey{machine, gauge, testNow.Add(-ago).UnixMilli()}]
	return row, ok
}

func int16s(flags ...gaugev1.Flag) []int16 {
	out := make([]int16, len(flags))
	for i, f := range flags {
		out[i] = int16(f)
	}
	return out
}

// ----------------------------------------------------------------- tests ----

func TestValidBatchIsStoredAndBecomesLatest(t *testing.T) {
	h := newHarness()
	batch := []*kgo.Record{
		h.message("M1", 1, 2*time.Second, false, map[string]float64{"MAIN_PRESSURE": 60, "TOTAL_HOUR_METER": 100.1}),
		h.message("M1", 2, 1*time.Second, false, map[string]float64{"MAIN_PRESSURE": 70, "TOTAL_HOUR_METER": 100.1}),
	}
	if err := h.processor.Process(context.Background(), batch); err != nil {
		t.Fatal(err)
	}

	if len(h.readings.rows) != 4 {
		t.Fatalf("%d rows, want 4", len(h.readings.rows))
	}
	row, _ := h.row("M1", "MAIN_PRESSURE", time.Second)
	if *row.Value != 70 || row.EdgeID != "edge-1" || row.Seq != 2 || len(row.Flags) != 0 || row.Quality != 0.9 {
		t.Errorf("row: %+v", row)
	}
	if latest := h.state.latest[GaugeKey{"M1", "MAIN_PRESSURE"}]; latest.Value != 70 || latest.TsMs != testNow.Add(-time.Second).UnixMilli() {
		t.Errorf("latest: %+v", latest)
	}
	if h.state.hourMeters["M1"] != 100.1 {
		t.Errorf("hour meter: %v", h.state.hourMeters["M1"])
	}
	if testutil.ToFloat64(h.metrics.Messages.WithLabelValues("ok")) != 2 || testutil.ToFloat64(h.metrics.Rows.WithLabelValues("inserted")) != 4 {
		t.Error("metrics not updated")
	}
}

func TestDuplicatesAndReprocessedBatchesCreateNoExtraRows(t *testing.T) {
	h := newHarness()
	first := h.message("M1", 1, time.Second, false, map[string]float64{"MAIN_PRESSURE": 60})
	duplicate := &kgo.Record{Topic: first.Topic, Partition: first.Partition, Offset: 99, Value: first.Value, Timestamp: testNow}
	batch := []*kgo.Record{first, duplicate}

	for i := 0; i < 2; i++ { // the second pass is a batch replayed after a crash before the commit
		if err := h.processor.Process(context.Background(), batch); err != nil {
			t.Fatal(err)
		}
	}
	if len(h.readings.rows) != 1 {
		t.Errorf("%d rows, want 1", len(h.readings.rows))
	}
	if got := testutil.ToFloat64(h.metrics.Rows.WithLabelValues("duplicate")); got != 3 {
		t.Errorf("duplicate rows counted: %v, want 3", got)
	}
}

func TestUndecodableAndIncompleteRecordsAreRejectedNotLost(t *testing.T) {
	h := newHarness()
	incomplete, _ := proto.Marshal(&gaugev1.Telemetry{EdgeId: "edge-1", Seq: 4})
	batch := []*kgo.Record{
		h.record([]byte{0x0A, 0xFF, 0x01, 0xDE, 0xAD}),
		h.message("M1", 1, time.Second, false, map[string]float64{"MAIN_PRESSURE": 60}),
		h.record(incomplete),
	}
	if err := h.processor.Process(context.Background(), batch); err != nil {
		t.Fatal(err)
	}

	if len(h.readings.rows) != 1 || len(h.readings.rejected) != 2 {
		t.Fatalf("rows=%d rejected=%d", len(h.readings.rows), len(h.readings.rejected))
	}
	if r := h.readings.rejected[1]; r.Reason != "bad_schema" || r.Detail == "" {
		t.Errorf("rejected: %+v", r)
	}
	if r := h.readings.rejected[3]; r.Reason != "incomplete" || r.EdgeID != "edge-1" || r.Seq != 4 {
		t.Errorf("rejected: %+v", r)
	}
	want := []forwarded{{"gauge.rejected", "bad_schema", 1}, {"gauge.rejected", "incomplete", 3}}
	if !reflect.DeepEqual(h.forwarder.sent, want) {
		t.Errorf("forwarded: %+v", h.forwarder.sent)
	}
}

func TestConstraintViolationsAreStoredFlagged(t *testing.T) {
	h := newHarness()
	batch := []*kgo.Record{
		h.message("M1", 1, 3*time.Second, false, map[string]float64{"MAIN_PRESSURE": 60, "TOTAL_HOUR_METER": 500}),
		// 60 -> 125 in one second breaks the 30 bar/s limit; the hour meter goes backwards.
		h.message("M1", 2, 2*time.Second, false, map[string]float64{"MAIN_PRESSURE": 125, "TOTAL_HOUR_METER": 499.9}),
		h.message("M1", 3, 1*time.Second, false, map[string]float64{"MAIN_PRESSURE": 140}),
		h.message("UNKNOWN", 4, 1*time.Second, false, map[string]float64{"MAIN_PRESSURE": 60}),
	}
	if err := h.processor.Process(context.Background(), batch); err != nil {
		t.Fatal(err)
	}

	fast, _ := h.row("M1", "MAIN_PRESSURE", 2*time.Second)
	if !reflect.DeepEqual(fast.Flags, int16s(gaugev1.Flag_FLAG_RATE_LIMIT)) || fast.Quality != validate.QualityCap || *fast.Value != 125 {
		t.Errorf("rate limit within the batch: %+v", fast)
	}
	back, _ := h.row("M1", "TOTAL_HOUR_METER", 2*time.Second)
	if !reflect.DeepEqual(back.Flags, int16s(gaugev1.Flag_FLAG_NON_MONOTONIC)) {
		t.Errorf("hour meter: %+v", back)
	}
	high, _ := h.row("M1", "MAIN_PRESSURE", time.Second)
	if !reflect.DeepEqual(high.Flags, int16s(gaugev1.Flag_FLAG_OUT_OF_RANGE)) {
		t.Errorf("out of range: %+v", high)
	}
	unknown, _ := h.row("UNKNOWN", "MAIN_PRESSURE", time.Second)
	if !reflect.DeepEqual(unknown.Flags, int16s(gaugev1.Flag_FLAG_NO_CONFIG)) || unknown.Quality != 0.9 {
		t.Errorf("no config: %+v", unknown)
	}
	if h.state.hourMeters["M1"] != 500 {
		t.Errorf("hour meter lowered to %v", h.state.hourMeters["M1"])
	}
	if testutil.ToFloat64(h.metrics.NoConfig) != 1 || testutil.ToFloat64(h.metrics.Flags.WithLabelValues("FLAG_RATE_LIMIT")) != 1 {
		t.Error("metrics not updated")
	}
}

func TestReplayedAndSkewedDataDoNotOverwriteLatest(t *testing.T) {
	h := newHarness()
	ctx := context.Background()
	if err := h.processor.Process(ctx, []*kgo.Record{h.message("M1", 10, time.Second, false, map[string]float64{"MAIN_PRESSURE": 60})}); err != nil {
		t.Fatal(err)
	}
	batch := []*kgo.Record{
		// An hour-old replay, far from the latest value: stored, unflagged, latest untouched.
		h.message("M1", 3, time.Hour, true, map[string]float64{"MAIN_PRESSURE": 5}),
		// A message stamped 10 minutes in the future: flagged, and it must not block later updates.
		h.message("M1", 11, -10*time.Minute, false, map[string]float64{"MAIN_PRESSURE": 61}),
	}
	if err := h.processor.Process(ctx, batch); err != nil {
		t.Fatal(err)
	}

	replay, _ := h.row("M1", "MAIN_PRESSURE", time.Hour)
	if len(replay.Flags) != 0 || *replay.Value != 5 {
		t.Errorf("replayed row: %+v", replay)
	}
	skewed, _ := h.row("M1", "MAIN_PRESSURE", -10*time.Minute)
	if !reflect.DeepEqual(skewed.Flags, int16s(gaugev1.Flag_FLAG_CLOCK_SKEW)) {
		t.Errorf("skewed row: %+v", skewed)
	}
	if latest := h.state.latest[GaugeKey{"M1", "MAIN_PRESSURE"}]; latest.Value != 60 {
		t.Errorf("latest overwritten: %+v", latest)
	}
}

func TestInfrastructureErrorsAreRetriedUntilTheySucceed(t *testing.T) {
	h := newHarness()
	h.readings.failures = []error{errors.New("connection refused"), errors.New("timeout"), errors.New("connection refused")}
	h.state.failures = 2
	sawDegraded := make(chan bool, 1)
	go func() {
		for i := 0; i < 2000; i++ {
			if h.processor.Degraded() {
				sawDegraded <- true
				return
			}
			time.Sleep(50 * time.Microsecond)
		}
		sawDegraded <- false
	}()

	err := h.processor.Process(context.Background(), []*kgo.Record{h.message("M1", 1, time.Second, false, map[string]float64{"MAIN_PRESSURE": 60})})

	if err != nil || len(h.readings.rows) != 1 {
		t.Fatalf("err=%v rows=%d", err, len(h.readings.rows))
	}
	if len(h.forwarder.sent) != 0 {
		t.Errorf("infrastructure errors must never dead-letter: %+v", h.forwarder.sent)
	}
	if !<-sawDegraded || h.processor.Degraded() {
		t.Error("degraded must be reported while retrying and cleared afterwards")
	}
	if testutil.ToFloat64(h.metrics.InfraErrors) != 5 {
		t.Errorf("infra errors: %v", testutil.ToFloat64(h.metrics.InfraErrors))
	}
}

func TestCancellationStopsRetryingWithoutCommitting(t *testing.T) {
	h := newHarness()
	for i := 0; i < 1000; i++ {
		h.readings.failures = append(h.readings.failures, errors.New("database down"))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()

	err := h.processor.Process(ctx, []*kgo.Record{h.message("M1", 1, time.Second, false, map[string]float64{"MAIN_PRESSURE": 60})})

	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("got %v; the caller must not commit this batch", err)
	}
	if len(h.readings.rows) != 0 || len(h.forwarder.sent) != 0 {
		t.Error("nothing may be stored or dead-lettered")
	}
}

func TestPoisonRecordIsIsolatedAndOnlyItGoesToTheDeadLetterTopic(t *testing.T) {
	h := newHarness()
	h.readings.poison = "BAD"
	var batch []*kgo.Record
	for i := 0; i < 9; i++ {
		machine := "M1"
		if i == 5 {
			machine = "BAD"
		}
		batch = append(batch, h.message(machine, uint64(i+1), time.Duration(20-i)*time.Second, false, map[string]float64{"MAIN_PRESSURE": 60}))
	}
	batch = append(batch, h.record([]byte{0x0A, 0xFF, 0x01}))

	if err := h.processor.Process(context.Background(), batch); err != nil {
		t.Fatal(err)
	}

	if len(h.readings.rows) != 8 {
		t.Errorf("%d rows stored, want the 8 healthy ones", len(h.readings.rows))
	}
	var dlq, rejected []forwarded
	for _, f := range h.forwarder.sent {
		if f.topic == "gauge.dlq" {
			dlq = append(dlq, f)
		} else {
			rejected = append(rejected, f)
		}
	}
	if len(dlq) != 1 || dlq[0].offset != batch[5].Offset || dlq[0].reason != "write_failed" {
		t.Errorf("dead-lettered: %+v", dlq)
	}
	if len(rejected) != 1 || len(h.readings.rejected) != 1 {
		t.Errorf("the undecodable record of the batch must still be rejected: %+v", rejected)
	}
	if testutil.ToFloat64(h.metrics.Messages.WithLabelValues("dlq")) != 1 || testutil.ToFloat64(h.metrics.Messages.WithLabelValues("ok")) != 8 {
		t.Error("metrics not updated")
	}
}

func TestStationListIsParsedIntoRules(t *testing.T) {
	body := []byte(`{"stations": [{"machine_id": "M1", "config_version": 3, "config": {
	  "machine_id": "M1", "gauges": [
	    {"gauge_id": "P", "type": "analog_dial", "rules": {"min": 0, "max": 130, "max_rate_per_s": 30}},
	    {"gauge_id": "H", "type": "rolling_counter", "rules": {"monotonic": true}},
	    {"gauge_id": "T", "type": "timer_mmss"}]}}]}`)

	machines, err := parseStations(body)
	if err != nil {
		t.Fatal(err)
	}
	rules := machines["M1"]
	if len(rules) != 3 || *rules["P"].Max != 130 || *rules["P"].MaxRatePerS != 30 || rules["P"].Type != "analog_dial" {
		t.Errorf("dial rules: %+v", rules["P"])
	}
	if !rules["H"].Monotonic || rules["T"].Min != nil || rules["T"].Type != "timer_mmss" {
		t.Errorf("rules: %+v", rules)
	}
	if _, err := parseStations([]byte(`{"stations": [{"machine_id": "M1", "config": {"gauges": "x"}}]}`)); err == nil {
		t.Error("malformed config accepted")
	}
}
