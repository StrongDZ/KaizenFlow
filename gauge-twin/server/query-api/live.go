package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/eclipse/paho.golang/paho"
	"google.golang.org/protobuf/proto"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

// errNoBroker: the live view needs the MQTT connection, and there is none now.
var errNoBroker = errors.New("mqtt broker unavailable")

// LiveFrames is the server side of the live view: while somebody looks at a
// machine it keeps asking the edge for previews, and it holds the newest one
// per camera in memory. Nothing here is written anywhere: a frame replaces the
// previous one and is forgotten once it is older than MaxAge.
type LiveFrames struct {
	Prefix string
	// MaxAge: a frame older than this is not shown as live.
	MaxAge time.Duration
	// WatchSeconds is how long one request keeps the edge sending; Rewatch is
	// how often a machine that is still looked at is asked again.
	WatchSeconds uint32
	Rewatch      time.Duration
	Now          func() time.Time

	mu      sync.Mutex
	publish func(ctx context.Context, topic string, payload []byte) error // nil while disconnected
	frames  map[GaugeKey]liveFrame                                        // machine, camera_id
	asked   map[string]time.Time
}

type liveFrame struct {
	preview *gaugev1.Preview
	at      time.Time
}

func NewLiveFrames(prefix string) *LiveFrames {
	return &LiveFrames{Prefix: prefix, MaxAge: 10 * time.Second, WatchSeconds: 15, Rewatch: 5 * time.Second, Now: time.Now,
		frames: map[GaugeKey]liveFrame{}, asked: map[string]time.Time{}}
}

func (l *LiveFrames) topic(s StationRow, kind string) string {
	return strings.Join([]string{l.Prefix, s.Plant, s.Line, s.MachineID, kind}, "/")
}

// Watch tells the edge that the machine is being looked at. Calling it on
// every poll is fine: the edge is only asked again every Rewatch.
func (l *LiveFrames) Watch(ctx context.Context, s StationRow) error {
	l.mu.Lock()
	publish, now := l.publish, l.Now()
	due := now.Sub(l.asked[s.MachineID]) >= l.Rewatch
	if publish != nil && due {
		l.asked[s.MachineID] = now
	}
	l.mu.Unlock()
	if publish == nil {
		return errNoBroker
	}
	if !due {
		return nil
	}
	payload, _ := proto.Marshal(&gaugev1.PreviewRequest{Seconds: l.WatchSeconds})
	if err := publish(ctx, l.topic(s, "watch"), payload); err != nil {
		l.mu.Lock()
		delete(l.asked, s.MachineID) // ask again on the next poll
		l.mu.Unlock()
		return fmt.Errorf("%w: %v", errNoBroker, err)
	}
	return nil
}

// OnPreview stores a preview received from an edge, replacing the previous
// frame of that camera, and drops the frames nobody refreshed.
func (l *LiveFrames) OnPreview(payload []byte) {
	var pv gaugev1.Preview
	if err := proto.Unmarshal(payload, &pv); err != nil || pv.GetMachineId() == "" {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.Now()
	for key, f := range l.frames {
		if now.Sub(f.at) > l.MaxAge {
			delete(l.frames, key)
		}
	}
	l.frames[GaugeKey{pv.GetMachineId(), pv.GetCameraId()}] = liveFrame{preview: &pv, at: now}
}

// Latest returns the newest frame of a camera of a machine, if it is fresh.
func (l *LiveFrames) Latest(machine, camera string) (*gaugev1.Preview, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	f, ok := l.frames[GaugeKey{machine, camera}]
	if !ok || l.Now().Sub(f.at) > l.MaxAge {
		return nil, false
	}
	return f.preview, true
}

// Run keeps the MQTT connection: it subscribes to the previews of every
// machine and offers Watch a way to publish. It reconnects until ctx ends.
func (l *LiveFrames) Run(ctx context.Context, broker, clientID string, logger *slog.Logger) {
	for ctx.Err() == nil {
		if err := l.session(ctx, broker, clientID, logger); err != nil {
			logger.Warn("mqtt session for the live view ended", "error", err)
		}
		select {
		case <-ctx.Done():
		case <-time.After(3 * time.Second):
		}
	}
}

func (l *LiveFrames) session(ctx context.Context, broker, clientID string, logger *slog.Logger) error {
	connectCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var dialer net.Dialer
	conn, err := dialer.DialContext(connectCtx, "tcp", broker)
	if err != nil {
		return fmt.Errorf("dial %s: %w", broker, err)
	}
	defer conn.Close()

	clientErr := make(chan error, 1)
	report := func(err error) {
		select {
		case clientErr <- err:
		default:
		}
	}
	client := paho.NewClient(paho.ClientConfig{
		ClientID: clientID,
		Conn:     conn,
		OnPublishReceived: []func(paho.PublishReceived) (bool, error){
			func(pr paho.PublishReceived) (bool, error) {
				l.OnPreview(pr.Packet.Payload)
				return true, nil
			},
		},
		OnClientError: report,
		OnServerDisconnect: func(d *paho.Disconnect) {
			report(fmt.Errorf("server disconnected: reason code 0x%02x", d.ReasonCode))
		},
	})
	ack, err := client.Connect(connectCtx, &paho.Connect{ClientID: clientID, KeepAlive: 30, CleanStart: true})
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	if ack.ReasonCode != 0 {
		return fmt.Errorf("connect refused: reason code 0x%02x", ack.ReasonCode)
	}
	// QoS 0: a preview that does not arrive is replaced by the next one.
	if _, err := client.Subscribe(connectCtx, &paho.Subscribe{Subscriptions: []paho.SubscribeOptions{
		{Topic: l.Prefix + "/+/+/+/preview", QoS: 0},
	}}); err != nil {
		return fmt.Errorf("subscribe: %w", err)
	}

	l.mu.Lock()
	l.publish = func(ctx context.Context, topic string, payload []byte) error {
		ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		_, err := client.Publish(ctx, &paho.Publish{Topic: topic, QoS: 1, Payload: payload})
		return err
	}
	l.mu.Unlock()
	logger.Info("mqtt connected for the live view", "broker", broker)
	defer func() {
		l.mu.Lock()
		l.publish = nil
		l.mu.Unlock()
	}()

	select {
	case <-client.Done():
		return errors.New("connection closed")
	case err := <-clientErr:
		return err
	case <-ctx.Done():
		_ = client.Disconnect(&paho.Disconnect{ReasonCode: 0})
		return nil
	}
}
