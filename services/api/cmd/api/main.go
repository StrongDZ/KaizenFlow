// Command api chạy KaizenFlow HTTP API.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/kaizenflow/api/internal/catalog"
	"github.com/kaizenflow/api/internal/db"
	"github.com/kaizenflow/api/internal/fmcg"
	"github.com/kaizenflow/api/internal/httpapi"
	"github.com/kaizenflow/api/internal/livesvc"
	"github.com/kaizenflow/api/internal/runs"
	"github.com/kaizenflow/api/internal/simclient"
	"github.com/kaizenflow/api/internal/store"
	"github.com/kaizenflow/api/internal/validate"
	"github.com/kaizenflow/api/internal/ws"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func defaultFMCGProvider() string {
	if v := os.Getenv("KF_FMCG_FORECAST_PROVIDER"); v != "" {
		return v
	}
	if _, err := fmcg.ProviderByName(fmcg.ProviderProjectM); err == nil {
		if root := os.Getenv("KF_PROJECT_M_ROOT"); root != "" {
			if _, err := os.Stat(root); err == nil {
				return fmcg.ProviderProjectM
			}
		}
		if home, err := os.UserHomeDir(); err == nil {
			if _, err := os.Stat(home + "/Desktop/M"); err == nil {
				return fmcg.ProviderProjectM
			}
		}
	}
	return fmcg.ProviderHybridRuntime
}

func main() {
	ctx := context.Background()
	pool, err := db.Connect(ctx, env("KF_DB_URL", "postgres://postgres:kaizen@localhost:5433/kaizenflow?sslmode=disable"))
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()
	if err := db.Migrate(pool); err != nil {
		log.Fatalf("migrate: %v", err)
	}
	if err := catalog.Seed(ctx, pool); err != nil {
		log.Fatalf("seed: %v", err)
	}
	st := store.New(pool)
	sim := simclient.New(env("KF_SIM_URL", "http://localhost:8081"))
	hub := ws.NewHub()
	svc := &runs.Service{Store: st, Sim: sim, Hub: hub, Poll: time.Second}
	if err := svc.Recover(ctx); err != nil {
		log.Printf("recover runs: %v", err)
	}
	liveSvc := livesvc.New(st, hub)
	if err := liveSvc.ReloadBindings(ctx); err != nil {
		log.Fatalf("load bindings: %v", err)
	}
	go liveSvc.Run(ctx)
	go livesvc.NewMonitor(st, liveSvc, hub).Run(ctx)
	fmcgProvider, err := fmcg.ProviderByName(defaultFMCGProvider())
	if err != nil {
		log.Fatalf("load FMCG forecast provider: %v (available: %v)", err, fmcg.RegisteredProviderNames())
	}
	h := httpapi.New(httpapi.Deps{Store: st, Sim: sim, Hub: hub, Validator: validate.New(), Runs: svc,
		Live: liveSvc, FeedURL: env("KF_FEED_URL", "http://localhost:8090"), FMCGNowcast: fmcgProvider})
	addr := env("KF_ADDR", ":8080")
	log.Printf("KaizenFlow API listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, h))
}
