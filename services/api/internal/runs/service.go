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

// maxPollErrors: số lần liên tiếp không hỏi được trạng thái trước khi coi run là FAILED.
const maxPollErrors = 30

func (s *Service) fail(runID int64, msg string) {
	_ = s.Store.SetRunStatus(context.Background(), runID, "FAILED", &msg)
	s.notify(runID, "FAILED")
}

func (s *Service) drive(runID int64, req *simapi.RunRequest, timeout time.Duration) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
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
		s.fail(runID, "sim-service: "+err.Error())
		return
	}
	_ = s.Store.SetRunStatus(ctx, runID, "RUNNING", nil)
	s.notify(runID, "RUNNING")
	s.watch(ctx, runID)
}

// watch poll sim-service đến khi run xong, thất bại, bị mất hoặc hết giờ.
func (s *Service) watch(ctx context.Context, runID int64) {
	tick := time.NewTicker(s.poll())
	defer tick.Stop()
	errs := 0
	for {
		select {
		case <-ctx.Done():
			s.fail(runID, "timeout")
			return
		case <-tick.C:
			st, err := s.Sim.Status(ctx, runID)
			if errors.Is(err, simclient.ErrNotFound) {
				s.fail(runID, "sim-service lost this run (restarted?) — run again")
				return
			}
			if err != nil {
				if errs++; errs >= maxPollErrors {
					s.fail(runID, "sim-service unreachable: "+err.Error())
					return
				}
				continue
			}
			errs = 0
			switch st.Status {
			case "DONE":
				res, err := s.Sim.Result(ctx, runID)
				if err != nil {
					s.fail(runID, "fetch result: "+err.Error())
					return
				}
				if err := s.Store.SaveResult(context.Background(), runID, res); err != nil {
					s.fail(runID, "save result: "+err.Error())
					return
				}
				s.notify(runID, "DONE")
				return
			case "FAILED":
				s.fail(runID, st.Error)
				return
			}
		}
	}
}

// Recover theo dõi lại các run chưa kết thúc sau khi API khởi động lại.
// Run mà sim-service không còn biết sẽ bị đánh dấu FAILED.
func (s *Service) Recover(ctx context.Context) error {
	active, err := s.Store.ListActiveRuns(ctx)
	if err != nil {
		return err
	}
	for _, r := range active {
		go func(id int64) {
			wctx, cancel := context.WithTimeout(context.Background(), time.Hour)
			defer cancel()
			s.watch(wctx, id)
		}(r.ID)
	}
	return nil
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

// ApplyAdjustment là phần operator được phép tinh chỉnh trước khi chạy lại một đề xuất.
// Chỉ dùng các field phù hợp với action; service không nhận override/path tuỳ ý từ trình duyệt.
type ApplyAdjustment struct {
	ToSlots *int     `json:"to_slots,omitempty"`
	ToRate  *float64 `json:"to_rate,omitempty"`
}

func number(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	default:
		return 0, false
	}
}

func cloneCandidate(src map[string]any) map[string]any {
	out := make(map[string]any, len(src))
	for k, v := range src {
		out[k] = v
	}
	if action, ok := src["action"].(map[string]any); ok {
		copyAction := make(map[string]any, len(action))
		for k, v := range action {
			copyAction[k] = v
		}
		out["action"] = copyAction
	}
	if raw, ok := src["overrides"].([]any); ok {
		copyOverrides := make([]any, 0, len(raw))
		for _, item := range raw {
			if override, ok := item.(map[string]any); ok {
				copyOverride := make(map[string]any, len(override))
				for k, v := range override {
					copyOverride[k] = v
				}
				copyOverrides = append(copyOverrides, copyOverride)
			} else {
				copyOverrides = append(copyOverrides, item)
			}
		}
		out["overrides"] = copyOverrides
	}
	return out
}

func candidateOverride(cand map[string]any, target, path string) (map[string]any, bool) {
	for _, override := range toMaps(cand["overrides"]) {
		if override["target"] == target && override["path"] == path {
			return override, true
		}
	}
	return nil, false
}

func scaleDuration(v any, factor float64) (any, bool) {
	if n, ok := number(v); ok {
		return n * factor, true
	}
	m, ok := v.(map[string]any)
	if !ok {
		return nil, false
	}
	out := make(map[string]any, len(m))
	for k, value := range m {
		out[k] = value
	}
	changed := false
	for _, key := range []string{"value", "value_s", "mean", "mean_s", "sd", "sd_s", "min", "min_s", "mode", "mode_s", "max", "max_s", "scale", "scale_s"} {
		if n, ok := number(out[key]); ok {
			out[key] = n * factor
			changed = true
		}
	}
	return out, changed
}

func adjustCandidate(cand map[string]any, adjustment *ApplyAdjustment) error {
	if adjustment == nil || (adjustment.ToSlots == nil && adjustment.ToRate == nil) {
		return nil
	}
	action, ok := cand["action"].(map[string]any)
	if !ok {
		return &store.RefError{Key: "action", Msg: "đề xuất không có action hợp lệ"}
	}
	target, _ := action["target"].(string)
	switch action["type"] {
	case "INCREASE_PROCESS_CAPACITY":
		if adjustment.ToSlots == nil || adjustment.ToRate != nil {
			return &store.RefError{Key: "adjustment", Msg: "đề xuất tăng năng lực chỉ cho phép chỉnh số slot"}
		}
		from, ok := number(action["from_slots"])
		if !ok {
			return &store.RefError{Key: "action", Msg: "đề xuất thiếu số slot hiện tại"}
		}
		to := *adjustment.ToSlots
		if to <= int(from) || to > 8 {
			return &store.RefError{Key: "to_slots", Msg: fmt.Sprintf("phải lớn hơn %d và không quá 8", int(from))}
		}
		override, ok := candidateOverride(cand, target, "/slots")
		if !ok {
			return &store.RefError{Key: "overrides", Msg: "không tìm thấy override slot của node"}
		}
		override["value"] = to
		action["to_slots"] = to
		action["delta"] = float64(to) - from
	case "REDUCE_MACHINE_RATE":
		if adjustment.ToRate == nil || adjustment.ToSlots != nil {
			return &store.RefError{Key: "adjustment", Msg: "đề xuất giảm nhịp chỉ cho phép chỉnh u/h mục tiêu"}
		}
		from, fromOK := number(action["from_rate"])
		oldTo, toOK := number(action["to_rate"])
		to := *adjustment.ToRate
		if !fromOK || !toOK || math.IsNaN(from) || math.IsInf(from, 0) || math.IsNaN(oldTo) || math.IsInf(oldTo, 0) {
			return &store.RefError{Key: "action", Msg: "đề xuất thiếu nhịp máy hiện tại"}
		}
		if math.IsNaN(to) || math.IsInf(to, 0) || to < from*0.5 || to >= from {
			return &store.RefError{Key: "to_rate", Msg: fmt.Sprintf("phải từ %.1f đến dưới %.1f u/h", from*0.5, from)}
		}
		override, ok := candidateOverride(cand, target, "/cycle")
		if !ok {
			return &store.RefError{Key: "overrides", Msg: "không tìm thấy override cycle của node"}
		}
		scaled, ok := scaleDuration(override["value"], oldTo/to)
		if !ok {
			return &store.RefError{Key: "overrides", Msg: "cycle của node không thể tinh chỉnh"}
		}
		override["value"] = scaled
		action["to_rate"] = to
		action["delta"] = to - from
	default:
		return &store.RefError{Key: "adjustment", Msg: "loại action này chưa hỗ trợ chỉnh tham số"}
	}
	return nil
}

// Apply tạo scenario con từ ứng viên `rank` của một insight RECOMMENDATION và chạy nó.
func (s *Service) Apply(ctx context.Context, insightID int64, rank int, adjustment *ApplyAdjustment) (int64, error) {
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
			cand = cloneCandidate(c)
		}
	}
	if cand == nil {
		return 0, &store.RefError{Key: fmt.Sprint(rank), Msg: "no candidate with this rank"}
	}
	if err := adjustCandidate(cand, adjustment); err != nil {
		return 0, err
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
		Name:     fmt.Sprintf("Đề xuất #%d: %v %v", rank, action["type"], action["target"]),
		HorizonS: parent.HorizonS, StartState: parent.StartState,
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
