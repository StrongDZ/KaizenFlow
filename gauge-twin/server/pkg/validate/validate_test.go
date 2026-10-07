package validate

import (
	"reflect"
	"testing"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

const now = int64(1_700_000_000_000)

func f(v float64) *float64 { return &v }

func config() MachineConfig {
	return MachineConfig{
		"MAIN_PRESSURE":    {Type: "analog_dial", Min: f(0), Max: f(130), MaxRatePerS: f(30)},
		"VOLTMETER":        {Type: "seg7", Min: f(0), Max: f(500)},
		"TOTAL_HOUR_METER": {Type: "rolling_counter", Monotonic: true},
	}
}

func telemetry(endMs int64, measurements ...*gaugev1.Measurement) *gaugev1.Telemetry {
	return &gaugev1.Telemetry{EdgeId: "edge-1", Seq: 9, MachineId: "M1", WindowStartMs: endMs - 1000, WindowEndMs: endMs,
		ModelVersion: "m1", Measurements: measurements}
}

func reading(gauge string, value float64, quality float32, flags ...gaugev1.Flag) *gaugev1.Measurement {
	return &gaugev1.Measurement{GaugeId: gauge, Value: &value, VMin: value, VMax: value, NFrames: 2, Quality: quality, Flags: flags}
}

func flags(values ...gaugev1.Flag) []int16 {
	out := make([]int16, len(values))
	for i, v := range values {
		out[i] = int16(v)
	}
	return out
}

func TestCleanReadingPassesUnchanged(t *testing.T) {
	rows := Check(Input{Telemetry: telemetry(now, reading("MAIN_PRESSURE", 60, 0.9)), Config: config(), NowMs: now + 800})

	row := rows[0]
	if len(row.Flags) != 0 || row.Quality != 0.9 || !row.UpdateLatest || row.GaugeType != "analog_dial" {
		t.Errorf("row: %+v", row)
	}
	if row.TsMs != now || row.MachineID != "M1" || row.EdgeID != "edge-1" || row.Seq != 9 || *row.Value != 60 || row.NFrames != 2 {
		t.Errorf("fields: %+v", row)
	}
}

func TestOutOfRangeIsFlaggedAndQualityCapped(t *testing.T) {
	rows := Check(Input{Telemetry: telemetry(now, reading("MAIN_PRESSURE", 140, 0.9), reading("VOLTMETER", -1, 0.2)), Config: config(), NowMs: now})

	if !reflect.DeepEqual(rows[0].Flags, flags(gaugev1.Flag_FLAG_OUT_OF_RANGE)) || rows[0].Quality != QualityCap || *rows[0].Value != 140 {
		t.Errorf("dial: %+v", rows[0])
	}
	// A quality already below the cap is left alone.
	if rows[1].Quality != 0.2 || len(rows[1].Flags) != 1 {
		t.Errorf("voltmeter: %+v", rows[1])
	}
}

func TestEdgeFlagsAreKeptAndMergedWithoutDuplicates(t *testing.T) {
	m := reading("MAIN_PRESSURE", 140, 0.9, gaugev1.Flag_FLAG_GLARE, gaugev1.Flag_FLAG_OUT_OF_RANGE)
	rows := Check(Input{Telemetry: telemetry(now, m), Config: config(), NowMs: now})

	if !reflect.DeepEqual(rows[0].Flags, flags(gaugev1.Flag_FLAG_GLARE, gaugev1.Flag_FLAG_OUT_OF_RANGE)) {
		t.Errorf("flags: %v", rows[0].Flags)
	}
}

func TestRateOfChangeUsesWindowEndOfThePreviousReading(t *testing.T) {
	latest := func(string) Previous { return Previous{Value: 60, TsMs: now - 1000, OK: true} }
	in := Input{Config: config(), NowMs: now, Latest: latest}

	in.Telemetry = telemetry(now, reading("MAIN_PRESSURE", 100, 0.9)) // 40 bar in 1 s > 30 bar/s
	if rows := Check(in); !reflect.DeepEqual(rows[0].Flags, flags(gaugev1.Flag_FLAG_RATE_LIMIT)) || rows[0].Quality != QualityCap {
		t.Errorf("fast change: %+v", rows[0])
	}
	in.Telemetry = telemetry(now, reading("MAIN_PRESSURE", 85, 0.9)) // 25 bar/s
	if rows := Check(in); len(rows[0].Flags) != 0 {
		t.Errorf("allowed change flagged: %+v", rows[0])
	}
	// A stored reading that is not older than this one says nothing about its rate.
	in.Latest = func(string) Previous { return Previous{Value: 10, TsMs: now + 5000, OK: true} }
	in.Telemetry = telemetry(now, reading("MAIN_PRESSURE", 100, 0.9))
	if rows := Check(in); len(rows[0].Flags) != 0 {
		t.Errorf("compared with a newer reading: %+v", rows[0])
	}
}

func TestHourMeterMustNotGoBackwards(t *testing.T) {
	in := Input{Config: config(), NowMs: now, HourMeter: 1234.5, HasHourMeter: true}

	in.Telemetry = telemetry(now, reading("TOTAL_HOUR_METER", 1234.4, 0.9))
	rows := Check(in)
	if !reflect.DeepEqual(rows[0].Flags, flags(gaugev1.Flag_FLAG_NON_MONOTONIC)) || rows[0].Quality != QualityCap || !rows[0].Monotonic {
		t.Errorf("decrease: %+v", rows[0])
	}
	in.Telemetry = telemetry(now, reading("TOTAL_HOUR_METER", 1234.5, 0.9))
	if rows := Check(in); len(rows[0].Flags) != 0 {
		t.Errorf("equal value flagged: %+v", rows[0])
	}
}

func TestReplayedMessagesAreNotComparedWithStoredValues(t *testing.T) {
	in := Input{Config: config(), NowMs: now, HourMeter: 2000, HasHourMeter: true,
		Latest: func(string) Previous { return Previous{Value: 0, TsMs: now - 3_600_000 - 1000, OK: true} }}
	old := telemetry(now-3_600_000, reading("MAIN_PRESSURE", 100, 0.9), reading("TOTAL_HOUR_METER", 1500, 0.9), reading("VOLTMETER", 900, 0.9))
	old.Replayed = true
	in.Telemetry = old

	rows := Check(in)

	// An hour old, far from "latest" and below the hour meter: all fine for a replay.
	if len(rows[0].Flags) != 0 || len(rows[1].Flags) != 0 {
		t.Errorf("replay compared with stored state: %+v %+v", rows[0], rows[1])
	}
	// The range is a property of the reading itself and still applies.
	if !reflect.DeepEqual(rows[2].Flags, flags(gaugev1.Flag_FLAG_OUT_OF_RANGE)) {
		t.Errorf("range check on replay: %+v", rows[2])
	}
	if !rows[0].UpdateLatest {
		t.Error("a replayed row newer than latest may update it")
	}
	if !rows[0].Replayed {
		t.Error("the replayed flag must be carried into the row")
	}
}

func TestClockSkewIsFlaggedAndNeverBecomesLatest(t *testing.T) {
	for _, shift := range []int64{MaxSkewMs + 1000, -MaxSkewMs - 1000} {
		in := Input{Telemetry: telemetry(now+shift, reading("MAIN_PRESSURE", 60, 0.9)), Config: config(), NowMs: now,
			Latest: func(string) Previous { return Previous{Value: 0, TsMs: now - 1000, OK: true} }}
		rows := Check(in)
		if !reflect.DeepEqual(rows[0].Flags, flags(gaugev1.Flag_FLAG_CLOCK_SKEW)) || rows[0].Quality != QualityCap || rows[0].UpdateLatest {
			t.Errorf("shift %d: %+v", shift, rows[0])
		}
	}
	// Within the tolerance nothing happens.
	in := Input{Telemetry: telemetry(now-MaxSkewMs+1000, reading("MAIN_PRESSURE", 60, 0.9)), Config: config(), NowMs: now}
	if rows := Check(in); len(rows[0].Flags) != 0 {
		t.Errorf("within tolerance: %+v", rows[0])
	}
}

func TestMachineOrGaugeWithoutConfigIsFlaggedButNotPenalised(t *testing.T) {
	rows := Check(Input{Telemetry: telemetry(now, reading("MAIN_PRESSURE", 9999, 0.9)), Config: nil, NowMs: now})
	if !reflect.DeepEqual(rows[0].Flags, flags(gaugev1.Flag_FLAG_NO_CONFIG)) || rows[0].Quality != 0.9 || !rows[0].UpdateLatest {
		t.Errorf("no machine config: %+v", rows[0])
	}
	rows = Check(Input{Telemetry: telemetry(now, reading("UNKNOWN_GAUGE", 1, 0.8)), Config: config(), NowMs: now})
	if !reflect.DeepEqual(rows[0].Flags, flags(gaugev1.Flag_FLAG_NO_CONFIG)) || rows[0].Quality != 0.8 {
		t.Errorf("unknown gauge: %+v", rows[0])
	}
}

func TestUnreadableGaugeIsStoredWithoutValue(t *testing.T) {
	m := &gaugev1.Measurement{GaugeId: "VOLTMETER", Flags: []gaugev1.Flag{gaugev1.Flag_FLAG_BLUR}, NRejected: 2}
	rows := Check(Input{Telemetry: telemetry(now, m), Config: config(), NowMs: now})

	if rows[0].Value != nil || rows[0].UpdateLatest || !reflect.DeepEqual(rows[0].Flags, flags(gaugev1.Flag_FLAG_BLUR)) {
		t.Errorf("row: %+v", rows[0])
	}
}

func TestRealtimeReadingOlderThanLatestIsLateAndNotComparedWithStoredValues(t *testing.T) {
	// After a failover a realtime message can arrive behind newer ones: the
	// hour meter already moved on, but this reading is not a step backwards.
	in := Input{Config: config(), NowMs: now, HourMeter: 2000, HasHourMeter: true,
		Latest: func(string) Previous { return Previous{Value: 10, TsMs: now - 1000, OK: true} }}
	in.Telemetry = telemetry(now-3000, reading("TOTAL_HOUR_METER", 1999.9, 0.9), reading("MAIN_PRESSURE", 120, 0.9),
		reading("VOLTMETER", 900, 0.9))

	rows := Check(in)

	for _, row := range rows[:2] {
		if len(row.Flags) != 0 || row.Quality != 0.9 {
			t.Errorf("late reading compared with stored state: %+v", row)
		}
		if !row.Late || row.UpdateLatest || row.Replayed {
			t.Errorf("late marks: %+v", row)
		}
	}
	if !reflect.DeepEqual(rows[2].Flags, flags(gaugev1.Flag_FLAG_OUT_OF_RANGE)) {
		t.Errorf("range check on a late reading: %+v", rows[2])
	}

	// The same timestamp as latest is a redelivery, not a late reading.
	in.Latest = func(string) Previous { return Previous{Value: 10, TsMs: now - 3000, OK: true} }
	if rows := Check(in); rows[0].Late || !rows[0].UpdateLatest {
		t.Errorf("redelivery treated as late: %+v", rows[0])
	}
	// A replayed message is not counted as late; its mark already says so.
	in.Latest = func(string) Previous { return Previous{Value: 10, TsMs: now, OK: true} }
	in.Telemetry.Replayed = true
	if rows := Check(in); rows[0].Late || rows[0].UpdateLatest {
		t.Errorf("replayed and older than latest: %+v", rows[0])
	}
}
