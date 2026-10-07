//go:build interop

package zmqio

// Interoperability with libzmq: the peer is sim/ds-sim/tests/zmq_peer.py
// (pyzmq). Run with `make test-zmq-interop`.

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

func endpoints(t *testing.T) (frames, control string) {
	t.Helper()
	frames, control = os.Getenv("ZMQ_FRAMES_ENDPOINT"), os.Getenv("ZMQ_CONTROL_ENDPOINT")
	if frames == "" || control == "" {
		t.Skip("ZMQ_FRAMES_ENDPOINT / ZMQ_CONTROL_ENDPOINT are not set")
	}
	return frames, control
}

func TestInteropPullsFramesFromLibzmqPush(t *testing.T) {
	frames, _ := endpoints(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	receiver, err := DialFrames(ctx, frames)
	if err != nil {
		t.Fatal(err)
	}
	defer receiver.Close()

	var last int64 = -1
	for i := 0; i < 500; i++ {
		frame, err := receiver.Recv()
		if err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
		if frame.GetCameraId() != "machine_001" || len(frame.GetRois()) != 2 {
			t.Fatalf("unexpected frame: %v", frame)
		}
		roi := frame.GetRois()[1]
		if len(roi.GetSlotProbs()) != 4 || len(roi.GetSlotProbs()[0].GetProbs()) != 12 || !roi.GetRoiDrift() {
			t.Fatalf("unexpected roi: %v", roi)
		}
		if last >= 0 && frame.GetFrameTsMs() != last+100 {
			t.Fatalf("frame %d: ts %d after %d (lost or reordered)", i, frame.GetFrameTsMs(), last)
		}
		last = frame.GetFrameTsMs()
	}
}

func TestInteropCommandsGetRepliesFromLibzmqRep(t *testing.T) {
	_, control := endpoints(t)
	commander := NewCommander(control, 5*time.Second)
	for i, version := range []uint32{7, 8, 9} {
		reply, err := commander.Do(context.Background(), &gaugev1.Command{
			Type: gaugev1.CommandType_COMMAND_TYPE_RELOAD_CONFIG, ConfigVersion: version, MachineId: "machine_001",
		})
		if err != nil {
			t.Fatalf("command %d: %v", i, err)
		}
		// The peer accepts even versions and rejects odd ones.
		if reply.GetOk() != (version%2 == 0) || (!reply.GetOk() && !strings.Contains(reply.GetError(), "odd")) {
			t.Errorf("version %d: reply %v", version, reply)
		}
	}
}

func TestInteropCommandTimesOutWithoutPeer(t *testing.T) {
	endpoints(t)
	commander := NewCommander("ipc:///tmp/zmq/nobody-listens", 500*time.Millisecond)
	started := time.Now()
	_, err := commander.Do(context.Background(), &gaugev1.Command{Type: gaugev1.CommandType_COMMAND_TYPE_RESTART})
	if err == nil {
		t.Fatal("expected an error without a peer")
	}
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Errorf("took %v to give up", elapsed)
	}
}
