// Package runs điều phối một lần chạy: resolve → sim-service → poll → lưu kết quả → WebSocket.
package runs

import (
	"context"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/kaizenflow/api/internal/resolve"
	"github.com/kaizenflow/api/internal/simapi"
	"github.com/kaizenflow/api/internal/simclient"
	"github.com/kaizenflow/api/internal/store"
	"github.com/kaizenflow/api/internal/ws"
)

var (
	ErrNotPublished      = errors.New("model version must be PUBLISHED before running")
	ErrNotRecommendation = errors.New("insight is not a RECOMMENDATION")
)

type Service struct {
	Store *store.Store
	Sim   *simclient.Client
	Hub   *ws.Hub
	Poll  time.Duration
}

func (s *Service) Start(ctx context.Context, scenarioID int64, simStart time.Time) (int64, error) {
	sc, err := s.Store.GetScenario(ctx, scenarioID)
	if err != nil {
		return 0, err
	}
	g, err := s.Store.GetGraph(ctx, sc.ModelVersionID)
	if err != nil {
		return 0, err
	}
	if g.Status != "PUBLISHED" {
		return 0, ErrNotPublished
	}
	types, err := s.Store.NodeTypes(ctx)
	if err != nil {
		return 0, err
	}
	mats, err := s.Store.MaterialCodes(ctx)
	if err != nil {
		return 0, err
	}
	runID, err := s.Store.InsertRun(ctx, sc.ID, simStart, "FORECAST")
	if err != nil {
		return 0, err
	}
	req, err := resolve.Build(ctx, g, types, mats, sc, runID, simStart, s.Store.DailyForecast, resolve.Options{})
	if err != nil {
		msg := err.Error()
		_ = s.Store.SetRunStatus(ctx, runID, "FAILED", &msg)
		return runID, err
	}
	timeout := math.Max(60, sc.HorizonS*float64(req.Replications)/2000)
	if req.Recommend {
		timeout *= 5
	}
	go s.drive(runID, req, time.Duration(timeout*float64(time.Second)))
	return runID, nil
}

func (s *Service) poll() time.Duration {
	if s.Poll <= 0 {
		return time.Second
	}
	return s.Poll
}

func (s *Service) notify(id int64, status string) {
	if s.Hub != nil {
		s.Hub.Broadcast(map[string]any{"type": "run_status", "run_id": id, "status": status})
	}
}

func (s *Service) drive(runID int64, req *simapi.RunRequest, timeout time.Duration) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	fail := func(msg string) {
		_ = s.Store.SetRunStatus(context.Background(), runID, "FAILED", &msg)
		s.notify(runID, "FAILED")
	}
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		if err = s.Sim.StartRun(ctx, req); err == nil {
			break
		}
		var ce *simapi.ContractError
		if errors.As(err, &ce) {
			break
		}
		select {
		case <-time.After(s.poll() * 10):
		case <-ctx.Done():
		}
	}
	if err != nil {
		fail("sim-service: " + err.Error())
		return
	}
	_ = s.Store.SetRunStatus(ctx, runID, "RUNNING", nil)
	s.notify(runID, "RUNNING")
	tick := time.NewTicker(s.poll())
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			fail("timeout")
			return
		case <-tick.C:
			st, err := s.Sim.Status(ctx, runID)
			if err != nil {
				continue
			}
			switch st.Status {
			case "DONE":
				res, err := s.Sim.Result(ctx, runID)
				if err != nil {
					fail("fetch result: " + err.Error())
					return
				}
				if err := s.Store.SaveResult(context.Background(), runID, res); err != nil {
					fail("save result: " + err.Error())
					return
				}
				s.notify(runID, "DONE")
				return
			case "FAILED":
				fail(st.Error)
				return
			}
		}
	}
}

func toMaps(v any) []map[string]any {
	list, _ := v.([]any)
	out := make([]map[string]any, 0, len(list))
	for _, x := range list {
		if m, ok := x.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

// Apply tạo scenario con từ ứng viên `rank` của một insight RECOMMENDATION và chạy nó.
func (s *Service) Apply(ctx context.Context, insightID int64, rank int) (int64, error) {
	ins, err := s.Store.GetInsight(ctx, insightID)
	if err != nil {
		return 0, err
	}
	if ins.Kind != "RECOMMENDATION" || ins.SimRunID == nil {
		return 0, ErrNotRecommendation
	}
	var cand map[string]any
	for _, c := range toMaps(ins.Payload["candidates"]) {
		if r, _ := c["rank"].(float64); int(r) == rank {
			cand = c
		}
	}
	if cand == nil {
		return 0, &store.RefError{Key: fmt.Sprint(rank), Msg: "no candidate with this rank"}
	}
	run, err := s.Store.GetRun(ctx, *ins.SimRunID)
	if err != nil {
		return 0, err
	}
	parent, err := s.Store.GetScenario(ctx, run.ScenarioID)
	if err != nil {
		return 0, err
	}
	seed := run.ID // seed hiệu lực của run gốc (resolve dùng run id khi scenario không có seed)
	if parent.Seed != nil {
		seed = *parent.Seed
	}
	action, _ := cand["action"].(map[string]any)
	child := store.Scenario{
		ModelVersionID: parent.ModelVersionID, ParentID: &parent.ID, Origin: "RECOMMENDER",
		Name:       fmt.Sprintf("Đề xuất #%d: %v %v", rank, action["type"], action["target"]),
		HorizonS:   parent.HorizonS, StartState: parent.StartState,
		Overrides:  append(append([]map[string]any{}, parent.Overrides...), toMaps(cand["overrides"])...),
		Injections: parent.Injections, Action: action, Replications: parent.Replications, Seed: &seed,
	}
	if inj, ok := cand["injections"].([]any); ok {
		child.Injections = toMaps(inj)
	}
	id, err := s.Store.CreateScenario(ctx, child)
	if err != nil {
		return 0, err
	}
	return s.Start(ctx, id, run.SimStart)
}
