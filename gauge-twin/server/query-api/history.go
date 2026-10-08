package main

import (
	"context"
	"encoding/csv"
	"math"
	"net/http"
	"strconv"
	"time"
)

// Limits of the history route.
const (
	// maxHistoryPoints is the number of buckets one answer carries at most.
	maxHistoryPoints = 600
	// rawHistory is the longest range answered from the readings themselves;
	// a longer one reads the one-minute aggregate.
	rawHistory = 7 * 24 * time.Hour
)

// Sources of a history answer.
const (
	sourceRaw    = "raw"
	sourceMinute = "1m"
)

// historySteps are the bucket widths a history answer can have.
var historySteps = []time.Duration{
	time.Second, 2 * time.Second, 5 * time.Second, 10 * time.Second, 15 * time.Second, 30 * time.Second,
	time.Minute, 2 * time.Minute, 5 * time.Minute, 10 * time.Minute, 15 * time.Minute, 30 * time.Minute,
	time.Hour, 2 * time.Hour, 3 * time.Hour, 6 * time.Hour, 12 * time.Hour, 24 * time.Hour,
}

// HistoryPoint is one bucket of the history of a gauge. Min and Max are the
// extremes of the bucket, so that a short excursion survives a wide bucket.
type HistoryPoint struct {
	TS    time.Time `json:"ts"`
	Value *float64  `json:"value"`
	Min   *float64  `json:"min"`
	Max   *float64  `json:"max"`
	// Quality is the lowest quality in the bucket; null from the aggregate.
	Quality *float32 `json:"quality"`
	// N is the number of readings in the bucket.
	N int64 `json:"n"`
}

// historyPlan picks the source and the bucket width of a range: the
// narrowest step that keeps the answer within maxHistoryPoints.
func historyPlan(span time.Duration) (source string, bucket time.Duration) {
	source, least := sourceRaw, time.Second
	if span > rawHistory {
		source, least = sourceMinute, time.Minute
	}
	bucket = historySteps[len(historySteps)-1]
	for _, step := range historySteps {
		if step >= least && span <= step*maxHistoryPoints {
			return source, step
		}
	}
	// Longer than the widest step covers: whole days.
	for span > bucket*maxHistoryPoints {
		bucket += 24 * time.Hour
	}
	return source, bucket
}

type historyView struct {
	MachineID string    `json:"machine_id"`
	GaugeID   string    `json:"gauge_id"`
	From      time.Time `json:"from"`
	To        time.Time `json:"to"`
	// BucketS is the width of a bucket in seconds; a bucket without readings
	// is absent from points.
	BucketS int64          `json:"bucket_s"`
	Source  string         `json:"source"`
	Points  []HistoryPoint `json:"points"`
}

// history answers what a gauge read between ?from= and ?to= (RFC 3339; to
// defaults to now), as JSON or with ?format=csv as a file.
func (a *API) history(w http.ResponseWriter, r *http.Request) int {
	query := r.URL.Query()
	gauge := query.Get("gauge")
	if gauge == "" {
		return writeJSON(w, http.StatusBadRequest, apiError{Error: "gauge is required"})
	}
	from, err := time.Parse(time.RFC3339, query.Get("from"))
	if err != nil {
		return writeJSON(w, http.StatusBadRequest, apiError{Error: "from must be an RFC 3339 time"})
	}
	to := a.now()
	if raw := query.Get("to"); raw != "" {
		if to, err = time.Parse(time.RFC3339, raw); err != nil {
			return writeJSON(w, http.StatusBadRequest, apiError{Error: "to must be an RFC 3339 time"})
		}
	}
	if !to.After(from) {
		return writeJSON(w, http.StatusBadRequest, apiError{Error: "to must be after from"})
	}
	format := query.Get("format")
	if format != "" && format != "json" && format != "csv" {
		return writeJSON(w, http.StatusBadRequest, apiError{Error: "format must be json or csv"})
	}
	machine := r.PathValue("machine_id")
	source, bucket := historyPlan(to.Sub(from))
	points, err := a.store.History(r.Context(), machine, gauge, from, to, bucket, source)
	if err != nil {
		return a.fail(w, err)
	}
	if points == nil {
		points = []HistoryPoint{}
	}
	if format == "csv" {
		return writeHistoryCSV(w, machine, gauge, points)
	}
	return writeJSON(w, http.StatusOK, historyView{MachineID: machine, GaugeID: gauge, From: from.UTC(), To: to.UTC(),
		BucketS: int64(bucket / time.Second), Source: source, Points: points})
}

func writeHistoryCSV(w http.ResponseWriter, machine, gauge string, points []HistoryPoint) int {
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+csvName(machine+"_"+gauge)+`.csv"`)
	w.WriteHeader(http.StatusOK)
	out := csv.NewWriter(w)
	number := func(v *float64) string {
		if v == nil {
			return ""
		}
		// Six decimals: an average carries the noise of binary fractions.
		return strconv.FormatFloat(math.Round(*v*1e6)/1e6, 'f', -1, 64)
	}
	_ = out.Write([]string{"ts", "value", "min", "max", "quality", "n"})
	for _, p := range points {
		quality := ""
		if p.Quality != nil {
			quality = strconv.FormatFloat(float64(*p.Quality), 'f', 3, 32)
		}
		_ = out.Write([]string{p.TS.UTC().Format(time.RFC3339), number(p.Value), number(p.Min), number(p.Max), quality, strconv.FormatInt(p.N, 10)})
	}
	out.Flush()
	return http.StatusOK
}

// csvName keeps the characters that are safe in a file name of a header.
func csvName(name string) string {
	out := []rune(name)
	for i, c := range out {
		if (c < 'a' || c > 'z') && (c < 'A' || c > 'Z') && (c < '0' || c > '9') && c != '_' && c != '-' {
			out[i] = '_'
		}
	}
	return string(out)
}

func (p *PgStore) History(ctx context.Context, machine, gauge string, from, to time.Time, bucket time.Duration, source string) ([]HistoryPoint, error) {
	// The window extremes of a reading are wider than its value; a reading
	// without them counts with its value.
	sql := `
		SELECT time_bucket($5::interval, ts) AS b, avg(value), min(coalesce(v_min, value)), max(coalesce(v_max, value)),
		       min(quality), count(*)
		FROM gauge_reading
		WHERE machine_id = $1 AND gauge_id = $2 AND ts >= $3 AND ts < $4
		GROUP BY b ORDER BY b`
	if source == sourceMinute {
		// Every reading that has a value, whatever its quality: the history
		// shows what was reported. min_v and max_v only cover the good ones.
		sql = `
			SELECT time_bucket($5::interval, bucket) AS b, sum(avg_v_all * n_all) / nullif(sum(n_all), 0),
			       min(coalesce(min_v, avg_v_all)), max(coalesce(max_v, avg_v_all)), NULL::real, sum(n_all)::bigint
			FROM gauge_1m
			WHERE machine_id = $1 AND gauge_id = $2 AND bucket >= $3 AND bucket < $4
			GROUP BY b ORDER BY b`
	}
	rows, err := p.pool.Query(ctx, sql, machine, gauge, from, to, bucket)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []HistoryPoint
	for rows.Next() {
		var pt HistoryPoint
		if err := rows.Scan(&pt.TS, &pt.Value, &pt.Min, &pt.Max, &pt.Quality, &pt.N); err != nil {
			return nil, err
		}
		out = append(out, pt)
	}
	return out, rows.Err()
}
