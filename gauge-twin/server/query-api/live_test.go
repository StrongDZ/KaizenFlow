package main

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

type sentMessage struct {
	topic   string
	request *gaugev1.PreviewRequest
}

// testLive is a LiveFrames with a clock the test moves and a recorded broker.
func testLive(now *time.Time, sent *[]sentMessage) *LiveFrames {
	l := NewLiveFrames("denso")
	l.Now = func() time.Time { return *now }
	l.publish = func(_ context.Context, topic string, payload []byte) error {
		var req gaugev1.PreviewRequest
		_ = proto.Unmarshal(payload, &req)
		*sent = append(*sent, sentMessage{topic, &req})
		return nil
	}
	return l
}

func previewPayload(machine, camera string, tsMs int64) []byte {
	payload, _ := proto.Marshal(&gaugev1.Preview{
		MachineId: machine, CameraId: camera, FrameTsMs: tsMs, Jpeg: []byte("JPEG"), FrameWidth: 1920, FrameHeight: 1080,
		Readings: []*gaugev1.PreviewReading{
			{GaugeId: "OIL_TEMP", Value: proto.Float64(122.5), Confidence: 0.9},
			{GaugeId: "AMMETER", Confidence: 0.1}, // not readable on this frame
		},
	})
	return payload
}

func TestWatchAsksTheEdgeAndNotOnEveryPoll(t *testing.T) {
	now := testNow
	var sent []sentMessage
	l := testLive(&now, &sent)
	station := StationRow{MachineID: "machine_001", Plant: "SIM", Line: "L01"}

	for i := 0; i < 5; i++ { // a browser polling every second
		if err := l.Watch(context.Background(), station); err != nil {
			t.Fatal(err)
		}
		now = now.Add(time.Second)
	}
	if len(sent) != 1 || sent[0].topic != "denso/SIM/L01/machine_001/watch" || sent[0].request.GetSeconds() != 15 {
		t.Fatalf("5 polls in 5 s sent %+v, want one request for 15 s", sent)
	}
	if err := l.Watch(context.Background(), station); err != nil || len(sent) != 2 {
		t.Errorf("after the rewatch period: %d requests, %v", len(sent), err)
	}
	// Another machine is asked on its own.
	_ = l.Watch(context.Background(), StationRow{MachineID: "machine_002", Plant: "SIM", Line: "L01"})
	if len(sent) != 3 || sent[2].topic != "denso/SIM/L01/machine_002/watch" {
		t.Errorf("second machine: %+v", sent)
	}
}

func TestWatchWithoutABrokerOrWithAFailingOne(t *testing.T) {
	now := testNow
	var sent []sentMessage
	l := testLive(&now, &sent)
	station := StationRow{MachineID: "machine_001", Plant: "SIM", Line: "L01"}

	fail := true
	l.publish = func(context.Context, string, []byte) error {
		if fail {
			return errors.New("timeout")
		}
		sent = append(sent, sentMessage{})
		return nil
	}
	if err := l.Watch(context.Background(), station); !errors.Is(err, errNoBroker) {
		t.Errorf("got %v, want errNoBroker", err)
	}
	// The failed request does not count: the very next poll tries again.
	fail = false
	if err := l.Watch(context.Background(), station); err != nil || len(sent) != 1 {
		t.Errorf("retry after a failure: %v, %d sent", err, len(sent))
	}
	l.publish = nil
	if err := l.Watch(context.Background(), station); !errors.Is(err, errNoBroker) {
		t.Errorf("disconnected: got %v, want errNoBroker", err)
	}
}

func TestLatestKeepsOnlyTheNewestFreshFramePerCamera(t *testing.T) {
	now := testNow
	var sent []sentMessage
	l := testLive(&now, &sent)

	l.OnPreview(previewPayload("machine_001", "", 1000))
	l.OnPreview(previewPayload("machine_001", "side", 1100))
	l.OnPreview(previewPayload("machine_001", "", 2000))
	l.OnPreview([]byte{0xff, 0x01}) // garbage is ignored
	if pv, ok := l.Latest("machine_001", ""); !ok || pv.GetFrameTsMs() != 2000 {
		t.Errorf("default camera: %v %v", pv, ok)
	}
	if pv, ok := l.Latest("machine_001", "side"); !ok || pv.GetFrameTsMs() != 1100 {
		t.Errorf("side camera: %v %v", pv, ok)
	}
	if _, ok := l.Latest("machine_002", ""); ok {
		t.Error("a machine nobody sent a frame for has one")
	}

	now = now.Add(11 * time.Second)
	if _, ok := l.Latest("machine_001", ""); ok {
		t.Error("a frame older than MaxAge is still served as live")
	}
	// The next frame that arrives sweeps the old ones out of memory.
	l.OnPreview(previewPayload("machine_002", "", 3000))
	if len(l.frames) != 1 {
		t.Errorf("%d frames kept in memory, want 1", len(l.frames))
	}
}

func TestLiveFrameRoute(t *testing.T) {
	now := testNow
	var sent []sentMessage
	live := testLive(&now, &sent)
	srv := newTestServerWithLive(t, newTestStore(), live)

	// Nothing yet: the edge is asked, the browser polls again.
	wantError(t, srv.URL+"/v1/stations/machine_001/live-frame", http.StatusNotFound, "no live frame yet")
	if len(sent) != 1 || sent[0].topic != "denso/SIM/L01/machine_001/watch" {
		t.Fatalf("watch requests: %+v", sent)
	}

	live.OnPreview(previewPayload("machine_001", "", 1_700_000_000_500))
	var got liveFrameView
	resp := get(t, srv.URL+"/v1/stations/machine_001/live-frame", &got)
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("got %d, Cache-Control %q", resp.StatusCode, resp.Header.Get("Cache-Control"))
	}
	if got.MachineID != "machine_001" || got.CameraID != "" || got.Width != 1920 || got.Height != 1080 ||
		got.FrameJPEG != base64.StdEncoding.EncodeToString([]byte("JPEG")) || !got.TS.Equal(time.UnixMilli(1_700_000_000_500)) {
		t.Errorf("frame: %+v", got)
	}
	if len(got.Readings) != 2 || got.Readings[0].GaugeID != "OIL_TEMP" || got.Readings[0].Value == nil || *got.Readings[0].Value != 122.5 ||
		got.Readings[1].Value != nil {
		t.Errorf("readings: %+v", got.Readings)
	}

	wantError(t, srv.URL+"/v1/stations/machine_001/live-frame?camera=side", http.StatusNotFound, "no live frame yet")
	wantError(t, srv.URL+"/v1/stations/unknown/live-frame", http.StatusNotFound, "station not found")

	live.publish = nil
	wantError(t, srv.URL+"/v1/stations/machine_001/live-frame", http.StatusServiceUnavailable, "mqtt broker unavailable")
}

func TestLiveFrameRouteWithoutLiveView(t *testing.T) {
	srv := newTestServer(t, newTestStore(), "")
	wantError(t, srv.URL+"/v1/stations/machine_001/live-frame", http.StatusServiceUnavailable, "live view is not configured")
}
