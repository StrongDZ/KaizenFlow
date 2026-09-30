package livesvc

import (
	"context"
	"testing"
	"time"

	"github.com/kaizenflow/api/internal/live"
	"github.com/kaizenflow/api/internal/store"
)

type liveMsg = live.Message

type fakeDriftStore struct {
	runs     map[string]*store.RunRow
	bands    []store.BandRow
	insights []store.Insight
	bandCall int
}

func (f *fakeDriftStore) LatestNowcastRun(_ context.Context, model string) (*store.RunRow, error) {
	return f.runs[model], nil
}

func (f *fakeDriftStore) Bands(_ context.Context, _ int64, subject, metric string) ([]store.BandRow, error) {
	f.bandCall++
	var out []store.BandRow
	for _, b := range f.bands {
		if b.Subject == subject && b.Metric == metric {
			out = append(out, b)
		}
	}
	return out, nil
}

func (f *fakeDriftStore) OpenInsightExists(_ context.Context, runID int64, kind, subject, metric string) (bool, error) {
	for _, in := range f.insights {
		if in.SimRunID != nil && *in.SimRunID == runID && in.Kind == kind && in.SubjectKey != nil && *in.SubjectKey == subject &&
			in.Payload["metric"] == metric && in.Status == "OPEN" {
			return true, nil
		}
	}
	return false, nil
}

func (f *fakeDriftStore) InsertInsight(_ context.Context, in store.Insight) (int64, error) {
	in.ID = int64(len(f.insights) + 1)
	in.Status = "OPEN"
	f.insights = append(f.insights, in)
	return in.ID, nil
}

func flatBands(subject, metric string, start time.Time, p10, p50, p90 float64) []store.BandRow {
	var out []store.BandRow
	for m := 0; m <= 600; m += 10 {
		out = append(out, store.BandRow{Subject: subject, Metric: metric, T: start.Add(time.Duration(m) * time.Minute), P10: p10, P50: p50, P90: p90})
	}
	return out
}

func driftFixture(t *testing.T) (*Service, *fakeDriftStore, *Monitor, *fakeHub) {
	t.Helper()
	svc, _, hub := newSvc(t, bind("m", "KHO", "level:RAW-01", "wms", "qty"))
	ds := &fakeDriftStore{runs: map[string]*store.RunRow{"m": {ID: 7, SimStart: t0, Status: "DONE", ModelKey: "m"}},
		bands: flatBands("KHO", "level:RAW-01", t0, 90, 100, 110)}
	return svc, ds, NewMonitor(ds, svc, hub), hub
}

func level(svc *Service, at time.Duration, qty float64) {
	svc.Ingest([]liveMsg{{Source: "wms", TS: t0.Add(at), Payload: map[string]any{"qty": qty}}})
}

func TestMonitorRaisesOneDriftInsightAfterThreeSeparatedOutOfBandChecks(t *testing.T) {
	svc, ds, mon, hub := driftFixture(t)
	ctx := context.Background()
	for i, at := range []time.Duration{10 * time.Minute, 16 * time.Minute, 22 * time.Minute} {
		level(svc, at, 40) // thấp hơn hẳn dải 90–110
		if err := mon.Tick(ctx); err != nil {
			t.Fatal(err)
		}
		want := 0
		if i == 2 {
			want = 1
		}
		if len(ds.insights) != want {
			t.Fatalf("after check %d: %d insights, want %d", i+1, len(ds.insights), want)
		}
	}
	in := ds.insights[0]
	if in.Kind != "DRIFT" || *in.SubjectKey != "KHO" || *in.SimRunID != 7 || in.Payload["metric"] != "level:RAW-01" || in.Payload["direction"] != "below" {
		t.Errorf("insight = %+v", in)
	}
	if in.Payload["actual"] != 40.0 || in.Payload["p10"].(float64) != 90 || in.Payload["p90"].(float64) != 110 {
		t.Errorf("payload = %+v", in.Payload)
	}
	level(svc, 40*time.Minute, 30)
	_ = mon.Tick(ctx)
	if len(ds.insights) != 1 {
		t.Errorf("no duplicate while the deviation continues: %d", len(ds.insights))
	}
	got := false
	for _, m := range hub.msgs {
		if mm, ok := m.(map[string]any); ok && mm["type"] == "insight" && mm["model"] == "m" {
			got = true
		}
	}
	if !got {
		t.Errorf("the UI must be told about the new insight: %+v", hub.msgs)
	}
}

func TestMonitorStaysQuietInsideTheBandOutsideTheWindowOrWithoutAForecast(t *testing.T) {
	svc, ds, mon, _ := driftFixture(t)
	ctx := context.Background()
	for _, at := range []time.Duration{10 * time.Minute, 20 * time.Minute, 30 * time.Minute, 40 * time.Minute} {
		level(svc, at, 101)
		_ = mon.Tick(ctx)
	}
	for _, at := range []time.Duration{-3 * time.Hour, 20 * time.Hour, 21 * time.Hour, 22 * time.Hour} {
		level(svc, at, 1) // trước khi dự báo bắt đầu hoặc sau khi dự báo kết thúc: không so được
		_ = mon.Tick(ctx)
	}
	if len(ds.insights) != 0 {
		t.Errorf("insights = %+v", ds.insights)
	}
	ds.runs = map[string]*store.RunRow{}
	level(svc, 50*time.Minute, 1)
	if err := mon.Tick(ctx); err != nil || len(ds.insights) != 0 {
		t.Errorf("no forecast, no drift: %v %+v", err, ds.insights)
	}
}

func TestMonitorFetchesBandsOncePerSeries(t *testing.T) {
	svc, ds, mon, _ := driftFixture(t)
	for i := 1; i <= 5; i++ {
		level(svc, time.Duration(i)*7*time.Minute, 101)
		_ = mon.Tick(context.Background())
	}
	if ds.bandCall != 1 {
		t.Errorf("bands are immutable per run; fetched %d times", ds.bandCall)
	}
}

func TestMonitorDoesNotRaiseAgainWhileAnOpenInsightExists(t *testing.T) {
	svc, ds, mon, _ := driftFixture(t)
	rid := int64(7)
	subj := "KHO"
	ds.insights = []store.Insight{{ID: 1, Kind: "DRIFT", SimRunID: &rid, SubjectKey: &subj, Status: "OPEN", Payload: map[string]any{"metric": "level:RAW-01"}}}
	for _, at := range []time.Duration{10 * time.Minute, 20 * time.Minute, 30 * time.Minute} {
		level(svc, at, 40)
		_ = mon.Tick(context.Background())
	}
	if len(ds.insights) != 1 {
		t.Errorf("insights = %d", len(ds.insights))
	}
}
