package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/encoding/protojson"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

// Edge assignment: config-api keeps which machines every edge reads and
// publishes the list retained on denso/edges/{edge_id}/assignment. The edge
// follows it (edge-agent without EDGE_MACHINES), so a machine is added or
// moved from here, not on the edge. A new machine whose gauges are on a
// camera an edge already reads goes to that edge by itself.

// EdgeNode is an edge as it reported itself (table edge_node, kept by state).
type EdgeNode struct {
	EdgeID   string     `json:"edge_id"`
	Status   string     `json:"status"`
	LastSeen *time.Time `json:"last_seen"`
}

// EdgeStore persists the assignments.
type EdgeStore interface {
	Assignments(ctx context.Context) (map[string][]string, error)
	// SetAssignments replaces the machine lists of the given edges together.
	SetAssignments(ctx context.Context, lists map[string][]string) error
	Nodes(ctx context.Context) ([]EdgeNode, error)
}

// PgEdgeStore is the PostgreSQL implementation.
type PgEdgeStore struct{ pool *pgxpool.Pool }

func NewPgEdgeStore(pool *pgxpool.Pool) *PgEdgeStore { return &PgEdgeStore{pool: pool} }

func (p *PgEdgeStore) Assignments(ctx context.Context) (map[string][]string, error) {
	rows, err := p.pool.Query(ctx, `SELECT edge_id, machine_ids FROM edge_assignment ORDER BY edge_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]string{}
	for rows.Next() {
		var edge string
		var machines []string
		if err := rows.Scan(&edge, &machines); err != nil {
			return nil, err
		}
		out[edge] = machines
	}
	return out, rows.Err()
}

func (p *PgEdgeStore) SetAssignments(ctx context.Context, lists map[string][]string) error {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for edge, machines := range lists {
		if machines == nil {
			machines = []string{}
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO edge_assignment (edge_id, machine_ids) VALUES ($1, $2)
			ON CONFLICT (edge_id) DO UPDATE SET machine_ids = EXCLUDED.machine_ids, updated_at = now()`, edge, machines); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (p *PgEdgeStore) Nodes(ctx context.Context) ([]EdgeNode, error) {
	rows, err := p.pool.Query(ctx, `SELECT edge_id, status, last_seen FROM edge_node ORDER BY edge_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []EdgeNode
	for rows.Next() {
		var n EdgeNode
		if err := rows.Scan(&n.EdgeID, &n.Status, &n.LastSeen); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// Edges is the REST interface of the assignments.
type Edges struct {
	store    EdgeStore
	stations Store
	broker   Broker
	prefix   string
	api      *API
}

func NewEdges(store EdgeStore, stations Store, broker Broker, prefix string, api *API) *Edges {
	return &Edges{store: store, stations: stations, broker: broker, prefix: prefix, api: api}
}

func (e *Edges) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/edges", e.api.wrap(e.list))
	mux.HandleFunc("PUT /v1/edges/{edge_id}", e.api.wrap(e.put))
}

func (e *Edges) assignmentTopic(edge string) string {
	return e.prefix + "/edges/" + edge + "/assignment"
}

// configs maps machine_id -> its parsed station config.
func (e *Edges) configs(ctx context.Context) (map[string]*gaugev1.StationConfig, error) {
	stations, err := e.stations.List(ctx)
	if err != nil {
		return nil, err
	}
	out := map[string]*gaugev1.StationConfig{}
	for _, s := range stations {
		if cfg, err := ParseConfig(s.Config); err == nil {
			out[s.MachineID] = cfg
		}
	}
	return out, nil
}

// publish sends the assignment of one edge; machines without a config are
// left out, as the edge could not find their topics.
func (e *Edges) publish(ctx context.Context, edge string, machines []string, configs map[string]*gaugev1.StationConfig) error {
	as := &gaugev1.EdgeAssignment{EdgeId: edge}
	for _, id := range machines {
		if cfg, ok := configs[id]; ok {
			as.Machines = append(as.Machines, &gaugev1.MachineRef{Plant: cfg.GetPlant(), Line: cfg.GetLine(), MachineId: id})
		}
	}
	payload, err := protojson.MarshalOptions{UseProtoNames: true, EmitUnpopulated: true}.Marshal(as)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	return e.broker.PublishRetained(ctx, e.assignmentTopic(edge), payload)
}

// PublishAll publishes every assignment again (Publisher.Republish calls it).
func (e *Edges) PublishAll(ctx context.Context) {
	lists, err := e.store.Assignments(ctx)
	if err != nil {
		e.api.logger.Error("list assignments", "error", err)
		return
	}
	configs, err := e.configs(ctx)
	if err != nil {
		e.api.logger.Error("list configs for assignments", "error", err)
		return
	}
	for edge, machines := range lists {
		if err := e.publish(ctx, edge, machines, configs); err != nil {
			e.api.logger.Warn("assignment publish failed", "edge_id", edge, "error", err)
		}
	}
}

type edgeView struct {
	EdgeNode
	// Machines are the machines assigned to the edge, in the order they were given.
	Machines []string `json:"machines"`
}

func (e *Edges) list(w http.ResponseWriter, r *http.Request) int {
	lists, err := e.store.Assignments(r.Context())
	if err != nil {
		return e.api.fail(w, err)
	}
	nodes, err := e.store.Nodes(r.Context())
	if err != nil {
		return e.api.fail(w, err)
	}
	configs, err := e.configs(r.Context())
	if err != nil {
		return e.api.fail(w, err)
	}
	views := map[string]*edgeView{}
	for _, n := range nodes {
		// Edges that report nothing but are long gone (load tests) are not listed unless assigned.
		if _, assigned := lists[n.EdgeID]; assigned || n.Status == "online" {
			views[n.EdgeID] = &edgeView{EdgeNode: n, Machines: []string{}}
		}
	}
	assigned := map[string]bool{}
	for edge, machines := range lists {
		v, ok := views[edge]
		if !ok {
			v = &edgeView{EdgeNode: EdgeNode{EdgeID: edge, Status: "unknown"}}
			views[edge] = v
		}
		v.Machines = append([]string{}, machines...)
		for _, m := range machines {
			assigned[m] = true
		}
	}
	out := make([]edgeView, 0, len(views))
	for _, v := range views {
		out = append(out, *v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].EdgeID < out[j].EdgeID })
	unassigned := []string{}
	for id := range configs {
		if !assigned[id] {
			unassigned = append(unassigned, id)
		}
	}
	sort.Strings(unassigned)
	return writeJSON(w, http.StatusOK, map[string]any{"edges": out, "unassigned": unassigned})
}

// put sets the machines of an edge; a machine moves from the edge it was on.
func (e *Edges) put(w http.ResponseWriter, r *http.Request) int {
	edge := r.PathValue("edge_id")
	var req struct {
		MachineIDs []string `json:"machine_ids"`
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err == nil {
		err = json.Unmarshal(body, &req)
	}
	if err != nil {
		return writeJSON(w, http.StatusBadRequest, apiError{Error: "invalid JSON body: " + err.Error()})
	}
	if !identifier.MatchString(edge) {
		return writeJSON(w, http.StatusBadRequest, apiError{Error: "edge_id must be 1-64 characters of A-Z a-z 0-9 _ . -"})
	}
	configs, err := e.configs(r.Context())
	if err != nil {
		return e.api.fail(w, err)
	}
	var problems []string
	seen := map[string]bool{}
	machines := []string{}
	for _, id := range req.MachineIDs {
		switch {
		case configs[id] == nil:
			problems = append(problems, "machine "+id+" has no station config")
		case seen[id]:
			problems = append(problems, "machine "+id+" is listed twice")
		default:
			seen[id] = true
			machines = append(machines, id)
		}
	}
	if len(problems) > 0 {
		return writeJSON(w, http.StatusBadRequest, apiError{Error: "invalid assignment", Details: problems})
	}
	changed, err := e.assign(r.Context(), edge, machines)
	if err != nil {
		return e.api.fail(w, err)
	}
	if err := e.publishChanged(r.Context(), changed, configs); err != nil {
		return writeJSON(w, http.StatusServiceUnavailable, apiError{Error: "stored, but not published yet: " + err.Error()})
	}
	return writeJSON(w, http.StatusOK, edgeView{EdgeNode: EdgeNode{EdgeID: edge}, Machines: machines})
}

// assign stores the machines of edge and takes them off every other edge;
// it returns the new lists of the edges that changed.
func (e *Edges) assign(ctx context.Context, edge string, machines []string) (map[string][]string, error) {
	lists, err := e.store.Assignments(ctx)
	if err != nil {
		return nil, err
	}
	moving := map[string]bool{}
	for _, m := range machines {
		moving[m] = true
	}
	changed := map[string][]string{edge: machines}
	for other, list := range lists {
		if other == edge {
			continue
		}
		kept := make([]string, 0, len(list))
		for _, m := range list {
			if !moving[m] {
				kept = append(kept, m)
			}
		}
		if len(kept) != len(list) {
			changed[other] = kept
		}
	}
	return changed, e.store.SetAssignments(ctx, changed)
}

func (e *Edges) publishChanged(ctx context.Context, changed map[string][]string, configs map[string]*gaugev1.StationConfig) error {
	var first error
	for edge, machines := range changed {
		if err := e.publish(ctx, edge, machines, configs); err != nil && first == nil {
			first = err
		}
	}
	return first
}

// cameraIDs are the cameras the gauges of a config are on.
func cameraIDs(cfg *gaugev1.StationConfig) map[string]bool {
	out := map[string]bool{}
	for _, g := range cfg.GetGauges() {
		id := g.GetCameraId()
		if id == "" {
			id = cfg.GetCamera().GetCameraId()
		}
		if id != "" {
			out[id] = true
		}
	}
	return out
}

// Stored is called after a station config was saved. A machine already on
// an edge gets its assignment published again (its plant or line may have
// changed). A new machine goes to the edge that reads one of its cameras for
// another machine, or to the only edge there is; otherwise it waits for a
// person to assign it.
func (e *Edges) Stored(ctx context.Context, machineID string) {
	lists, err := e.store.Assignments(ctx)
	if err != nil {
		e.api.logger.Warn("assignments", "error", err)
		return
	}
	configs, err := e.configs(ctx)
	if err != nil {
		e.api.logger.Warn("configs for assignments", "error", err)
		return
	}
	for edge, machines := range lists {
		for _, m := range machines {
			if m == machineID {
				if err := e.publish(ctx, edge, machines, configs); err != nil {
					e.api.logger.Warn("assignment publish failed", "edge_id", edge, "error", err)
				}
				return
			}
		}
	}
	cfg := configs[machineID]
	if cfg == nil {
		return
	}
	mine := cameraIDs(cfg)
	target := ""
	for edge, machines := range lists {
		for _, m := range machines {
			other := configs[m]
			if other == nil {
				continue
			}
			for id := range cameraIDs(other) {
				if mine[id] {
					target = edge
				}
			}
		}
	}
	if target == "" && len(lists) == 1 {
		for edge := range lists {
			target = edge
		}
	}
	if target == "" {
		e.api.logger.Info("new machine waits for an edge", "machine_id", machineID)
		return
	}
	machines := append(append([]string{}, lists[target]...), machineID)
	if err := e.store.SetAssignments(ctx, map[string][]string{target: machines}); err != nil {
		e.api.logger.Warn("assign new machine", "error", err)
		return
	}
	if err := e.publish(ctx, target, machines, configs); err != nil {
		e.api.logger.Warn("assignment publish failed", "edge_id", target, "error", err)
	}
	e.api.logger.Info("new machine assigned", "machine_id", machineID, "edge_id", target)
}

// Deleted takes a removed machine off its edge.
func (e *Edges) Deleted(ctx context.Context, machineID string) {
	lists, err := e.store.Assignments(ctx)
	if err != nil {
		return
	}
	for edge, machines := range lists {
		kept := make([]string, 0, len(machines))
		for _, m := range machines {
			if m != machineID {
				kept = append(kept, m)
			}
		}
		if len(kept) == len(machines) {
			continue
		}
		if err := e.store.SetAssignments(ctx, map[string][]string{edge: kept}); err != nil {
			e.api.logger.Warn("unassign deleted machine", "error", err)
			return
		}
		configs, err := e.configs(ctx)
		if err == nil {
			err = e.publish(ctx, edge, kept, configs)
		}
		if err != nil {
			e.api.logger.Warn("assignment publish failed", "edge_id", edge, "error", err)
		}
	}
}
