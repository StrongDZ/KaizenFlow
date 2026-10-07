// Command edge-sim simulates a fleet of edge agents publishing gauge
// telemetry over MQTT, for load and fault testing of the server.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"gauge-twin/sim/edge-sim/internal/sim"
)

// Every flag defaults to the EDGE_SIM_<NAME> environment variable when set.
func envString(name, fallback string) string {
	if v, ok := os.LookupEnv("EDGE_SIM_" + name); ok {
		return v
	}
	return fallback
}

func envInt(name string, fallback int) int {
	if v, err := strconv.Atoi(envString(name, "")); err == nil {
		return v
	}
	return fallback
}

func envFloat(name string, fallback float64) float64 {
	if v, err := strconv.ParseFloat(envString(name, ""), 64); err == nil {
		return v
	}
	return fallback
}

func envDuration(name string, fallback time.Duration) time.Duration {
	if v, err := time.ParseDuration(envString(name, "")); err == nil {
		return v
	}
	return fallback
}

func main() {
	os.Exit(run())
}

func run() int {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("service", "edge-sim")
	def := sim.DefaultConfig()
	cfg := def

	flag.IntVar(&cfg.Machines, "machines", envInt("MACHINES", def.Machines), "number of simulated machines")
	flag.IntVar(&cfg.MachinesPerEdge, "machines-per-edge", envInt("MACHINES_PER_EDGE", def.MachinesPerEdge),
		"machines sharing one edge, i.e. one MQTT connection")
	window := flag.Float64("window", envFloat("WINDOW", def.Window.Seconds()),
		"window length in seconds; each machine sends one message per window")
	broker := flag.String("broker", envString("BROKER", "localhost:1883"), "MQTT broker host:port")
	flag.DurationVar(&cfg.Duration, "duration", envDuration("DURATION", 0), "run time, e.g. 10m (0 = until interrupted)")
	faults := flag.String("faults", envString("FAULTS", ""),
		"comma-separated faults: out_of_range, bad_schema, duplicate, clock_skew, disconnect, "+
			"gap (skip a sequence number but keep the message for resend: a loss after the PUBACK)")
	flag.Float64Var(&cfg.FaultRate, "fault-rate", envFloat("FAULT_RATE", def.FaultRate),
		"share of messages carrying a per-message fault (0..1)")
	flag.DurationVar(&cfg.DisconnectEvery, "disconnect-every", envDuration("DISCONNECT_EVERY", def.DisconnectEvery),
		"mean time between network cuts of an edge (fault disconnect)")
	flag.DurationVar(&cfg.DisconnectFor, "disconnect-for", envDuration("DISCONNECT_FOR", def.DisconnectFor),
		"length of each network cut (fault disconnect)")
	flag.IntVar(&cfg.BufferMax, "buffer-max", envInt("BUFFER_MAX", def.BufferMax), "offline buffer size per edge, in messages")
	flag.Float64Var(&cfg.ReplayRate, "replay-rate", envFloat("REPLAY_RATE", def.ReplayRate),
		"replayed messages per second per edge")
	flag.DurationVar(&cfg.Heartbeat, "heartbeat", envDuration("HEARTBEAT", def.Heartbeat), "status interval")
	flag.DurationVar(&cfg.Ramp, "ramp", envDuration("RAMP", def.Ramp), "period over which the edges first connect")
	flag.StringVar(&cfg.Plant, "plant", envString("PLANT", def.Plant), "plant segment of the topics")
	flag.Int64Var(&cfg.Seed, "seed", int64(envInt("SEED", int(def.Seed))), "random seed")
	seqLogPath := flag.String("seq-log", envString("SEQ_LOG", "edge-sim-seq.jsonl"),
		"file receiving one JSON line per acknowledged message (empty = disabled)")
	httpAddr := flag.String("http", envString("HTTP", ":9100"), "listen address of /metrics and /healthz")
	emitConfigs := flag.String("emit-configs", "", "write the station config of every machine as <dir>/<machine_id>.json and exit")
	flag.IntVar(&cfg.Offset, "offset", envInt("OFFSET", 0), "index of the first machine; lets several instances simulate disjoint parts of a fleet")
	flag.BoolVar(&cfg.Resend, "resend", envString("RESEND", "") == "true", "answer cmd/resend requests from the server")
	flag.IntVar(&cfg.ResendKeep, "resend-keep", envInt("RESEND_KEEP", def.ResendKeep), "messages each edge keeps for resend requests")
	flag.DurationVar(&cfg.Linger, "linger", envDuration("LINGER", 0),
		"stay connected this long after --duration without producing, to answer late resend requests")
	flag.Parse()

	cfg.Window = time.Duration(*window * float64(time.Second))
	var err error
	if cfg.Faults, err = sim.ParseFaults(*faults); err == nil {
		err = cfg.Validate()
	}
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		return 2
	}

	if *emitConfigs != "" {
		if err := os.MkdirAll(*emitConfigs, 0o755); err != nil {
			logger.Error("emit configs", "error", err)
			return 1
		}
		for i := cfg.Offset; i < cfg.Offset+cfg.Machines; i++ {
			path := filepath.Join(*emitConfigs, sim.MachineID(i)+".json")
			if err := os.WriteFile(path, sim.StationConfigJSON(cfg, i), 0o644); err != nil {
				logger.Error("emit configs", "error", err)
				return 1
			}
		}
		logger.Info("station configs written", "machines", cfg.Machines, "dir", *emitConfigs)
		return 0
	}

	var seqFile *os.File
	if *seqLogPath != "" {
		if seqFile, err = os.Create(*seqLogPath); err != nil {
			logger.Error("open sequence log", "error", err)
			return 1
		}
		defer seqFile.Close()
	}
	var seqlog *sim.SeqLog
	if seqFile != nil {
		seqlog = sim.NewSeqLog(seqFile)
	} else {
		seqlog = sim.NewSeqLog(nil)
	}

	registry := prometheus.NewRegistry()
	registry.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	metrics := sim.NewMetrics(registry)

	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.HandlerFor(registry, promhttp.HandlerOpts{}))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprintln(w, "ok")
	})
	server := &http.Server{Addr: *httpAddr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("http server", "error", err)
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	transport := sim.MQTTTransport{Broker: *broker, KeepAlive: 30, Timeout: cfg.PublishTimeout}
	summary, err := sim.Run(ctx, cfg, transport, seqlog, metrics, logger)

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = server.Shutdown(shutdownCtx)

	if err != nil {
		logger.Error("simulation failed", "error", err)
		return 1
	}
	// Undelivered or dropped messages mean data was lost on the way to the broker.
	if summary.Unacked > 0 || summary.Dropped > 0 {
		return 3
	}
	return 0
}
