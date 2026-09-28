package simclient_test

import (
	"context"
	"errors"
	"io"
	"testing"

	"github.com/kaizenflow/api/internal/simapi"
	"github.com/kaizenflow/api/internal/simclient"
	"github.com/kaizenflow/api/internal/simfake"
)

var ctx = context.Background()

func TestClientAgainstFake(t *testing.T) {
	fake := simfake.New()
	defer fake.Close()
	c := simclient.New(fake.URL + "/")
	req := &simapi.RunRequest{RunID: 9, HorizonS: 60, Replications: 1}
	if err := c.Validate(ctx, req); err != nil {
		t.Fatal(err)
	}
	if err := c.StartRun(ctx, req); err != nil || len(fake.Requests()) != 1 {
		t.Fatalf("start: %v", err)
	}
	st, _ := c.Status(ctx, 9)
	if st.Status != "RUNNING" {
		t.Fatalf("first poll = %s", st.Status)
	}
	st, _ = c.Status(ctx, 9)
	res, err := c.Result(ctx, 9)
	if err != nil || st.Status != "DONE" || res.RunID != 9 || len(res.Signals) != 5000 || *res.Insights[0].SubjectKey != "S" {
		t.Fatalf("result: %v %+v", err, st)
	}
	rc, err := c.ExportCSV(ctx, 9)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(rc)
	rc.Close()
	if string(b) != "kind,time,rep,subject,name,value\n" {
		t.Fatalf("csv = %q", b)
	}
}

func TestValidateReturnsContractError(t *testing.T) {
	fake := simfake.New()
	defer fake.Close()
	fake.ValidateErr = &simapi.ContractError{Key: "S>OUT", Message: "lot too big"}
	err := simclient.New(fake.URL).Validate(ctx, &simapi.RunRequest{})
	var ce *simapi.ContractError
	if !errors.As(err, &ce) || ce.Key != "S>OUT" {
		t.Fatalf("err = %v", err)
	}
}

func TestUnreachable(t *testing.T) {
	if err := simclient.New("http://127.0.0.1:1").StartRun(ctx, &simapi.RunRequest{}); err == nil {
		t.Fatal("expected error")
	}
}
