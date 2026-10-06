// Package validate applies the server-side checks of SPEC section 5.1 to a
// telemetry message. It is pure: the caller supplies the config, the clock and
// the previously stored values.
//
// A violated constraint never drops a reading. The reading is stored with an
// extra flag and its quality capped, so consumers can filter it out.
package validate

import (
	"math"
	"sort"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

const (
	// QualityCap is the highest quality a reading that violates a constraint
	// can keep; it is below the 0.7 threshold of the gauge_1m aggregate.
	QualityCap = 0.3
	// MaxSkewMs is how far window_end may be from the server clock.
	MaxSkewMs = 5 * 60 * 1000
)

// GaugeRules are the constraints of one gauge, from its station config.
type GaugeRules struct {
	Type        string
	Min, Max    *float64
	MaxRatePerS *float64
	Monotonic   bool
}

// MachineConfig maps gauge_id to its rules.
type MachineConfig map[string]GaugeRules

// Previous is the latest stored reading of a gauge.
type Previous struct {
	Value float64
	TsMs  int64
	OK    bool
}

// Input is everything Check needs for one message.
type Input struct {
	Telemetry *gaugev1.Telemetry
	// Config is nil when the machine has no config in config-api.
	Config MachineConfig
	NowMs  int64
	// Latest returns the newest stored reading of a gauge of this machine.
	Latest func(gaugeID string) Previous
	// HourMeter is the last accepted monotonic value of this machine.
	HourMeter    float64
	HasHourMeter bool
}

// Row is one gauge_reading row, plus what the caller needs to update Redis.
type Row struct {
	TsMs         int64 // window_end
	MachineID    string
	GaugeID      string
	Value        *float64
	VMin, VMax   float64
	NFrames      int32
	Quality      float32
	Flags        []int16
	EdgeID       string
	Seq          int64
	ModelVersion string
	// Replayed is true for data drained from the edge buffer or resent.
	Replayed bool
	// Late is true when the reading is older than the stored latest one of
	// its gauge although it was not marked as replayed: realtime data that
	// was overtaken, e.g. after a broker or bridge failover.
	Late bool

	GaugeType string
	// UpdateLatest is false for unreadable, clock-skewed or late readings,
	// which must not become the "latest" value.
	UpdateLatest bool
	// Monotonic marks hour-meter style gauges.
	Monotonic bool
}

// Check turns a message into rows, adding flags and capping the quality of
// readings that violate a constraint.
func Check(in Input) []Row {
	tel := in.Telemetry
	end := tel.GetWindowEndMs()
	// Replayed data is old by nature: it is exempt from the clock check and
	// is not compared with stored values, which may be newer than it. The
	// same holds, per gauge, for a reading older than the stored latest one
	// (late), whatever the replayed mark says.
	replayed := tel.GetReplayed()
	skewed := !replayed && math.Abs(float64(end-in.NowMs)) > MaxSkewMs

	rows := make([]Row, 0, len(tel.GetMeasurements()))
	for _, m := range tel.GetMeasurements() {
		flags := map[gaugev1.Flag]bool{}
		for _, f := range m.GetFlags() {
			flags[f] = true
		}
		row := Row{
			TsMs: end, MachineID: tel.GetMachineId(), GaugeID: m.GetGaugeId(), Value: m.Value,
			VMin: m.GetVMin(), VMax: m.GetVMax(), NFrames: int32(m.GetNFrames()), Quality: m.GetQuality(),
			EdgeID: tel.GetEdgeId(), Seq: int64(tel.GetSeq()), ModelVersion: tel.GetModelVersion(),
			Replayed: replayed,
		}
		violated := false
		if skewed {
			flags[gaugev1.Flag_FLAG_CLOCK_SKEW] = true
			violated = true
		}

		rules, known := in.Config[m.GetGaugeId()]
		if !known {
			// No config for the machine or for this gauge: stored as is, but
			// visibly unchecked. The quality is not lowered.
			flags[gaugev1.Flag_FLAG_NO_CONFIG] = true
		} else {
			row.GaugeType, row.Monotonic = rules.Type, rules.Monotonic
		}

		var prev Previous
		if in.Latest != nil {
			prev = in.Latest(m.GetGaugeId())
		}
		late := prev.OK && prev.TsMs > end
		row.Late = late && !replayed

		if known && m.Value != nil {
			value := m.GetValue()
			if (rules.Min != nil && value < *rules.Min) || (rules.Max != nil && value > *rules.Max) {
				flags[gaugev1.Flag_FLAG_OUT_OF_RANGE] = true
				violated = true
			}
			if !replayed && !late && !skewed && rules.MaxRatePerS != nil && prev.OK && prev.TsMs < end {
				rate := math.Abs(value-prev.Value) / (float64(end-prev.TsMs) / 1000)
				if rate > *rules.MaxRatePerS {
					flags[gaugev1.Flag_FLAG_RATE_LIMIT] = true
					violated = true
				}
			}
			if !replayed && !late && !skewed && rules.Monotonic && in.HasHourMeter && value < in.HourMeter {
				flags[gaugev1.Flag_FLAG_NON_MONOTONIC] = true
				violated = true
			}
		}

		if violated && row.Quality > QualityCap {
			row.Quality = QualityCap
		}
		row.UpdateLatest = m.Value != nil && !skewed && !late
		row.Flags = make([]int16, 0, len(flags))
		for f := range flags {
			row.Flags = append(row.Flags, int16(f))
		}
		sort.Slice(row.Flags, func(i, j int) bool { return row.Flags[i] < row.Flags[j] })
		rows = append(rows, row)
	}
	return rows
}
