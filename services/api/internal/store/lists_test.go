package store_test

import (
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
