// Package httpapi là HTTP API cho frontend.
package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/kaizenflow/api/internal/runs"
	"github.com/kaizenflow/api/internal/simclient"
	"github.com/kaizenflow/api/internal/store"
	"github.com/kaizenflow/api/internal/validate"
	"github.com/kaizenflow/api/internal/ws"
)

type Deps struct {
	Store     *store.Store
	Sim       *simclient.Client
	Runs      *runs.Service
	Hub       *ws.Hub
	Validator *validate.Validator
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func New(d Deps) http.Handler {
	h := &handlers{d}
	r := chi.NewRouter()
	r.Use(cors)
	r.Get("/api/health", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, map[string]string{"status": "ok"}) })
	r.Get("/api/node-types", h.listNodeTypes)
	r.Post("/api/node-types", h.createNodeType)
	r.Get("/api/materials", h.listMaterials)
	r.Post("/api/materials", h.createMaterial)
	r.Get("/api/models", h.listModels)
	r.Post("/api/models", h.createModel)
	r.Get("/api/models/{key}/versions", h.listVersions)
	r.Get("/api/versions/{id}", h.getGraph)
	r.Put("/api/versions/{id}/graph", h.putGraph)
	r.Post("/api/versions/{id}/publish", h.publish)
	r.Post("/api/versions/{id}/clone", h.clone)
	r.Get("/api/versions/{id}/scenarios", h.listScenarios)
	r.Post("/api/scenarios", h.createScenario)
	r.Get("/api/scenarios/{id}", h.getScenario)
	r.Post("/api/scenarios/{id}/runs", h.startRun)
	r.Get("/api/scenarios/{id}/runs", h.listRuns)
	r.Get("/api/runs/{id}", h.getRun)
	r.Get("/api/runs/{id}/bands", h.bands)
	r.Get("/api/runs/{id}/events", h.events)
	r.Get("/api/runs/{id}/signals", h.signals)
	r.Get("/api/runs/{id}/export.csv", h.exportCSV)
	r.Post("/api/insights/{id}/apply", h.apply)
	r.Handle("/ws", d.Hub)
	return r
}
