package main

import (
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestHistoryPlan(t *testing.T) {
	day := 24 * time.Hour
	cases := []struct {
		span   time.Duration
		source string
		bucket time.Duration
	}{
		{5 * time.Minute, sourceRaw, time.Second},
		{10 * time.Minute, sourceRaw, time.Second},
		{time.Hour, sourceRaw, 10 * time.Second},
		{day, sourceRaw, 5 * time.Minute},
		{7 * day, sourceRaw, 30 * time.Minute},
		{7*day + time.Second, sourceMinute, 30 * time.Minute},
		{30 * day, sourceMinute, 2 * time.Hour},
		{365 * day, sourceMinute, day},
		{1500 * day, sourceMinute, 3 * day},
	}
	for _, c := range cases {
		source, bucket := historyPlan(c.span)
		if source != c.source || bucket != c.bucket {
			t.Errorf("%s: got %s %s, want %s %s", c.span, source, bucket, c.source, c.bucket)
		}
		if c.span > bucket*maxHistoryPoints {
			t.Errorf("%s: %s buckets do not fit in %d points", c.span, bucket, maxHistoryPoints)
		}
	}
}

func TestHistory(t *testing.T) {
	store := newTestStore()
	store.history = []HistoryPoint{{TS: testNow.Add(-30 * time.Minute), Value: ptr(1.5), Min: ptr(1.0), Max: ptr(9.0), Quality: ptr(float32(0.8)), N: 10}}
	srv := newTestServer(t, store, "")
	from := testNow.Add(-time.Hour)
	base := srv.URL + "/v1/stations/machine_001/history?gauge=OIL_TEMP&from=" + from.Format(time.RFC3339)

	var got historyView
	resp := get(t, base, &got)
	if resp.StatusCode != http.StatusOK || got.Source != sourceRaw || got.BucketS != 10 || !got.To.Equal(testNow) || !got.From.Equal(from) {
		t.Fatalf("got %d %+v", resp.StatusCode, got)
	}
	if len(got.Points) != 1 || *got.Points[0].Max != 9 || got.Points[0].N != 10 {
		t.Errorf("points: %+v", got.Points)
	}
	call := store.asked[0]
	if call.machine != "machine_001" || call.gauge != "OIL_TEMP" || !call.from.Equal(from) || !call.to.Equal(testNow) || call.bucket != 10*time.Second {
		t.Errorf("store asked %+v", call)
	}

	// A range of a month is answered from the one-minute aggregate.
	get(t, srv.URL+"/v1/stations/machine_001/history?gauge=OIL_TEMP&from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z", &got)
	if got.Source != sourceMinute || store.asked[1].source != sourceMinute || store.asked[1].bucket != 2*time.Hour {
		t.Errorf("month: got %s, store asked %+v", got.Source, store.asked[1])
	}

	for query, message := range map[string]string{
		"from=2026-10-06T00:00:00Z":                 "gauge is required",
		"gauge=X":                                   "from must be an RFC 3339 time",
		"gauge=X&from=yesterday":                    "from must be an RFC 3339 time",
		"gauge=X&from=2026-10-06T00:00:00Z&to=noon": "to must be an RFC 3339 time",
		"gauge=X&from=2026-10-06T00:00:00Z&to=2026-10-05T00:00:00Z": "to must be after from",
		"gauge=X&from=2026-10-06T00:00:00Z&format=xlsx":             "format must be json or csv",
	} {
		wantError(t, srv.URL+"/v1/stations/machine_001/history?"+query, http.StatusBadRequest, message)
	}
}

func TestHistoryAsCSV(t *testing.T) {
	store := newTestStore()
	store.history = []HistoryPoint{
		{TS: testNow.Add(-2 * time.Minute), Value: ptr(1.5), Min: ptr(1.0), Max: ptr(9.25), Quality: ptr(float32(0.8)), N: 10},
		{TS: testNow.Add(-time.Minute), N: 3},
	}
	srv := newTestServer(t, store, "")
	resp, err := http.Get(srv.URL + "/v1/stations/machine_001/history?gauge=OIL%20TEMP&format=csv&from=" + testNow.Add(-time.Hour).Format(time.RFC3339))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	want := "ts,value,min,max,quality,n\n2026-10-06T02:58:00Z,1.5,1,9.25,0.800,10\n2026-10-06T02:59:00Z,,,,,3\n"
	if string(raw) != want {
		t.Errorf("got %q, want %q", raw, want)
	}
	if got := resp.Header.Get("Content-Disposition"); got != `attachment; filename="machine_001_OIL_TEMP.csv"` {
		t.Errorf("file name: %s", got)
	}
	if !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/csv") {
		t.Errorf("content type: %s", resp.Header.Get("Content-Type"))
	}
}

func TestHistoryWithoutPointsIsAnEmptyList(t *testing.T) {
	srv := newTestServer(t, newTestStore(), "")
	resp, err := http.Get(srv.URL + "/v1/stations/machine_001/history?gauge=OIL_TEMP&from=2026-10-05T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(raw), `"points":[]`) {
		t.Errorf("got %s, want points []", raw)
	}
}
