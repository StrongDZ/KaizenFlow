package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"google.golang.org/protobuf/encoding/protojson"
)

const maxBodyBytes = 1 << 20

// API is the REST interface for station configs.
type API struct {
	store     Store
	broker    Broker
	publisher *Publisher
	prefix    string
	logger    *slog.Logger
	requests  *prometheus.CounterVec
}

func NewAPI(store Store, broker Broker, publisher *Publisher, prefix string, reg prometheus.Registerer, logger *slog.Logger) *API {
	a := &API{store: store, broker: broker, publisher: publisher, prefix: prefix, logger: logger,
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "config_api_requests_total", Help: "REST requests, by method and status code."}, []string{"method", "code"})}
	reg.MustRegister(a.requests)
	return a
}

// Register adds the routes to mux.
func (a *API) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/stations", a.wrap(a.list))
	mux.HandleFunc("GET /v1/stations/{machine_id}", a.wrap(a.get))
	mux.HandleFunc("PUT /v1/stations/{machine_id}", a.wrap(a.put))
	mux.HandleFunc("DELETE /v1/stations/{machine_id}", a.wrap(a.delete))
}

type apiError struct {
	Error   string   `json:"error"`
	Details []string `json:"details,omitempty"`
}

func (a *API) wrap(handler func(http.ResponseWriter, *http.Request) int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		code := handler(w, r)
		a.requests.WithLabelValues(r.Method, strconv.Itoa(code)).Inc()
	}
}

func writeJSON(w http.ResponseWriter, code int, body any) int {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
	return code
}

func (a *API) fail(w http.ResponseWriter, err error) int {
	if errors.Is(err, ErrNotFound) {
		return writeJSON(w, http.StatusNotFound, apiError{Error: "station not found"})
	}
	a.logger.Error("request failed", "error", err)
	return writeJSON(w, http.StatusInternalServerError, apiError{Error: "internal error"})
}

type stationView struct {
	MachineID        string          `json:"machine_id"`
	ConfigVersion    uint32          `json:"config_version"`
	PublishedVersion uint32          `json:"published_version"`
	UpdatedAt        time.Time       `json:"updated_at"`
	Config           json.RawMessage `json:"config"`
}

func view(s Stored) stationView {
	return stationView{s.MachineID, s.ConfigVersion, s.PublishedVersion, s.UpdatedAt.UTC(), s.Config}
}

// list returns every station with its full config; ingest caches this.
func (a *API) list(w http.ResponseWriter, r *http.Request) int {
	stored, err := a.store.List(r.Context())
	if err != nil {
		return a.fail(w, err)
	}
	out := make([]stationView, len(stored))
	for i, s := range stored {
		out[i] = view(s)
	}
	return writeJSON(w, http.StatusOK, map[string]any{"stations": out})
}

func (a *API) get(w http.ResponseWriter, r *http.Request) int {
	stored, err := a.store.Get(r.Context(), r.PathValue("machine_id"))
	if err != nil {
		return a.fail(w, err)
	}
	return writeJSON(w, http.StatusOK, view(stored))
}

// put validates and stores a config. The server assigns config_version; a
// version sent by the client is ignored. Publishing to MQTT happens right
// after, and is retried in the background if the broker is unavailable.
func (a *API) put(w http.ResponseWriter, r *http.Request) int {
	machineID := r.PathValue("machine_id")
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err != nil {
		return writeJSON(w, http.StatusRequestEntityTooLarge, apiError{Error: "body too large"})
	}
	cfg, err := ParseConfig(body)
	if err != nil {
		return writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
	}
	if cfg.GetMachineId() == "" {
		cfg.MachineId = machineID
	}
	if cfg.GetMachineId() != machineID {
		return writeJSON(w, http.StatusBadRequest, apiError{Error: "machine_id in the body does not match the URL"})
	}
	if problems := Validate(cfg); len(problems) > 0 {
		return writeJSON(w, http.StatusBadRequest, apiError{Error: "invalid station config", Details: problems})
	}
	cfg.ConfigVersion = 0
	canonical, err := protojson.MarshalOptions{UseProtoNames: true}.Marshal(cfg)
	if err != nil {
		return a.fail(w, err)
	}
	stored, err := a.store.Put(r.Context(), machineID, cfg.GetPlant(), cfg.GetLine(), canonical)
	if err != nil {
		return a.fail(w, err)
	}
	a.publisher.Wake()
	a.logger.Info("config stored", "machine_id", machineID, "config_version", stored.ConfigVersion)
	return writeJSON(w, http.StatusOK, view(stored))
}

// delete clears the retained config on MQTT first and only then removes the
// row, so a broker outage cannot leave a config that exists nowhere but on
// the broker.
func (a *API) delete(w http.ResponseWriter, r *http.Request) int {
	stored, err := a.store.Get(r.Context(), r.PathValue("machine_id"))
	if err != nil {
		return a.fail(w, err)
	}
	topic, err := configTopic(a.prefix, stored.Config)
	if err != nil {
		return a.fail(w, err)
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	if err := a.broker.PublishRetained(ctx, topic, nil); err != nil {
		a.logger.Warn("could not clear retained config", "machine_id", stored.MachineID, "error", err)
		return writeJSON(w, http.StatusServiceUnavailable, apiError{Error: "MQTT broker unavailable; nothing was deleted"})
	}
	if err := a.store.Delete(r.Context(), stored.MachineID); err != nil {
		return a.fail(w, err)
	}
	w.WriteHeader(http.StatusNoContent)
	return http.StatusNoContent
}
