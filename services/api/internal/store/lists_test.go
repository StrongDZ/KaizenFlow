package store_test

import (
	"errors"
	"testing"
	"time"

	"github.com/kaizenflow/api/internal/store"
	"github.com/kaizenflow/api/internal/testfix"
)

func TestListRunRowsFiltersAndPages(t *testing.T) {
	st := testfix.Seeded(t, "store_runrows")
	v1 := seededVersion(t, st, "alpha")
	v2 := seededVersion(t, st, "beta")
	s1, _ := st.CreateScenario(ctx, store.Scenario{ModelVersionID: v1, Name: "Ca sáng", HorizonS: 3600})
	s2, _ := st.CreateScenario(ctx, store.Scenario{ModelVersionID: v2, Name: "Ca tối", HorizonS: 3600})
	done := doneRun(t, st, s1)
	queued, err := st.InsertRun(ctx, s2, time.Now(), "FORECAST")
	if err != nil {
		t.Fatal(err)
	}

	all, err := st.ListRunRows(ctx, store.RunFilter{})
	if err != nil || len(all) != 2 {
		t.Fatalf("all = %v %v", all, err)
	}
	if all[0].ID != queued || all[0].RedMinutesP50 != nil || all[0].Status != "QUEUED" || all[0].ModelKey != "beta" {
		t.Fatalf("newest first = %+v", all[0])
	}
	if all[1].ID != done || all[1].RedMinutesP50 == nil || *all[1].RedMinutesP50 != 3 ||
		all[1].ScenarioName != "Ca sáng" || all[1].ModelKey != "alpha" || all[1].Version != 1 || all[1].VersionID != v1 {
		t.Fatalf("done row = %+v", all[1])
	}

	for name, tc := range map[string]struct {
		f    store.RunFilter
		want []int64
	}{
		"status":   {store.RunFilter{Statuses: []string{"DONE"}}, []int64{done}},
		"statuses": {store.RunFilter{Statuses: []string{"DONE", "QUEUED"}}, []int64{queued, done}},
		"model":    {store.RunFilter{Model: "alpha"}, []int64{done}},
		"version":  {store.RunFilter{VersionID: v2}, []int64{queued}},
		"page":     {store.RunFilter{Limit: 1, Offset: 1}, []int64{done}},
		"bogus":    {store.RunFilter{Statuses: []string{"BOGUS"}}, nil},
		"clamped":  {store.RunFilter{Limit: 100000, Offset: -5}, []int64{queued, done}},
	} {
		got, err := st.ListRunRows(ctx, tc.f)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if len(got) != len(tc.want) {
			t.Fatalf("%s: got %d rows, want %d", name, len(got), len(tc.want))
		}
		for i, id := range tc.want {
			if got[i].ID != id {
				t.Fatalf("%s: row %d = %d, want %d", name, i, got[i].ID, id)
			}
		}
	}
}

func TestListInsightRowsOnlyFromDoneRuns(t *testing.T) {
	st := testfix.Seeded(t, "store_insightrows")
	vid := seededVersion(t, st, "ins")
	sid, _ := st.CreateScenario(ctx, store.Scenario{ModelVersionID: vid, Name: "Ca sáng", HorizonS: 3600})
	doneRun(t, st, sid)
	if _, err := st.InsertRun(ctx, sid, time.Now(), "FORECAST"); err != nil { // QUEUED, không có insight
		t.Fatal(err)
	}

	all, err := st.ListInsightRows(ctx, "", "", 0)
	if err != nil || len(all) != 2 {
		t.Fatalf("all = %v %v", all, err)
	}
	red, _ := st.ListInsightRows(ctx, "RED_RISK", "", 10)
	if len(red) != 1 || red[0].ModelKey != "ins" || red[0].Version != 1 || red[0].ScenarioName != "Ca sáng" ||
		red[0].Probability == nil || *red[0].Probability != 0.5 || red[0].SubjectKey == nil || *red[0].SubjectKey != "S" {
		t.Fatalf("red = %+v", red)
	}
	if one, _ := st.ListInsightRows(ctx, "", "", 1); len(one) != 1 {
		t.Fatalf("limit = %v", one)
	}
	if none, _ := st.ListInsightRows(ctx, "", "ACK", 10); len(none) != 0 {
		t.Fatalf("ack = %v", none)
	}
}

func TestNodeTypeRowsAndDetailUsage(t *testing.T) {
	st := testfix.Seeded(t, "store_nt_usage")
	v1 := seededVersion(t, st, "nt")
	if _, err := st.Clone(ctx, v1); err != nil { // v2 nháp cũng dùng các node type này
		t.Fatal(err)
	}

	rows, err := st.ListNodeTypeRows(ctx)
	if err != nil || len(rows) != 14 {
		t.Fatalf("rows = %d %v", len(rows), err)
	}
	used := map[string]int{}
	for _, r := range rows {
		used[r.Code] = r.UsedInVersions
	}
	if used["RACK_WAREHOUSE"] != 2 || used["STAMP_PRESS"] != 0 {
		t.Fatalf("used = %v", used)
	}

	d, err := st.GetNodeTypeDetail(ctx, "RACK_WAREHOUSE")
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Usage.Versions) != 2 || d.Usage.Versions[0].Status != "PUBLISHED" || d.Usage.Versions[1].Status != "DRAFT" ||
		d.Usage.Versions[0].Nodes != 1 || d.Usage.Versions[0].ModelKey != "nt" || d.Name == "" || !d.IsBuiltin {
		t.Fatalf("detail = %+v", d)
	}
	unused, _ := st.GetNodeTypeDetail(ctx, "STAMP_PRESS")
	if unused.Usage.Versions == nil || len(unused.Usage.Versions) != 0 {
		t.Fatalf("unused usage = %#v", unused.Usage.Versions)
	}
	if _, err := st.GetNodeTypeDetail(ctx, "NOPE"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
}
