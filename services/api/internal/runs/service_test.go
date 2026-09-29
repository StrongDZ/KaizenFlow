package runs_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/kaizenflow/api/internal/runs"
	"github.com/kaizenflow/api/internal/simapi"
	"github.com/kaizenflow/api/internal/simclient"
	"github.com/kaizenflow/api/internal/simfake"
	"github.com/kaizenflow/api/internal/store"
	"github.com/kaizenflow/api/internal/testfix"
	"github.com/kaizenflow/api/internal/ws"
)

var ctx = context.Background()

func setup(t *testing.T, name string, publish bool) (*runs.Service, *simfake.Server, *store.Store, int64) {
	t.Helper()
	st := testfix.Seeded(t, name)
	vid, err := st.CreateModel(ctx, "m", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.ReplaceGraph(ctx, vid, testfix.MiniNodes(), testfix.MiniEdges(), nil); err != nil {
		t.Fatal(err)
	}
	if publish {
		_ = st.Publish(ctx, vid)
	}
	sid, _ := st.CreateScenario(ctx, store.Scenario{ModelVersionID: vid, HorizonS: 3600, Replications: 2})
	fake := simfake.New()
	t.Cleanup(fake.Close)
	svc := &runs.Service{Store: st, Sim: simclient.New(fake.URL), Hub: ws.NewHub(), Poll: 10 * time.Millisecond}
	return svc, fake, st, sid
}

func waitStatus(t *testing.T, st *store.Store, id int64, want string) *store.Run {
	t.Helper()
	for i := 0; i < 300; i++ {
		run, _ := st.GetRun(ctx, id)
		if run != nil && run.Status == want {
			return run
		}
		time.Sleep(10 * time.Millisecond)
	}
	run, _ := st.GetRun(ctx, id)
	t.Fatalf("run %d status = %+v, want %s", id, run, want)
	return nil
}

func TestStartPersistsResultAndBroadcasts(t *testing.T) {
	svc, fake, st, sid := setup(t, "runs_ok", true)
	msgs, unsub := svc.Hub.Subscribe()
	defer unsub()
	start := time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC)
	id, err := svc.Start(ctx, sid, start)
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, st, id, "DONE")
	req := fake.Requests()[0]
	if req.RunID != id || req.Seed != id || len(req.Pools) != 1 || !req.SimStart.Equal(start) {
		t.Fatalf("request = %+v", req)
	}
	ins, _ := st.ListInsights(ctx, id)
	if len(ins) != 2 {
		t.Fatalf("insights = %d", len(ins))
	}
	var got []string
	for len(got) < 2 {
		select {
		case m := <-msgs:
			got = append(got, string(m))
		case <-time.After(2 * time.Second):
			t.Fatalf("ws messages = %v", got)
		}
	}
	if !strings.Contains(got[1], `"DONE"`) {
		t.Fatalf("ws = %v", got)
	}
}

func TestStartRequiresPublished(t *testing.T) {
	svc, _, _, sid := setup(t, "runs_draft", false)
	if _, err := svc.Start(ctx, sid, time.Now()); !errors.Is(err, runs.ErrNotPublished) {
		t.Fatalf("err = %v", err)
	}
}

func TestSimFailureAndUnreachableMarkFailed(t *testing.T) {
	svc, fake, st, sid := setup(t, "runs_fail", true)
	fake.FailRuns = true
	id, _ := svc.Start(ctx, sid, time.Now())
	if run := waitStatus(t, st, id, "FAILED"); *run.Error != "boom" {
		t.Fatalf("error = %v", *run.Error)
	}
	svc.Sim = simclient.New("http://127.0.0.1:1")
	id, _ = svc.Start(ctx, sid, time.Now())
	if run := waitStatus(t, st, id, "FAILED"); !strings.Contains(*run.Error, "sim-service") {
		t.Fatalf("error = %v", *run.Error)
	}
}

func TestApplyCreatesChildScenarioWithParentSeed(t *testing.T) {
	svc, fake, st, sid := setup(t, "runs_apply", true)
	base, _ := svc.Start(ctx, sid, time.Now())
	waitStatus(t, st, base, "DONE")
	ins, _ := st.ListInsights(ctx, base)
	if _, err := svc.Apply(ctx, ins[0].ID, 1); !errors.Is(err, runs.ErrNotRecommendation) {
		t.Fatalf("apply on RED_RISK: %v", err)
	}
	child, err := svc.Apply(ctx, ins[1].ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, st, child, "DONE")
	req := fake.Requests()[1]
	if req.Seed != base || req.Pools[0].Count != 3 || req.Recommend {
		t.Fatalf("child request seed=%d pools=%+v recommend=%v", req.Seed, req.Pools, req.Recommend)
	}
	run, _ := st.GetRun(ctx, child)
	sc, _ := st.GetScenario(ctx, run.ScenarioID)
	if sc.Origin != "RECOMMENDER" || *sc.ParentID != sid || sc.Action["type"] != "FLEET_SIZE" {
		t.Fatalf("child scenario = %+v", sc)
	}
}

func TestSimLosingRunFailsFast(t *testing.T) {
	svc, fake, st, sid := setup(t, "runs_lost", true)
	svc.Poll = 50 * time.Millisecond
	id, _ := svc.Start(ctx, sid, time.Now())
	for len(fake.Requests()) == 0 {
		time.Sleep(5 * time.Millisecond)
	}
	fake.Forget(id)
	if run := waitStatus(t, st, id, "FAILED"); !strings.Contains(*run.Error, "lost") {
		t.Fatalf("error = %v", *run.Error)
	}
}

func TestRecoverResumesOrFailsActiveRuns(t *testing.T) {
	svc, fake, st, sid := setup(t, "runs_recover", true)
	// run A: sim-service vẫn biết run → tiếp tục poll đến DONE
	a, _ := st.InsertRun(ctx, sid, time.Now(), "FORECAST")
	_ = st.SetRunStatus(ctx, a, "RUNNING", nil)
	if err := svc.Sim.StartRun(ctx, &simapi.RunRequest{RunID: a}); err != nil {
		t.Fatal(err)
	}
	// run B: sim-service không biết (đã restart) → FAILED
	b, _ := st.InsertRun(ctx, sid, time.Now(), "FORECAST")
	_ = fake // run B never reaches the fake
	if err := svc.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	waitStatus(t, st, a, "DONE")
	if run := waitStatus(t, st, b, "FAILED"); !strings.Contains(*run.Error, "lost") {
		t.Fatalf("error = %v", *run.Error)
	}
}
