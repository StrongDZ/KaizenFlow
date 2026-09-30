package livesvc

import (
	"context"
	"log"
	"strconv"
	"strings"
	"time"

	"github.com/kaizenflow/api/internal/live"
	"github.com/kaizenflow/api/internal/store"
)

const (
	// driftChecks: số lần kiểm liên tiếp ngoài dải mới báo lệch.
	driftChecks = 3
	// driftGap: hai lần kiểm phải cách nhau chừng này giờ nhà máy mới tính là hai quan sát riêng.
	driftGap = 5 * time.Minute
)

// DriftStore là phần của store mà monitor dùng (để test bằng bản giả).
type DriftStore interface {
	LatestNowcastRun(ctx context.Context, model string) (*store.RunRow, error)
	Bands(ctx context.Context, runID int64, subject, metric string) ([]store.BandRow, error)
	OpenInsightExists(ctx context.Context, runID int64, kind, subject, metric string) (bool, error)
	InsertInsight(ctx context.Context, in store.Insight) (int64, error)
}

// Monitor so tồn kho thật với dải của dự báo từ trạng thái live gần nhất và sinh insight DRIFT khi thực tế lệch.
type Monitor struct {
	st    DriftStore
	svc   *Service
	hub   Broadcaster
	det   *live.Detector
	cache map[string][]live.BandPt
}

func NewMonitor(st DriftStore, svc *Service, hub Broadcaster) *Monitor {
	return &Monitor{st: st, svc: svc, hub: hub, det: live.NewDetector(driftChecks, driftGap), cache: map[string][]live.BandPt{}}
}

func (m *Monitor) bands(ctx context.Context, runID int64, subject, metric string) ([]live.BandPt, error) {
	key := strconv.FormatInt(runID, 10) + "|" + subject + "|" + metric
	if b, ok := m.cache[key]; ok {
		return b, nil
	}
	rows, err := m.st.Bands(ctx, runID, subject, metric)
	if err != nil {
		return nil, err
	}
	out := make([]live.BandPt, len(rows))
	for i, r := range rows {
		out[i] = live.BandPt{T: r.T, P10: r.P10, P50: r.P50, P90: r.P90}
	}
	m.cache[key] = out // dải của một lần chạy không đổi nên chỉ cần đọc một lần
	return out, nil
}

// Tick kiểm mọi mô hình đang có dữ liệu live một lượt.
func (m *Monitor) Tick(ctx context.Context) error {
	for _, model := range m.svc.State().Models() {
		run, err := m.st.LatestNowcastRun(ctx, model)
		if err != nil {
			return err
		}
		if run == nil {
			continue
		}
		snap := m.svc.Snapshot(model)
		for subject, sub := range snap.Subjects {
			for name, sig := range sub.Signals {
				if !strings.HasPrefix(name, "level:") {
					continue
				}
				bands, err := m.bands(ctx, run.ID, subject, name)
				if err != nil {
					return err
				}
				verdict, band := live.Judge(bands, sig.TS, sig.V)
				if !m.det.Observe(model+"|"+strconv.FormatInt(run.ID, 10)+"|"+subject+"|"+name, verdict, sig.TS) {
					continue
				}
				if exists, err := m.st.OpenInsightExists(ctx, run.ID, "DRIFT", subject, name); err != nil {
					return err
				} else if exists {
					continue
				}
				sev := 2
				runID := run.ID
				if _, err := m.st.InsertInsight(ctx, store.Insight{SimRunID: &runID, Kind: "DRIFT", SubjectKey: &subject, Severity: &sev,
					Payload: map[string]any{"metric": name, "direction": verdict.String(), "actual": sig.V, "p10": band.P10, "p50": band.P50, "p90": band.P90,
						"at": sig.TS, "model": model}}); err != nil {
					return err
				}
				m.hub.Broadcast(map[string]any{"type": "insight", "model": model, "kind": "DRIFT"})
			}
		}
	}
	return nil
}

// Run kiểm mỗi 2 giây cho đến khi ctx kết thúc.
func (m *Monitor) Run(ctx context.Context) {
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			if err := m.Tick(ctx); err != nil && ctx.Err() == nil {
				log.Printf("drift monitor: %v", err)
			}
		}
	}
}
