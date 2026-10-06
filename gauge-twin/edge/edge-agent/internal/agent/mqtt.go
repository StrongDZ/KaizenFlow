package agent

import (
	"context"
	"fmt"
	"net"
	"time"

	"github.com/eclipse/paho.golang/paho"
)

// Will is the last-will message registered when connecting.
type Will struct {
	Topic   string
	Payload []byte
}

// Transport opens broker connections.
type Transport interface {
	// Connect opens a session. onMessage is called for every message received
	// on a subscribed topic, from a goroutine owned by the transport.
	Connect(ctx context.Context, clientID string, will Will, onMessage func(topic string, payload []byte)) (Session, error)
}

// Session is one live broker connection.
type Session interface {
	// Publish sends a QoS 1 message and returns once the broker acknowledged it.
	Publish(ctx context.Context, topic string, payload []byte, retain bool) error
	Subscribe(ctx context.Context, topics []string) error
	// Done is closed when the connection is lost.
	Done() <-chan struct{}
	// Close ends the session; a graceful close does not trigger the last will.
	Close(graceful bool)
}

const (
	reasonSuccess               = 0x00
	reasonNoMatchingSubscribers = 0x10
)

// MQTTTransport connects with MQTT v5 over plain TCP.
type MQTTTransport struct {
	Broker    string
	KeepAlive uint16
	Timeout   time.Duration
}

func (t MQTTTransport) Connect(ctx context.Context, clientID string, will Will, onMessage func(string, []byte)) (Session, error) {
	var dialer net.Dialer
	conn, err := dialer.DialContext(ctx, "tcp", t.Broker)
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", t.Broker, err)
	}
	client := paho.NewClient(paho.ClientConfig{
		ClientID:      clientID,
		Conn:          conn,
		PacketTimeout: t.Timeout,
		OnPublishReceived: []func(paho.PublishReceived) (bool, error){func(pr paho.PublishReceived) (bool, error) {
			onMessage(pr.Packet.Topic, pr.Packet.Payload)
			return true, nil
		}},
	})
	ack, err := client.Connect(ctx, &paho.Connect{
		ClientID:    clientID,
		KeepAlive:   t.KeepAlive,
		CleanStart:  true,
		WillMessage: &paho.WillMessage{Topic: will.Topic, Payload: will.Payload, QoS: 1, Retain: true},
	})
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("connect: %w", err)
	}
	if ack.ReasonCode != reasonSuccess {
		_ = conn.Close()
		return nil, fmt.Errorf("connect refused: reason code 0x%02x", ack.ReasonCode)
	}
	return &mqttSession{client: client, conn: conn}, nil
}

type mqttSession struct {
	client *paho.Client
	conn   net.Conn
}

func (s *mqttSession) Publish(ctx context.Context, topic string, payload []byte, retain bool) error {
	resp, err := s.client.Publish(ctx, &paho.Publish{Topic: topic, Payload: payload, QoS: 1, Retain: retain})
	if resp != nil && (resp.ReasonCode == reasonSuccess || resp.ReasonCode == reasonNoMatchingSubscribers) {
		return nil
	}
	if err != nil {
		return err
	}
	if resp == nil {
		return fmt.Errorf("publish: no acknowledgement")
	}
	return fmt.Errorf("publish rejected: reason code 0x%02x", resp.ReasonCode)
}

func (s *mqttSession) Subscribe(ctx context.Context, topics []string) error {
	subs := make([]paho.SubscribeOptions, len(topics))
	for i, topic := range topics {
		subs[i] = paho.SubscribeOptions{Topic: topic, QoS: 1}
	}
	_, err := s.client.Subscribe(ctx, &paho.Subscribe{Subscriptions: subs})
	return err
}

func (s *mqttSession) Done() <-chan struct{} { return s.client.Done() }

func (s *mqttSession) Close(graceful bool) {
	if graceful {
		_ = s.client.Disconnect(&paho.Disconnect{ReasonCode: reasonSuccess})
		return
	}
	_ = s.conn.Close()
}
