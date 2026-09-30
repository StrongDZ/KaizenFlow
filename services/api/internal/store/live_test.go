package store_test

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/kaizenflow/api/internal/live"
	"github.com/kaizenflow/api/internal/store"
	"github.com/kaizenflow/api/internal/testfix"
)

func binding(subject, signal, source, path string) live.Binding {
	return live.Binding{Subject: subject, Signal: signal, Source: source, JSONPath: path, Enabled: true}
}

func TestBindingsUpsertListDelete(t *testing.T) {
	st := testfix.Seeded(t, "store_bind")
	sc := 2.0
	b := binding("STAMP_2", "count_ok", "plc/prs-02/status", "cnt.ok")
	b.Transform = live.Transform{Scale: &sc}
	if err := st.SaveBindings(ctx, "m", []live.Binding{b, binding("STAMP_2", "state", "plc/prs-02/status", "st")}); err != nil {
		t.Fatal(err)
	}
	// ghi lại cùng (subject, signal) là cập nhật, không nhân đôi
	b.JSONPath = "cnt.good"
	if err := st.SaveBindings(ctx, "m", []live.Binding{b}); err != nil {
		t.Fatal(err)
	}
	list, err := st.ListBindings(ctx, "m")
	if err != nil || len(list) != 2 {
		t.Fatalf("list = %+v, err = %v", list, err)
	}
	var got live.Binding
	for _, x := range list {
		if x.Signal == "count_ok" {
			got = x
		}
	}
	if got.JSONPath != "cnt.good" || got.Transform.Scale == nil || *got.Transform.Scale != 2 || got.ModelKey != "m" || !got.Enabled {
		t.Errorf("bad binding %+v", got)
	}
	if other, _ := st.ListBindings(ctx, "other"); len(other) != 0 {
		t.Errorf("bindings leaked across models: %+v", other)
	}
	all, err := st.AllBindings(ctx)
	if err != nil || len(all) != 2 {
		t.Fatalf("all = %+v %v", all, err)
	}
	if err := st.DeleteBinding(ctx, "m", got.ID); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteBinding(ctx, "m", got.ID); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("second delete err = %v, want ErrNotFound", err)
	}
	if err := st.DeleteBinding(ctx, "wrong-model", list[0].ID); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("deleting another model's binding must be ErrNotFound, got %v", err)
	}
}

func TestSaveBindingsRejectsIncomplete(t *testing.T) {
	st := testfix.Seeded(t, "store_bind_bad")
	for _, b := range []live.Binding{
		binding("", "state", "s", "st"), binding("A", "", "s", "st"), binding("A", "state", "", "st"),
	} {
		var re *store.RefError
		if err := st.SaveBindings(ctx, "m", []live.Binding{b}); !errors.As(err, &re) {
			t.Errorf("SaveBindings(%+v) err = %v, want RefError", b, err)
		}
	}
}

func TestAgvMapRoundTrip(t *testing.T) {
	st := testfix.Seeded(t, "store_agvmap")
	if _, err := st.GetAgvMap(ctx, "m"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing map err = %v", err)
	}
	g := json.RawMessage(`{"points":[{"id":"P1","x":1,"y":2}],"lanes":[]}`)
	if err := st.PutAgvMap(ctx, "m", g); err != nil {
		t.Fatal(err)
	}
	g2 := json.RawMessage(`{"points":[],"lanes":[]}`)
	if err := st.PutAgvMap(ctx, "m", g2); err != nil {
		t.Fatal(err)
	}
	got, err := st.GetAgvMap(ctx, "m")
	if err != nil {
		t.Fatal(err)
	}
	var v map[string]any
	if json.Unmarshal(got, &v) != nil || len(v["points"].([]any)) != 0 {
		t.Errorf("map not replaced: %s", got)
	}
}

func TestLiveSignalsInsertQueryClear(t *testing.T) {
	st := testfix.Seeded(t, "store_live")
	t0 := time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC)
	sigs := []store.LiveSignal{
		{Time: t0, Model: "m", Subject: "KHO_A", Name: "level:RAW-01", Value: 300},
		{Time: t0.Add(time.Minute), Model: "m", Subject: "KHO_A", Name: "level:RAW-01", Value: 290},
		{Time: t0, Model: "other", Subject: "KHO_A", Name: "level:RAW-01", Value: 1},
	}
	evs := []store.LiveEvent{{Time: t0, Model: "m", Subject: "STAMP_2", Type: "STATE", Payload: map[string]any{"state": "DOWN"}}}
	if err := st.InsertLive(ctx, sigs, evs); err != nil {
		t.Fatal(err)
	}
	rows, err := st.LiveSignals(ctx, "m", "KHO_A", "level:RAW-01", nil, nil, 100)
	if err != nil || len(rows) != 2 || rows[0].Value != 300 || rows[1].Value != 290 {
		t.Fatalf("rows = %+v err = %v", rows, err)
	}
	since := t0.Add(30 * time.Second)
	if rows, _ := st.LiveSignals(ctx, "m", "KHO_A", "level:RAW-01", &since, nil, 100); len(rows) != 1 {
		t.Errorf("since filter: %+v", rows)
	}
	evRows, err := st.LiveEvents(ctx, "m", "STAMP_2", 10)
	if err != nil || len(evRows) != 1 || evRows[0].Payload["state"] != "DOWN" {
		t.Fatalf("events = %+v err = %v", evRows, err)
	}
	// dữ liệu mô phỏng (run_id có giá trị) không lẫn vào live
	if _, err := st.Pool.Exec(ctx, `INSERT INTO signal (time, run_id, subject, name, value) VALUES ($1, 7, 'KHO_A', 'level:RAW-01', 5)`, t0); err != nil {
		t.Fatal(err)
	}
	if rows, _ := st.LiveSignals(ctx, "m", "KHO_A", "level:RAW-01", nil, nil, 100); len(rows) != 2 {
		t.Errorf("sim rows leaked into live: %d", len(rows))
	}
	if err := st.ClearLive(ctx, "m"); err != nil {
		t.Fatal(err)
	}
	if rows, _ := st.LiveSignals(ctx, "m", "KHO_A", "level:RAW-01", nil, nil, 100); len(rows) != 0 {
		t.Errorf("not cleared: %+v", rows)
	}
	if rows, _ := st.LiveSignals(ctx, "other", "KHO_A", "level:RAW-01", nil, nil, 100); len(rows) != 1 {
		t.Errorf("clear touched another model")
	}
	var simRows int
	_ = st.Pool.QueryRow(ctx, `SELECT count(*) FROM signal WHERE run_id = 7`).Scan(&simRows)
	if simRows != 1 {
		t.Errorf("clear removed simulation rows")
	}
}

func TestDeleteModelRemovesItsLiveConfig(t *testing.T) {
	st := testfix.Seeded(t, "store_del_live")
	vid := seededVersion(t, st, "dm")
	_ = vid
	if err := st.SaveBindings(ctx, "dm", []live.Binding{binding("A", "state", "s", "st")}); err != nil {
		t.Fatal(err)
	}
	if err := st.PutAgvMap(ctx, "dm", json.RawMessage(`{"points":[],"lanes":[]}`)); err != nil {
		t.Fatal(err)
	}
	if err := st.InsertLive(ctx, []store.LiveSignal{{Time: time.Now(), Model: "dm", Subject: "A", Name: "x", Value: 1}}, nil); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteModel(ctx, "dm", true); err != nil {
		t.Fatal(err)
	}
	for name, q := range map[string]string{
		"data_binding": `SELECT count(*) FROM data_binding WHERE model_key = 'dm'`,
		"agv_map":      `SELECT count(*) FROM agv_map WHERE model_key = 'dm'`,
		"live signal":  `SELECT count(*) FROM signal WHERE model_key = 'dm'`,
	} {
		if n := count(t, st, q); n != 0 {
			t.Errorf("%s left %d rows", name, n)
		}
	}
}
