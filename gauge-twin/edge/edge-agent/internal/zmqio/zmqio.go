// Package zmqio is the ZeroMQ side of edge-agent: it pulls FrameResult
// messages from the video pipeline and sends it commands.
//
// The pipeline binds both sockets (PUSH for frames, REP for commands) and
// edge-agent connects, so either process can restart without the other.
package zmqio

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/go-zeromq/zmq4"
	"google.golang.org/protobuf/proto"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

// FrameReceiver pulls FrameResult messages.
type FrameReceiver struct {
	sock zmq4.Socket
}

// DialFrames connects a PULL socket to the pipeline's PUSH endpoint, e.g.
// ipc:///tmp/frames. The connection is retried in the background, so this
// succeeds even while the pipeline is not running yet.
func DialFrames(ctx context.Context, endpoint string) (*FrameReceiver, error) {
	sock := zmq4.NewPull(ctx, zmq4.WithDialerRetry(time.Second), zmq4.WithAutomaticReconnect(true))
	if err := sock.Dial(endpoint); err != nil {
		_ = sock.Close()
		return nil, fmt.Errorf("dial %s: %w", endpoint, err)
	}
	return &FrameReceiver{sock: sock}, nil
}

// Recv blocks until a frame arrives or the receiver's context is cancelled.
// A message that does not decode is returned as an error; the caller can
// count it and keep receiving.
func (r *FrameReceiver) Recv() (*gaugev1.FrameResult, error) {
	msg, err := r.sock.Recv()
	if err != nil {
		return nil, err
	}
	var frame gaugev1.FrameResult
	if err := proto.Unmarshal(msg.Bytes(), &frame); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadFrame, err)
	}
	return &frame, nil
}

func (r *FrameReceiver) Close() error { return r.sock.Close() }

// ErrBadFrame marks a message that is not a FrameResult.
var ErrBadFrame = errors.New("undecodable frame")

// Commander sends commands to the pipeline and waits for the reply.
type Commander struct {
	endpoint string
	timeout  time.Duration
	nextID   atomic.Uint64
}

func NewCommander(endpoint string, timeout time.Duration) *Commander {
	return &Commander{endpoint: endpoint, timeout: timeout}
}

// Do sends one command and returns the matching reply. It fails after the
// timeout when the pipeline is absent or hung. A fresh REQ socket is used per
// command: a REQ socket that missed its reply cannot be reused.
func (c *Commander) Do(ctx context.Context, cmd *gaugev1.Command) (*gaugev1.CommandReply, error) {
	cmd.CommandId = c.nextID.Add(1)
	payload, err := proto.Marshal(cmd)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	sock := zmq4.NewReq(ctx, zmq4.WithTimeout(c.timeout))
	defer sock.Close()
	if err := sock.Dial(c.endpoint); err != nil {
		return nil, fmt.Errorf("dial %s: %w", c.endpoint, err)
	}

	type result struct {
		reply *gaugev1.CommandReply
		err   error
	}
	done := make(chan result, 1)
	go func() {
		if err := sock.Send(zmq4.NewMsg(payload)); err != nil {
			done <- result{err: fmt.Errorf("send: %w", err)}
			return
		}
		msg, err := sock.Recv()
		if err != nil {
			done <- result{err: fmt.Errorf("receive: %w", err)}
			return
		}
		var reply gaugev1.CommandReply
		if err := proto.Unmarshal(msg.Bytes(), &reply); err != nil {
			done <- result{err: fmt.Errorf("decode reply: %w", err)}
			return
		}
		done <- result{reply: &reply}
	}()

	select {
	case res := <-done:
		if res.err != nil {
			return nil, res.err
		}
		if res.reply.GetCommandId() != cmd.GetCommandId() {
			return nil, fmt.Errorf("reply for command %d, expected %d", res.reply.GetCommandId(), cmd.GetCommandId())
		}
		return res.reply, nil
	case <-ctx.Done():
		return nil, fmt.Errorf("command %s: no reply within %v", cmd.GetType(), c.timeout)
	}
}
