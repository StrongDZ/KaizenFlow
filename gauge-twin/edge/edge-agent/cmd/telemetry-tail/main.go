// Command telemetry-tail subscribes to the telemetry and status topics and
// prints every message as one JSON line, the debug form of the protobuf
// payloads.
package main

import (
	"context"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/eclipse/paho.golang/paho"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

func main() {
	broker := flag.String("broker", "localhost:1883", "MQTT broker host:port")
	prefix := flag.String("prefix", "denso", "topic prefix")
	seconds := flag.Int("seconds", 0, "stop after this many seconds (0 = until interrupted)")
	flag.Parse()

	conn, err := net.DialTimeout("tcp", *broker, 5*time.Second)
	if err != nil {
		fmt.Fprintln(os.Stderr, "dial:", err)
		os.Exit(1)
	}
	marshal := protojson.MarshalOptions{UseProtoNames: true}
	clientID := fmt.Sprintf("telemetry-tail-%d", time.Now().UnixNano())
	client := paho.NewClient(paho.ClientConfig{
		ClientID: clientID,
		Conn:     conn,
		OnPublishReceived: []func(paho.PublishReceived) (bool, error){func(pr paho.PublishReceived) (bool, error) {
			var msg proto.Message = &gaugev1.Telemetry{}
			if strings.HasSuffix(pr.Packet.Topic, "/status") {
				msg = &gaugev1.Status{}
			}
			if len(pr.Packet.Payload) == 0 {
				return true, nil
			}
			if err := proto.Unmarshal(pr.Packet.Payload, msg); err != nil {
				fmt.Printf("{\"topic\":%q,\"error\":%q}\n", pr.Packet.Topic, err.Error())
				return true, nil
			}
			body, _ := marshal.Marshal(msg)
			fmt.Printf("{\"topic\":%q,\"message\":%s}\n", pr.Packet.Topic, body)
			return true, nil
		}},
	})
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if _, err := client.Connect(ctx, &paho.Connect{ClientID: clientID, KeepAlive: 30, CleanStart: true}); err != nil {
		fmt.Fprintln(os.Stderr, "connect:", err)
		os.Exit(1)
	}
	if _, err := client.Subscribe(ctx, &paho.Subscribe{Subscriptions: []paho.SubscribeOptions{
		{Topic: *prefix + "/+/+/+/telemetry", QoS: 1},
		{Topic: *prefix + "/+/+/+/status", QoS: 1},
	}}); err != nil {
		fmt.Fprintln(os.Stderr, "subscribe:", err)
		os.Exit(1)
	}
	if *seconds > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(*seconds)*time.Second)
		defer cancel()
	}
	select {
	case <-ctx.Done():
	case <-client.Done():
	}
	_ = client.Disconnect(&paho.Disconnect{})
}
