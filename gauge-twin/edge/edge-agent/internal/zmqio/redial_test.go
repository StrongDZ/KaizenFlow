package zmqio

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-zeromq/zmq4"
	"google.golang.org/protobuf/proto"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

// push binds a PUSH socket like the pipeline does.
func push(t *testing.T, endpoint string) zmq4.Socket {
	t.Helper()
	sock := zmq4.NewPush(context.Background())
	if err := sock.Listen(endpoint); err != nil {
		t.Fatal(err)
	}
	return sock
}

// sendFrame is called from goroutines: a failed send shows up as a missing frame.
func sendFrame(sock zmq4.Socket, seq int64) {
	raw, _ := proto.Marshal(&gaugev1.FrameResult{FrameTsMs: seq})
	_ = sock.Send(zmq4.NewMsg(raw))
}

func recvWithin(t *testing.T, r *FrameReceiver, d time.Duration) *gaugev1.FrameResult {
	t.Helper()
	got := make(chan *gaugev1.FrameResult, 1)
	go func() {
		if f, err := r.Recv(); err == nil {
			got <- f
		}
	}()
	select {
	case f := <-got:
		return f
	case <-time.After(d):
		t.Fatalf("no frame within %s", d)
		return nil
	}
}

// A pipeline that goes away and comes back on the same endpoint is read again,
// whether or not the library noticed: the receiver dials again after a silence.
func TestFrameReceiverDialsAgainAfterASilence(t *testing.T) {
	endpoint := "ipc://" + filepath.Join(t.TempDir(), "frames")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	first := push(t, endpoint)
	r, err := dialFrames(ctx, endpoint, 300*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	go sendFrame(first, 1)
	if f := recvWithin(t, r, 5*time.Second); f.GetFrameTsMs() != 1 {
		t.Fatalf("first frame: %v", f)
	}
	_ = first.Close()

	second := push(t, endpoint)
	defer second.Close()
	deadline := time.Now().Add(10 * time.Second)
	for r.Redials.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if r.Redials.Load() == 0 {
		t.Fatal("the receiver never dialed again")
	}
	go func() {
		// The new socket needs a moment to connect.
		for i := int64(2); i < 40; i++ {
			sendFrame(second, i)
			time.Sleep(100 * time.Millisecond)
		}
	}()
	if f := recvWithin(t, r, 8*time.Second); f.GetFrameTsMs() < 2 {
		t.Errorf("frame after the restart: %v", f)
	}
}

func TestFrameReceiverStopsWithItsContext(t *testing.T) {
	endpoint := "ipc://" + filepath.Join(t.TempDir(), "frames")
	defer push(t, endpoint).Close()
	ctx, cancel := context.WithCancel(context.Background())
	r, err := dialFrames(ctx, endpoint, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	if _, err := r.Recv(); err == nil {
		t.Error("Recv after cancel: want an error")
	}
}
