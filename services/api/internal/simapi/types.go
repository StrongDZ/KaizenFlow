// Package simapi định nghĩa JSON trao đổi với sim-service (khớp contracts/run.schema.json).
package simapi

import "time"

type Material struct {
	Code string `json:"code"`
}

type Node struct {
	Key       string         `json:"key"`
	Archetype string         `json:"archetype"`
	Params    map[string]any `json:"params"`
}

type Pool struct {
	Key     string `json:"key"`
	Kind    string `json:"kind"`
	Count   int    `json:"count"`
	Service any    `json:"service,omitempty"`
}

type InitialState struct {
	Mode    string  `json:"mode"`
	WarmupS float64 `json:"warmup_s"`
}

type Outputs struct {
	RawReps []int   `json:"raw_reps"`
	SampleS float64 `json:"sample_s"`
}

type RunRequest struct {
	RunID        int64            `json:"run_id"`
	SimStart     time.Time        `json:"sim_start"`
	HorizonS     float64          `json:"horizon_s"`
	Replications int              `json:"replications"`
	Seed         int64            `json:"seed"`
	Materials    []Material       `json:"materials"`
	Nodes        []Node           `json:"nodes"`
	Pools        []Pool           `json:"pools"`
	Edges        []map[string]any `json:"edges"`
	InitialState InitialState     `json:"initial_state"`
	Injections   []map[string]any `json:"injections"`
	Outputs      Outputs          `json:"outputs"`
	Recommend    bool             `json:"recommend"`
}

type Band struct {
	IssuedAt   time.Time `json:"issued_at"`
	TargetTime time.Time `json:"target_time"`
	Producer   string    `json:"producer"`
	RefID      int64     `json:"ref_id"`
	Subject    string    `json:"subject"`
	Metric     string    `json:"metric"`
	P10        float64   `json:"p10"`
	P50        float64   `json:"p50"`
	P90        float64   `json:"p90"`
}

type Insight struct {
	Kind        string         `json:"kind"`
	SubjectKey  *string        `json:"subject_key"`
	ETA         *time.Time     `json:"eta"`
	Probability *float64       `json:"probability"`
	Severity    *int           `json:"severity"`
	Payload     map[string]any `json:"payload"`
}

type Signal struct {
	Time    time.Time `json:"time"`
	RunID   int64     `json:"run_id"`
	Rep     int       `json:"rep"`
	Subject string    `json:"subject"`
	Name    string    `json:"name"`
	Value   float64   `json:"value"`
}

type Event struct {
	Time    time.Time      `json:"time"`
	RunID   int64          `json:"run_id"`
	Rep     int            `json:"rep"`
	Subject string         `json:"subject"`
	Type    string         `json:"type"`
	Payload map[string]any `json:"payload"`
}

type Result struct {
	RunID         int64          `json:"run_id"`
	EngineVersion string         `json:"engine_version"`
	KPIs          map[string]any `json:"kpis"`
	Bands         []Band         `json:"bands"`
	Insights      []Insight      `json:"insights"`
	Signals       []Signal       `json:"signals"`
	Events        []Event        `json:"events"`
}

type Status struct {
	RunID  int64  `json:"run_id"`
	Status string `json:"status"`
	Error  string `json:"error"`
}

// ContractError là lỗi 422 của sim-service, gắn key node/edge.
type ContractError struct {
	Key     string `json:"key"`
	Message string `json:"message"`
}

func (e *ContractError) Error() string { return e.Key + ": " + e.Message }
