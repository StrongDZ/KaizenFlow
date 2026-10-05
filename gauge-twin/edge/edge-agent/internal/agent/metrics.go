package agent

import "github.com/prometheus/client_golang/prometheus"

// Metrics of edge-agent.
type Metrics struct {
	Frames         prometheus.Counter
	FramesDropped  *prometheus.CounterVec
	Sent           *prometheus.CounterVec
	PublishErrors  prometheus.Counter
	Reconnects     prometheus.Counter
	Connected      prometheus.Gauge
	BufferMessages prometheus.Gauge
	BufferBytes    prometheus.Gauge
	BufferDropped  prometheus.Counter
	PipelineStale  prometheus.Gauge
	Commands       *prometheus.CounterVec
	Resends        prometheus.Counter
	ConfigVersion  *prometheus.GaugeVec
}

func NewMetrics(reg prometheus.Registerer) *Metrics {
	m := &Metrics{
		Frames: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "edge_agent_frames_received_total", Help: "FrameResult messages received from the pipeline."}),
		FramesDropped: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "edge_agent_frames_dropped_total",
			Help: "Frames not used, by reason (undecodable, unknown_camera, no_config, late)."}, []string{"reason"}),
		Sent: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "edge_agent_telemetry_sent_total",
			Help: "Telemetry acknowledged by the broker, by kind (realtime, replay, resend)."}, []string{"kind"}),
		PublishErrors: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "edge_agent_publish_errors_total", Help: "Publishes that failed or timed out."}),
		Reconnects: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "edge_agent_reconnects_total", Help: "MQTT connections established after the first one."}),
		Connected: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "edge_agent_mqtt_connected", Help: "1 while connected to the broker."}),
		BufferMessages: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "edge_buffer_messages", Help: "Messages in the offline buffer not yet acknowledged by the broker."}),
		BufferBytes: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "edge_buffer_bytes", Help: "Bytes stored in the offline buffer, including messages kept for resend."}),
		BufferDropped: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "edge_agent_buffer_dropped_total",
			Help: "Unsent messages evicted because the buffer was full; this is data loss."}),
		PipelineStale: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "edge_agent_pipeline_stale_machines", Help: "Machines whose pipeline produced no frame for too long."}),
		Commands: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "edge_agent_pipeline_commands_total", Help: "Commands sent to the pipeline, by type and result."},
			[]string{"type", "result"}),
		Resends: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "edge_agent_resend_requests_total", Help: "Resend requests received from the server."}),
		ConfigVersion: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "edge_agent_config_version", Help: "Station config version in use, by machine."}, []string{"machine_id"}),
	}
	reg.MustRegister(m.Frames, m.FramesDropped, m.Sent, m.PublishErrors, m.Reconnects, m.Connected,
		m.BufferMessages, m.BufferBytes, m.BufferDropped, m.PipelineStale, m.Commands, m.Resends, m.ConfigVersion)
	return m
}
