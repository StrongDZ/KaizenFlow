// Command edge-agent turns the output of the video pipeline into gauge
// telemetry: it decodes and aggregates readings per window, buffers them in
// SQLite and publishes them over MQTT.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/pprof"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"gauge-twin/edge/edge-agent/internal/agent"
	"gauge-twin/edge/edge-agent/internal/store"
	"gauge-twin/edge/edge-agent/internal/zmqio"
	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

// Malformed numbers and durations are errors, not silent fallbacks.
func envDuration(name string, fallback time.Duration, errs *[]error) time.Duration {
	v := os.Getenv(name)
	if v == "" {
		return fallback
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		*errs = append(*errs, fmt.Errorf("%s: %q is not a duration", name, v))
	}
	return d
}

func envFloat(name string, fallback float64, errs *[]error) float64 {
	v := os.Getenv(name)
	if v == "" {
		return fallback
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		*errs = append(*errs, fmt.Errorf("%s: %q is not a number", name, v))
	}
	return f
}

func main() {
	os.Exit(run())
}

func run() int {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("service", "edge-agent")

	var errs []error
	cfg := agent.DefaultConfig()
	cfg.EdgeID = env("EDGE_ID", "")
	cfg.TopicPrefix = env("MQTT_TOPIC_PREFIX", cfg.TopicPrefix)
	cfg.ConfigDir = env("CONFIG_DIR", "/var/lib/edge-agent/config")
	machines, err := agent.ParseMachines(env("EDGE_MACHINES", ""))
	if err != nil {
		errs = append(errs, err)
	}
	cfg.Machines = machines
	// Without EDGE_MACHINES the edge reads the machines config-api assigns it,
	// starting from the last assignment it received.
	if len(machines) == 0 && cfg.EdgeID != "" {
		if cfg.Machines, err = agent.StoredAssignment(cfg.ConfigDir, cfg.EdgeID); err != nil {
			errs = append(errs, err)
		}
	}
	cfg.Heartbeat = envDuration("HEARTBEAT", cfg.Heartbeat, &errs)
	cfg.StaleAfter = envDuration("STALE_AFTER", cfg.StaleAfter, &errs)
	cfg.StartupGrace = envDuration("STARTUP_GRACE", cfg.StartupGrace, &errs)
	cfg.ReplayRate = envFloat("REPLAY_RATE", cfg.ReplayRate, &errs)
	cfg.Decode.MinConfidence = envFloat("DECODE_MIN_CONFIDENCE", cfg.Decode.MinConfidence, &errs)
	cfg.Decode.BlurBelow = envFloat("DECODE_BLUR_BELOW", cfg.Decode.BlurBelow, &errs)
	cfg.Decode.GlareAbove = envFloat("DECODE_GLARE_ABOVE", cfg.Decode.GlareAbove, &errs)
	cfg.Decode.GlareAboveLit = envFloat("DECODE_GLARE_ABOVE_LIT", cfg.Decode.GlareAboveLit, &errs)
	cfg.Decode.HourMeterSlack = envFloat("DECODE_HOURMETER_SLACK", cfg.Decode.HourMeterSlack, &errs)
	cfg.Decode.DialOvertravel = envFloat("DECODE_DIAL_OVERTRAVEL", cfg.Decode.DialOvertravel, &errs)
	bufferMax := envFloat("BUFFER_MAX_BYTES", 500<<20, &errs)
	retention := envDuration("BUFFER_RETENTION", 24*time.Hour, &errs)
	commandTimeout := envDuration("PIPELINE_COMMAND_TIMEOUT", 30*time.Second, &errs)
	if err := errors.Join(errs...); err != nil {
		logger.Error("invalid configuration", "error", err)
		return 2
	}
	if err := cfg.Validate(); err != nil {
		logger.Error("invalid configuration", "error", err)
		return 2
	}

	buffer, err := store.Open(env("BUFFER_PATH", "/var/lib/edge-agent/buffer.db"), int64(bufferMax), retention)
	if err != nil {
		logger.Error("open buffer", "error", err)
		return 1
	}
	defer buffer.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	registry := prometheus.NewRegistry()
	registry.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	metrics := agent.NewMetrics(registry)

	// Frames: a goroutine pulls from ZeroMQ and feeds the agent.
	receiver, err := zmqio.DialFrames(ctx, env("FRAMES_ENDPOINT", "ipc:///tmp/zmq/frames"))
	if err != nil {
		logger.Error("frames socket", "error", err)
		return 1
	}
	defer receiver.Close()
	frames := make(chan *gaugev1.FrameResult, 1024)
	go func() {
		var redials int64
		for {
			frame, err := receiver.Recv()
			if n := receiver.Redials.Load(); n != redials {
				redials = n
				logger.Warn("frames socket dialed again after a silence", "redials", n)
			}
			switch {
			case ctx.Err() != nil:
				return
			case errors.Is(err, zmqio.ErrBadFrame):
				metrics.FramesDropped.WithLabelValues("undecodable").Inc()
			case err != nil:
				logger.Warn("frames socket", "error", err)
				time.Sleep(time.Second)
			default:
				frames <- frame
			}
		}
	}()

	pipeline := zmqio.NewCommander(env("CONTROL_ENDPOINT", "ipc:///tmp/zmq/control"), commandTimeout)
	transport := agent.MQTTTransport{Broker: env("MQTT_BROKER", "emqx:1883"), KeepAlive: 30, Timeout: cfg.PublishTimeout}
	edge, err := agent.New(cfg, transport, pipeline, buffer, frames, metrics, logger)
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		return 2
	}

	mux := http.NewServeMux()
	mux.Handle("GET /metrics", promhttp.HandlerFor(registry, promhttp.HandlerOpts{}))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = fmt.Fprintln(w, "ok") })
	if env("PPROF", "false") == "true" {
		// Heap and CPU profiles for leak hunting; off unless asked for.
		mux.HandleFunc("GET /debug/pprof/", pprof.Index)
		mux.HandleFunc("GET /debug/pprof/profile", pprof.Profile)
		mux.HandleFunc("GET /debug/pprof/trace", pprof.Trace)
	}
	server := &http.Server{Addr: env("HTTP_ADDR", ":8080"), Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("http server", "error", err)
		}
	}()

	logger.Info("starting", "edge_id", cfg.EdgeID, "machines", len(cfg.Machines))
	edge.Run(ctx)

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = server.Shutdown(shutdownCtx)
	logger.Info("stopped")
	return 0
}
