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

// lineage dựng: mô hình `key` v1 đã Publish; scenario A (gốc) và B (con do Recommend tạo, parent_id = A);
// mỗi scenario có một run đã xong.
func lineage(t *testing.T, st *store.Store, key string) (vid, sa, sb, ra, rb int64) {
	t.Helper()
	vid = seededVersion(t, st, key)
	sa, err := st.CreateScenario(ctx, store.Scenario{ModelVersionID: vid, Name: "gốc", HorizonS: 3600})
	if err != nil {
		t.Fatal(err)
	}
	sb, err = st.CreateScenario(ctx, store.Scenario{ModelVersionID: vid, Name: "con", HorizonS: 3600, ParentID: &sa, Origin: "RECOMMENDER"})
	if err != nil {
		t.Fatal(err)
	}
	return vid, sa, sb, doneRun(t, st, sa), doneRun(t, st, sb)
}

func requireImpact(t *testing.T, err error, want map[string]int) {
	t.Helper()
	var im *store.ImpactError
	if !errors.As(err, &im) {
		t.Fatalf("err = %v, want ImpactError %v", err, want)
	}
	if len(im.Impact) != len(want) {
		t.Fatalf("impact = %v, want %v", im.Impact, want)
	}
	for k, v := range want {
		if im.Impact[k] != v {
			t.Fatalf("impact = %v, want %v", im.Impact, want)
		}
	}
}

func TestDeleteScenarioImpactThenCascade(t *testing.T) {
	st := testfix.Seeded(t, "store_del_scenario")
	vid, sa, sb, ra, rb := lineage(t, st, "del")

	// xoá con: chỉ mất run của nó, không đụng cha
	requireImpact(t, st.DeleteScenario(ctx, sb, false), map[string]int{"runs": 1})
	// xoá cha: mất cả con và 2 run; chưa cascade thì chưa xoá gì
	requireImpact(t, st.DeleteScenario(ctx, sa, false), map[string]int{"scenarios": 1, "runs": 2})
	if n := count(t, st, `SELECT count(*) FROM scenario WHERE id = ANY($1)`, []int64{sa, sb}); n != 2 {
		t.Fatalf("scenarios after refused delete = %d", n)
	}
	if err := st.DeleteScenario(ctx, sa, true); err != nil {
		t.Fatal(err)
	}
	if n := count(t, st, `SELECT count(*) FROM scenario WHERE id = ANY($1)`, []int64{sa, sb}); n != 0 {
		t.Fatalf("scenarios left = %d", n)
	}
	for name, q := range map[string]string{
		"sim_run": `SELECT count(*) FROM sim_run`, "insight": `SELECT count(*) FROM insight`,
		"signal": `SELECT count(*) FROM signal`, "event_log": `SELECT count(*) FROM event_log`,
		"sim bands": `SELECT count(*) FROM forecast_band WHERE producer = 'SIM'`,
	} {
		if n := count(t, st, q); n != 0 {
			t.Fatalf("%s left %d rows (runs %d, %d)", name, n, ra, rb)
		}
	}
	// scenario không có phụ thuộc thì xoá luôn, không cần xác nhận
	free, _ := st.CreateScenario(ctx, store.Scenario{ModelVersionID: vid, Name: "trống", HorizonS: 60})
	if err := st.DeleteScenario(ctx, free, false); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteScenario(ctx, 999999, false); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown: %v", err)
	}
}

func TestDeleteRefusedWhileARunIsActive(t *testing.T) {
	st := testfix.Seeded(t, "store_del_busy")
	vid, sa, _, _, _ := lineage(t, st, "busy")
	if _, err := st.InsertRun(ctx, sa, time.Now(), "FORECAST"); err != nil { // QUEUED
		t.Fatal(err)
	}
	for name, err := range map[string]error{
		"scenario": st.DeleteScenario(ctx, sa, true),
		"version":  st.DeleteVersion(ctx, vid, true),
		"model":    st.DeleteModel(ctx, "busy", true),
	} {
		if !errors.Is(err, store.ErrBusy) {
			t.Fatalf("%s: %v", name, err)
		}
	}
	if n := count(t, st, `SELECT count(*) FROM scenario`); n != 2 {
		t.Fatalf("busy delete removed scenarios: %d left", n)
	}
}

func TestDeleteVersionCascadesAndLeavesSiblings(t *testing.T) {
	st := testfix.Seeded(t, "store_del_version")
	vid, _, _, _, _ := lineage(t, st, "del")
	v2, err := st.Clone(ctx, vid) // nháp, không scenario
	if err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteVersion(ctx, v2, false); err != nil { // không phụ thuộc → xoá luôn
		t.Fatal(err)
	}
	requireImpact(t, st.DeleteVersion(ctx, vid, false), map[string]int{"scenarios": 2, "runs": 2})
	if err := st.DeleteVersion(ctx, vid, true); err != nil {
		t.Fatal(err)
	}
	for name, q := range map[string]string{
		"version":  `SELECT count(*) FROM model_version`,
		"node":     `SELECT count(*) FROM node`,
		"edge":     `SELECT count(*) FROM edge`,
		"scenario": `SELECT count(*) FROM scenario`,
		"sim_run":  `SELECT count(*) FROM sim_run`,
		"signal":   `SELECT count(*) FROM signal`,
	} {
		if n := count(t, st, q); n != 0 {
			t.Fatalf("%s left %d rows", name, n)
		}
	}
	if ms, _ := st.ListModels(ctx); len(ms) != 0 {
		t.Fatalf("model should vanish with its last version: %v", ms)
	}
	if err := st.DeleteVersion(ctx, vid, false); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("second delete: %v", err)
	}
}

func TestDeleteModelNeedsConfirmationOnlyWhenThereIsSomethingToLose(t *testing.T) {
	st := testfix.Seeded(t, "store_del_model")
	v1 := seededVersion(t, st, "two")
	if _, err := st.Clone(ctx, v1); err != nil {
		t.Fatal(err)
	}
	requireImpact(t, st.DeleteModel(ctx, "two", false), map[string]int{"versions": 2})
	if err := st.DeleteModel(ctx, "two", true); err != nil {
		t.Fatal(err)
	}
	seededVersion(t, st, "solo") // một version, không scenario: xoá luôn
	if err := st.DeleteModel(ctx, "solo", false); err != nil {
		t.Fatal(err)
	}
	if ms, _ := st.ListModels(ctx); len(ms) != 0 {
		t.Fatalf("models left: %v", ms)
	}
	if err := st.DeleteModel(ctx, "nope", false); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown: %v", err)
	}
}
