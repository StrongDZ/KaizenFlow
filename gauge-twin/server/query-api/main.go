// Command query-api is the read API of the live monitoring UI: the stations
// with their latest readings, the trend of a gauge and one camera frame.
package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/signal"
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
	logger := logging.New("query-api")
	// A gauge without a reading for this long is shown as stale; the default
	// is the FLAG_STALE threshold of the edge.
	staleAfter, err := env.Duration("STALE_AFTER", 30*time.Second)
	var lookback time.Duration
	if err == nil {
		// How far back the latest reading of a gauge is searched.
		lookback, err = env.Duration("LATEST_LOOKBACK", 10*time.Minute)
	}
	if err != nil || staleAfter <= 0 || lookback < staleAfter {
		logger.Error("invalid configuration", "error", err, "stale_after", staleAfter, "latest_lookback", lookback)
		return 2
	}

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
	api := NewAPI(store, env.String("PREVIEW_URL", "http://preview-svc:8080"), env.String("CORS_ALLOWED_ORIGIN", "*"),
		staleAfter, lookback, time.Now, registry, logger)

	// The live view needs MQTT: it asks the edges for previews and receives
	// them. Without a broker the rest of the API works as before.
	if broker := env.String("MQTT_BROKER", ""); broker != "" {
		hostname, _ := os.Hostname()
		api.live = NewLiveFrames(env.String("MQTT_TOPIC_PREFIX", topics.DefaultPrefix))
		go api.live.Run(ctx, broker, env.String("MQTT_CLIENT_ID", "query-api-"+hostname), logger)
	}

	// Thumbnails: a frame of every camera, refreshed in the background.
	if every, err := env.Duration("STILL_REFRESH", 5*time.Minute); err != nil || every < 0 {
		logger.Error("invalid configuration", "error", err, "still_refresh", every)
		return 2
	} else if every > 0 {
		go api.WarmStills(ctx, every)
	}

	// Alerts: problems that last are raised, and posted to ALERT_WEBHOOK_URL when set.
	alerter := NewAlerter(api, env.String("ALERT_WEBHOOK_URL", ""), registry)
	alertEvery, err := env.Duration("ALERT_EVERY", 15*time.Second)
	if err == nil {
		alerter.After, err = env.Duration("ALERT_AFTER", time.Minute)
	}
	if err == nil {
		alerter.Unreadable, err = env.Duration("ALERT_UNREADABLE_AFTER", 10*time.Minute)
	}
	if err != nil || alertEvery <= 0 || alerter.After < 0 || alerter.Unreadable < 0 {
		logger.Error("invalid alert configuration", "error", err)
		return 2
	}
	api.alerts = alerter
	go alerter.Run(ctx, alertEvery)

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

	logger.Info("starting")
	if err := httpserver.Serve(ctx, env.String("HTTP_ADDR", ":8080"), mux, logger); err != nil {
		logger.Error("http server", "error", err)
		return 1
	}
	logger.Info("stopped")
	return 0
}
