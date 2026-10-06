package store_test

import (
	"errors"
	"testing"
	"time"

	"github.com/kaizenflow/api/internal/store"
	"github.com/kaizenflow/api/internal/testfix"
)

func TestUpdateScenarioOnlyWithoutRuns(t *testing.T) {
	st := testfix.Seeded(t, "store_sc_update")
	vid := seededVersion(t, st, "up")
	sid, _ := st.CreateScenario(ctx, store.Scenario{ModelVersionID: vid, Name: "cũ", HorizonS: 3600})

	err := st.UpdateScenario(ctx, sid, store.Scenario{Name: "mới", HorizonS: 7200, Replications: 10,
		Injections: []map[string]any{{"target": "P", "failure": "bearing_wear", "at_s": 600.0}}})
	if err != nil {
		t.Fatal(err)
	}
	sc, _ := st.GetScenario(ctx, sid)
	if sc.Name != "mới" || sc.HorizonS != 7200 || sc.Replications != 10 || sc.StartState != "WARMUP" ||
		len(sc.Injections) != 1 || sc.Overrides == nil || sc.ModelVersionID != vid || sc.Origin != "USER" {
		t.Fatalf("scenario = %+v", sc)
	}

	doneRun(t, st, sid)
	var lk *store.LockedError
	err = st.UpdateScenario(ctx, sid, store.Scenario{Name: "lại", HorizonS: 60})
	if !errors.As(err, &lk) {
		t.Fatalf("with a run: %v", err)
	}
	if usage, ok := lk.Usage.(map[string]int); !ok || usage["runs"] != 1 {
		t.Fatalf("usage = %#v", lk.Usage)
	}
	if got, _ := st.GetScenario(ctx, sid); got.Name != "mới" {
		t.Fatalf("locked update changed the scenario: %+v", got)
	}
	if err := st.UpdateScenario(ctx, 999999, store.Scenario{HorizonS: 60}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown: %v", err)
	}
}

func TestCloneScenarioCopiesSpecButNotLineage(t *testing.T) {
	st := testfix.Seeded(t, "store_sc_clone")
	vid := seededVersion(t, st, "cl")
	parent, _ := st.CreateScenario(ctx, store.Scenario{ModelVersionID: vid, Name: "gốc", HorizonS: 3600})
	seed := int64(42)
	src, err := st.CreateScenario(ctx, store.Scenario{ModelVersionID: vid, Name: "Ca sáng", HorizonS: 5400, Replications: 7,
		StartState: "EMPTY", Origin: "RECOMMENDER", ParentID: &parent, Seed: &seed,
		Action:     map[string]any{"type": "FLEET_SIZE"},
		Overrides:  []map[string]any{{"target": "TUG", "path": "/count", "value": 3.0}},
		Injections: []map[string]any{{"target": "P", "failure": "x", "at_s": 60.0}}})
	if err != nil {
		t.Fatal(err)
	}
	id, err := st.CloneScenario(ctx, src)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := st.GetScenario(ctx, id)
	if id == src || got.Name != "Ca sáng (bản sao)" || got.Origin != "USER" || got.ParentID != nil || got.Action != nil ||
		got.Seed == nil || *got.Seed != 42 || got.HorizonS != 5400 || got.Replications != 7 || got.StartState != "EMPTY" ||
		len(got.Overrides) != 1 || len(got.Injections) != 1 || got.ModelVersionID != vid {
		t.Fatalf("clone = %+v", got)
	}
	blank, _ := st.CreateScenario(ctx, store.Scenario{ModelVersionID: vid, HorizonS: 60})
	bid, _ := st.CloneScenario(ctx, blank)
	if b, _ := st.GetScenario(ctx, bid); b.Name == "" || b.Name == " (bản sao)" {
		t.Fatalf("blank-name clone = %q", b.Name)
	}
	fromRun, _ := st.CreateScenario(ctx, store.Scenario{ModelVersionID: vid, Name: "seed từ run", HorizonS: 60})
	runID, _ := st.InsertRun(ctx, fromRun, time.Now(), "FORECAST")
	fromRunClone, _ := st.CloneScenario(ctx, fromRun)
	if cloned, _ := st.GetScenario(ctx, fromRunClone); cloned.Seed == nil || *cloned.Seed != runID {
		t.Fatalf("clone seed = %v, want effective seed from latest run %d", cloned.Seed, runID)
	}
	if _, err := st.CloneScenario(ctx, 999999); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown: %v", err)
	}
}
