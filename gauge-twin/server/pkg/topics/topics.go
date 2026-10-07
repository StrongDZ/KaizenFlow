// Package topics knows the MQTT topic layout of SPEC section 3.2 and the
// Kafka topics of section 5.
package topics

import "strings"

// MQTT message kinds, the last segment of denso/{plant}/{line}/{machine}/{kind}.
const (
	KindTelemetry = "telemetry"
	KindStatus    = "status"
	KindConfig    = "config"
	KindSample    = "sample"
)

// Kafka topics.
const (
	KafkaTelemetry = "gauge.telemetry"
	KafkaStatus    = "gauge.status"
	KafkaRejected  = "gauge.rejected"
	KafkaDLQ       = "gauge.dlq"
)

// DefaultPrefix is the first segment of every MQTT topic.
const DefaultPrefix = "denso"

// Topic is a parsed MQTT topic.
type Topic struct {
	Plant, Line, Machine, Kind string
}

// Parse splits prefix/{plant}/{line}/{machine}/{kind}. It reports false for
// any other shape, including empty or wildcard segments.
func Parse(prefix, topic string) (Topic, bool) {
	parts := strings.Split(topic, "/")
	if len(parts) != 5 || parts[0] != prefix {
		return Topic{}, false
	}
	for _, part := range parts[1:] {
		if part == "" || strings.ContainsAny(part, "+#") {
			return Topic{}, false
		}
	}
	return Topic{Plant: parts[1], Line: parts[2], Machine: parts[3], Kind: parts[4]}, true
}

// String renders the MQTT topic under the given prefix.
func (t Topic) String(prefix string) string {
	return strings.Join([]string{prefix, t.Plant, t.Line, t.Machine, t.Kind}, "/")
}

// SharedFilter is the shared-subscription filter receiving one kind of
// message from every machine: $share/{group}/{prefix}/+/+/+/{kind}.
func SharedFilter(group, prefix, kind string) string {
	return "$share/" + group + "/" + prefix + "/+/+/+/" + kind
}

// ResendTopic is where the server asks one edge to publish telemetry again:
// {prefix}/{plant}/edge/{edge_id}/cmd/resend. The edge answers on ResendTopic + "/ack".
func ResendTopic(prefix, plant, edgeID string) string {
	return strings.Join([]string{prefix, plant, "edge", edgeID, "cmd", "resend"}, "/")
}

// SharedResendAckFilter is the shared-subscription filter receiving the
// resend acknowledgements of every edge.
func SharedResendAckFilter(group, prefix string) string {
	return "$share/" + group + "/" + prefix + "/+/edge/+/cmd/resend/ack"
}
