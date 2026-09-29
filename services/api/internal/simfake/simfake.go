// Package simfake là sim-service giả lập cho test Go.
package simfake

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"time"

	"github.com/kaizenflow/api/internal/simapi"
)

type Server struct {
	*httptest.Server
	mu          sync.Mutex
	requests    []simapi.RunRequest
	polls       map[int64]int
	ValidateErr *simapi.ContractError
	FailRuns    bool
	known       map[int64]bool
}

// Forget mô phỏng sim-service khởi động lại: run bị quên, GET trả 404.
func (s *Server) Forget(id int64) {
	s.mu.Lock()
	delete(s.known, id)
	s.mu.Unlock()
}

func New() *Server {
	s := &Server{polls: map[int64]int{}, known: map[int64]bool{}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /validate", s.validate)
	mux.HandleFunc("POST /runs", s.start)
	mux.HandleFunc("GET /runs/{id}", s.status)
	mux.HandleFunc("GET /runs/{id}/result", s.result)
	mux.HandleFunc("GET /runs/{id}/export.csv", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/csv")
		_, _ = w.Write([]byte("kind,time,rep,subject,name,value\n"))
	})
	s.Server = httptest.NewServer(mux)
	return s
}

func (s *Server) Requests() []simapi.RunRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]simapi.RunRequest(nil), s.requests...)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) validate(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	ce := s.ValidateErr
	s.mu.Unlock()
	if ce != nil {
		writeJSON(w, 422, map[string]any{"detail": ce})
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) start(w http.ResponseWriter, r *http.Request) {
	var req simapi.RunRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]string{"detail": err.Error()})
		return
	}
	s.mu.Lock()
	s.requests = append(s.requests, req)
	s.known[req.RunID] = true
	s.mu.Unlock()
	writeJSON(w, 202, map[string]any{"run_id": req.RunID, "status": "RUNNING"})
}

func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	s.mu.Lock()
	s.polls[id]++
	n, fail, known := s.polls[id], s.FailRuns, s.known[id]
	s.mu.Unlock()
	switch {
	case !known:
		writeJSON(w, 404, map[string]string{"detail": "run not found"})
	case fail:
		writeJSON(w, 200, simapi.Status{RunID: id, Status: "FAILED", Error: "boom"})
	case n < 2:
		writeJSON(w, 200, simapi.Status{RunID: id, Status: "RUNNING"})
	default:
		writeJSON(w, 200, simapi.Status{RunID: id, Status: "DONE"})
	}
}

func (s *Server) result(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	writeJSON(w, 200, Result(id))
}

// Result là kết quả mẫu: 2 band, RED_RISK + RECOMMENDATION, 5000 signal, 1 event.
func Result(id int64) simapi.Result {
	t0 := time.Date(2026, 10, 1, 1, 0, 0, 0, time.UTC)
	s, prob, sev := "S", 0.5, 3
	sigs := make([]simapi.Signal, 5000)
	for i := range sigs {
		sigs[i] = simapi.Signal{Time: t0.Add(time.Duration(i) * time.Second), RunID: id, Subject: "S", Name: "level:RAW-01", Value: float64(i % 7)}
	}
	return simapi.Result{
		RunID: id, EngineVersion: "0.1.0",
		KPIs: map[string]any{"throughput": map[string]any{"p50": 10.0}, "red_minutes": map[string]any{"p50": 3.0}},
		Bands: []simapi.Band{
			{IssuedAt: t0, TargetTime: t0, Producer: "SIM", RefID: id, Subject: "S", Metric: "coverage_h", P10: 1, P50: 2, P90: 3},
			{IssuedAt: t0, TargetTime: t0.Add(time.Minute), Producer: "SIM", RefID: id, Subject: "S", Metric: "coverage_h", P10: 0.5, P50: 1, P90: 2},
		},
		Insights: []simapi.Insight{
			{Kind: "RED_RISK", SubjectKey: &s, ETA: &t0, Probability: &prob, Severity: &sev, Payload: map[string]any{"red_s_mean": 60.0}},
			{Kind: "RECOMMENDATION", SubjectKey: &s, Severity: &sev, Payload: map[string]any{"candidates": []any{
				map[string]any{"rank": 1.0, "action": map[string]any{"type": "FLEET_SIZE", "target": "TUG", "cost": 3.0},
					"overrides":  []any{map[string]any{"target": "TUG", "path": "/count", "value": 3.0}},
					"injections": nil, "delta_kpi": map[string]any{"red_minutes": 2.0, "throughput": 1.0}, "score": 0.67},
			}}},
		},
		Signals: sigs,
		Events:  []simapi.Event{{Time: t0, RunID: id, Subject: "S", Type: "COLOR_CHANGE", Payload: map[string]any{"state": "RED"}}},
	}
}
