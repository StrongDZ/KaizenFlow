// Command config-api stores station configs and publishes them to the edges
// as retained MQTT messages.
package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"gauge-twin/server/pkg/env"
	"gauge-twin/server/pkg/httpserver"
	"gauge-twin/server/pkg/logging"
	"gauge-twin/server/pkg/topics"
)

func main() {
	os.Exit(run())
}

func run() int {
	logger := logging.New("config-api")
	interval, err := env.Duration("PUBLISH_INTERVAL", 5*time.Second)
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		return 2
	}
	rules := DefaultAcceptanceRules()
	if rules.MinSamples, err = env.Int("ACCEPT_MIN_SAMPLES", rules.MinSamples); err == nil {
		// Largest error of a dial sample, in percent of full scale.
		var percent float64
		percent, err = strconv.ParseFloat(env.String("ACCEPT_DIAL_TOLERANCE_PERCENT", "2"), 64)
		rules.DialTolerance = percent / 100
	}
	if err != nil || rules.MinSamples < 1 || rules.DialTolerance <= 0 {
		logger.Error("invalid acceptance configuration", "error", err)
		return 2
	}
	hostname, _ := os.Hostname()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// No default: the database credentials come from the environment only.
	databaseURL := env.String("DATABASE_URL", "")
	if databaseURL == "" {
		logger.Error("invalid configuration", "error", "DATABASE_URL is required")
		return 2
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		logger.Error("database", "error", err)
		return 1
	}
	defer pool.Close()

	registry := httpserver.NewRegistry()
	store := NewPgStore(pool)
	broker := newMQTTBroker(env.String("MQTT_BROKER", "emqx:1883"), env.String("MQTT_CLIENT_ID", "config-api-"+hostname))
	prefix := env.String("MQTT_TOPIC_PREFIX", topics.DefaultPrefix)
	publisher := NewPublisher(store, broker, prefix, interval, registry, logger)
	api := NewAPI(store, broker, publisher, prefix, registry, logger)

	health := func() error {
		pingCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := store.Ping(pingCtx); err != nil {
			return errors.New("database: " + err.Error())
		}
		return nil
	}
	mux := http.NewServeMux()
	mux.Handle("/", httpserver.Handler(registry, health))
	api.Register(mux)
	commissioning := NewCommissioning(store, env.String("PREVIEW_URL", "http://preview-svc:8080"))
	commissioning.Register(mux)
	NewAcceptance(commissioning, NewDirSampleStore(env.String("ACCEPTANCE_DIR", "/acceptance")), rules).Register(mux)

	go publisher.Run(ctx)
	logger.Info("starting")
	if err := httpserver.Serve(ctx, env.String("HTTP_ADDR", ":8080"), mux, logger); err != nil {
		logger.Error("http server", "error", err)
		return 1
	}
	logger.Info("stopped")
	return 0
}
