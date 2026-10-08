package main

import (
	"reflect"
	"testing"
	"time"
)

func ptr[T any](v T) *T { return &v }

func TestGaugeState(t *testing.T) {
	now := time.Date(2026, 10, 6, 3, 0, 0, 0, time.UTC)
	reading := func(age time.Duration, value *float64, quality float32, flags ...int16) *Reading {
		return &Reading{TS: now.Add(-age), Value: value, Quality: &quality, Flags: flags}
	}
	v := ptr(12.5)
	cases := []struct {
		name string
		r    *Reading
		want string
	}{
		{"no reading", nil, StateStale},
		{"older than the threshold", reading(31*time.Second, v, 0.9), StateStale},
		{"exactly at the threshold", reading(30*time.Second, v, 0.9), StateOK},
		{"stale flag", reading(time.Second, v, 0.9, 9), StateStale},
		{"out of range", reading(time.Second, v, 0.9, 4), StateAlarm},
		{"rate limit", reading(time.Second, v, 0.9, 5), StateAlarm},
		{"non monotonic", reading(time.Second, v, 0.9, 6), StateAlarm},
		{"alarm wins over poor", reading(time.Second, v, 0.2, 4, 1), StateAlarm},
		{"no value", reading(time.Second, nil, 0.9), StatePoor},
		{"low quality", reading(time.Second, v, 0.69), StatePoor},
		{"blur", reading(time.Second, v, 0.9, 1), StatePoor},
		{"glare", reading(time.Second, v, 0.9, 2), StatePoor},
		{"occluded", reading(time.Second, v, 0.9, 3), StatePoor},
		{"format invalid", reading(time.Second, v, 0.9, 7), StatePoor},
		{"roi drift", reading(time.Second, v, 0.9, 8), StatePoor},
		{"quality at the threshold", reading(time.Second, v, 0.7), StateOK},
		{"clock skew is not a reading problem", reading(time.Second, v, 0.9, 10), StateOK},
		{"no config is not a reading problem", reading(time.Second, v, 0.9, 11), StateOK},
	}
	for _, c := range cases {
		if got := gaugeState(c.r, now, 30*time.Second); got != c.want {
			t.Errorf("%s: got %s, want %s", c.name, got, c.want)
		}
	}
}

func TestGaugeStateWithoutQuality(t *testing.T) {
	now := time.Now()
	r := &Reading{TS: now, Value: ptr(1.0)}
	if got := gaugeState(r, now, time.Minute); got != StateOK {
		t.Errorf("got %s, want ok: a reading without quality is not judged on it", got)
	}
}

func TestStationState(t *testing.T) {
	cases := []struct {
		gauges []string
		want   string
	}{
		{nil, StateOffline},
		{[]string{StateStale, StateStale}, StateOffline},
		{[]string{StateOK, StateAlarm, StatePoor}, StateAlarm},
		{[]string{StateOK, StatePoor, StateStale}, StatePoor},
		{[]string{StateOK, StateStale}, StateStale},
		{[]string{StateOK, StateOK}, StateOK},
	}
	for _, c := range cases {
		if got := stationState(c.gauges); got != c.want {
			t.Errorf("%v: got %s, want %s", c.gauges, got, c.want)
		}
	}
}

func TestFlagNames(t *testing.T) {
	if got, want := flagNames([]int16{4, 1}), []string{"FLAG_OUT_OF_RANGE", "FLAG_BLUR"}; !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
	if got, want := flagNames([]int16{99}), []string{"FLAG_99"}; !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
	if got := flagNames(nil); got == nil || len(got) != 0 {
		t.Errorf("got %#v, want an empty slice (JSON [] rather than null)", got)
	}
}

func TestStaleLimitFollowsHowOftenAGaugeIsReported(t *testing.T) {
	const staleAfter, lookback = 30 * time.Second, 10 * time.Minute
	every := GaugeConfig{Type: "analog_dial"}
	deadband := GaugeConfig{Type: "seg7"}
	deadband.Rules.Deadband = ptr(0.5)
	counter := GaugeConfig{Type: "rolling_counter"}
	periodic := GaugeConfig{Type: "rolling_counter"}
	periodic.Rules.ReportIntervalS = 300
	cases := []struct {
		name string
		g    GaugeConfig
		want time.Duration
	}{
		{"reported in every window", every, 30 * time.Second},
		{"deadband: repeated once a minute", deadband, 90 * time.Second},
		{"counter without interval: reported on change only", counter, 10 * time.Minute},
		{"counter with a report interval", periodic, 330 * time.Second},
	}
	for _, c := range cases {
		if got := c.g.staleLimit(staleAfter, lookback); got != c.want {
			t.Errorf("%s: got %s, want %s", c.name, got, c.want)
		}
	}
	// A counter that did not move for two minutes is not a silent gauge.
	now := time.Now()
	r := &Reading{TS: now.Add(-2 * time.Minute), Value: ptr(5600.4), Quality: ptr(float32(0.9))}
	if got := gaugeState(r, now, counter.staleLimit(staleAfter, lookback)); got != StateOK {
		t.Errorf("steady counter: got %s, want ok", got)
	}
	if got := gaugeState(r, now, every.staleLimit(staleAfter, lookback)); got != StateStale {
		t.Errorf("dial silent for two minutes: got %s, want stale", got)
	}
}
