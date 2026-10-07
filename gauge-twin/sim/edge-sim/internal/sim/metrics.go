package sim

import (
	"sync/atomic"

	"github.com/prometheus/client_golang/prometheus"
)

// Metrics are the Prometheus metrics of the simulator.
type Metrics struct {
	Sent            *prometheus.CounterVec
	StatusSent      prometheus.Counter
	PublishErrors   prometheus.Counter
	ConnectErrors   prometheus.Counter
	Reconnects      prometheus.Counter
	Faults          *prometheus.CounterVec
	BufferMessages  prometheus.Gauge
	BufferDropped   prometheus.Counter
	ConnectedEdges  prometheus.Gauge
	PublishDuration prometheus.Histogram
}

// NewMetrics registers the metrics on reg.
func NewMetrics(reg prometheus.Registerer) *Metrics {
	m := &Metrics{
		Sent: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "edge_sim_messages_sent_total",
			Help: "Telemetry messages acknowledged by the broker, by kind (realtime or replay).",
		}, []string{"kind"}),
		StatusSent: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "edge_sim_status_sent_total",
			Help: "Status (heartbeat) messages acknowledged by the broker.",
		}),
		PublishErrors: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "edge_sim_publish_errors_total",
			Help: "Publishes that failed or were not acknowledged in time.",
		}),
		ConnectErrors: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "edge_sim_connect_errors_total",
			Help: "Failed connection attempts.",
		}),
		Reconnects: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "edge_sim_reconnects_total",
			Help: "Successful connections after the first one of an edge.",
		}),
		Faults: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "edge_sim_faults_injected_total",
			Help: "Injected faults, by kind.",
		}, []string{"fault"}),
		BufferMessages: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "edge_sim_buffer_messages",
			Help: "Messages waiting in the offline buffers of all edges.",
		}),
		BufferDropped: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "edge_sim_buffer_dropped_total",
			Help: "Messages dropped because an offline buffer was full.",
		}),
		ConnectedEdges: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "edge_sim_connected_edges",
			Help: "Edges currently connected to the broker.",
		}),
		PublishDuration: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "edge_sim_publish_duration_seconds",
			Help:    "Time from publish to PUBACK.",
			Buckets: prometheus.ExponentialBuckets(0.001, 2, 14),
		}),
	}
	reg.MustRegister(m.Sent, m.StatusSent, m.PublishErrors, m.ConnectErrors, m.Reconnects,
		m.Faults, m.BufferMessages, m.BufferDropped, m.ConnectedEdges, m.PublishDuration)
	return m
}

// Stats are run totals, reported in the final summary.
type Stats struct {
	Acked         atomic.Int64 // telemetry publishes acknowledged (duplicates included)
	Replayed      atomic.Int64
	Unacked       atomic.Int64 // messages still undelivered at shutdown
	Dropped       atomic.Int64 // messages dropped from a full buffer
	PublishErrors atomic.Int64
	ConnectErrors atomic.Int64
	Reconnects    atomic.Int64
	Faults        atomic.Int64
	Resent        atomic.Int64 // messages published again on a resend request
}

// Summary is a snapshot of Stats.
type Summary struct {
	Acked, Replayed, Unacked, Dropped, PublishErrors, ConnectErrors, Reconnects, Faults, Resent int64
}

func (s *Stats) Snapshot() Summary {
	return Summary{
		Acked: s.Acked.Load(), Replayed: s.Replayed.Load(), Unacked: s.Unacked.Load(),
		Dropped: s.Dropped.Load(), PublishErrors: s.PublishErrors.Load(),
		ConnectErrors: s.ConnectErrors.Load(), Reconnects: s.Reconnects.Load(), Faults: s.Faults.Load(),
		Resent: s.Resent.Load(),
	}
}
