package main

import (
	"fmt"
	"time"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

// States of a gauge and of a station, as the UI shows them.
const (
	StateOK      = "ok"
	StatePoor    = "poor"    // the reading cannot be trusted: image or decoding problem
	StateAlarm   = "alarm"   // the value breaks a rule of the config
	StateStale   = "stale"   // no recent reading
	StateOffline = "offline" // station only: no gauge has a recent reading
)

// Same threshold as gauge_1m: readings below it are kept out of the aggregate.
const minQuality = 0.7

// Reading is the latest row of a gauge in gauge_reading.
type Reading struct {
	TS      time.Time
	Value   *float64
	VMin    *float64
	VMax    *float64
	NFrames *int32
	Quality *float32
	Flags   []int16
}

func hasFlag(flags []int16, wanted ...gaugev1.Flag) bool {
	for _, f := range flags {
		for _, w := range wanted {
			if gaugev1.Flag(f) == w {
				return true
			}
		}
	}
	return false
}

// gaugeState judges the latest reading of a gauge; the first rule that
// matches wins. FLAG_CLOCK_SKEW and FLAG_NO_CONFIG say nothing about the
// reading itself and do not change the state.
func gaugeState(r *Reading, now time.Time, staleAfter time.Duration) string {
	switch {
	case r == nil, now.Sub(r.TS) > staleAfter, hasFlag(r.Flags, gaugev1.Flag_FLAG_STALE):
		return StateStale
	case hasFlag(r.Flags, gaugev1.Flag_FLAG_OUT_OF_RANGE, gaugev1.Flag_FLAG_RATE_LIMIT, gaugev1.Flag_FLAG_NON_MONOTONIC):
		return StateAlarm
	case r.Value == nil, r.Quality != nil && *r.Quality < minQuality,
		hasFlag(r.Flags, gaugev1.Flag_FLAG_BLUR, gaugev1.Flag_FLAG_GLARE, gaugev1.Flag_FLAG_OCCLUDED,
			gaugev1.Flag_FLAG_FORMAT_INVALID, gaugev1.Flag_FLAG_ROI_DRIFT):
		return StatePoor
	}
	return StateOK
}

// stationState is the worst state of the gauges; a station without a single
// recent reading is offline.
func stationState(gauges []string) string {
	count := map[string]int{}
	for _, s := range gauges {
		count[s]++
	}
	if count[StateStale] == len(gauges) {
		return StateOffline
	}
	for _, s := range []string{StateAlarm, StatePoor, StateStale} {
		if count[s] > 0 {
			return s
		}
	}
	return StateOK
}

// flagNames turns the stored flag numbers into the names of telemetry.proto.
func flagNames(flags []int16) []string {
	names := make([]string, 0, len(flags))
	for _, f := range flags {
		name, ok := gaugev1.Flag_name[int32(f)]
		if !ok {
			name = fmt.Sprintf("FLAG_%d", f)
		}
		names = append(names, name)
	}
	return names
}
