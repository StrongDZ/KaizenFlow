package store_test

import (
	"errors"
	"testing"
	"time"

	"github.com/kaizenflow/api/internal/store"
	"github.com/kaizenflow/api/internal/testfix"
)

func TestDeleteRunRemovesItsRowsButNotPredictBands(t *testing.T) {
	st := testfix.Seeded(t, "store_del_run")
	vid := seededVersion(t, st, "dr")
	sid, _ := st.CreateScenario(ctx, store.Scenario{ModelVersionID: vid, Name: "A", HorizonS: 3600})
	rid := doneRun(t, st, sid)
	// dự báo của Predict có ref_id trùng số run: tuyệt đối không được xoá
	if _, err := st.Pool.Exec(ctx, `INSERT INTO forecast_band (issued_at, target_time, producer, ref_id, subject, metric, p50)
		VALUES ($1, $1, 'PREDICT:HW', $2, 'RAW-01', 'demand_daily', 100)`, time.Now(), rid); err != nil {
		t.Fatal(err)
	}
	if count(t, st, `SELECT count(*) FROM signal WHERE run_id = $1`, rid) == 0 {
		t.Fatal("fixture has no signals")
	}

	if err := st.DeleteRun(ctx, rid); err != nil {
		t.Fatal(err)
	}
	for name, q := range map[string]string{
		"sim_run":   `SELECT count(*) FROM sim_run WHERE id = $1`,
		"insight":   `SELECT count(*) FROM insight WHERE sim_run_id = $1`,
		"signal":    `SELECT count(*) FROM signal WHERE run_id = $1`,
		"event_log": `SELECT count(*) FROM event_log WHERE run_id = $1`,
		"sim bands": `SELECT count(*) FROM forecast_band WHERE producer = 'SIM' AND ref_id = $1`,
	} {
		if n := count(t, st, q, rid); n != 0 {
			t.Fatalf("%s left %d rows", name, n)
		}
	}
	if n := count(t, st, `SELECT count(*) FROM forecast_band WHERE producer = 'PREDICT:HW' AND ref_id = $1`, rid); n != 1 {
		t.Fatalf("predict band count = %d, want 1", n)
	}
	if n := count(t, st, `SELECT count(*) FROM scenario WHERE id = $1`, sid); n != 1 {
		t.Fatal("deleting a run must not delete its scenario")
	}
}

func TestDeleteRunRefusesActiveAndUnknown(t *testing.T) {
	st := testfix.Seeded(t, "store_del_run_busy")
	vid := seededVersion(t, st, "drb")
	sid, _ := st.CreateScenario(ctx, store.Scenario{ModelVersionID: vid, Name: "A", HorizonS: 3600})
	queued, err := st.InsertRun(ctx, sid, time.Now(), "FORECAST")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteRun(ctx, queued); !errors.Is(err, store.ErrBusy) {
		t.Fatalf("queued: %v", err)
	}
	_ = st.SetRunStatus(ctx, queued, "RUNNING", nil)
	if err := st.DeleteRun(ctx, queued); !errors.Is(err, store.ErrBusy) {
		t.Fatalf("running: %v", err)
	}
	_ = st.SetRunStatus(ctx, queued, "FAILED", nil)
	if err := st.DeleteRun(ctx, queued); err != nil {
		t.Fatalf("failed run should be deletable: %v", err)
	}
	if err := st.DeleteRun(ctx, 999999); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown: %v", err)
	}
}
