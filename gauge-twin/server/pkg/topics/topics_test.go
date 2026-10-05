package topics

import "testing"

func TestParse(t *testing.T) {
	got, ok := Parse("denso", "denso/DENSO_HN/L03/STAMPING_PRESS_01/telemetry")
	want := Topic{Plant: "DENSO_HN", Line: "L03", Machine: "STAMPING_PRESS_01", Kind: KindTelemetry}
	if !ok || got != want {
		t.Fatalf("got %+v, %v", got, ok)
	}
	if got.String("denso") != "denso/DENSO_HN/L03/STAMPING_PRESS_01/telemetry" {
		t.Errorf("round trip: %s", got.String("denso"))
	}

	for _, bad := range []string{
		"", "denso", "denso/a/b/c", "denso/a/b/c/d/e", "other/a/b/c/telemetry",
		"denso//b/c/telemetry", "denso/a/+/c/telemetry", "denso/a/b/#/telemetry",
	} {
		if _, ok := Parse("denso", bad); ok {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestSharedFilter(t *testing.T) {
	if got := SharedFilter("bridge", "denso", KindStatus); got != "$share/bridge/denso/+/+/+/status" {
		t.Errorf("got %s", got)
	}
}

func TestResendTopics(t *testing.T) {
	if got := ResendTopic("denso", "P1", "edge-7"); got != "denso/P1/edge/edge-7/cmd/resend" {
		t.Errorf("resend topic: %s", got)
	}
	if got := SharedResendAckFilter("state", "denso"); got != "$share/state/denso/+/edge/+/cmd/resend/ack" {
		t.Errorf("ack filter: %s", got)
	}
}
