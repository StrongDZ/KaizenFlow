package main

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestStillsKeepAFrameForAsLongAsTheClientAccepts(t *testing.T) {
	now := testNow
	var pulls atomic.Int32
	stills := NewStills(func() time.Time { return now }, func(context.Context, string) ([]byte, error) {
		return []byte{byte(pulls.Add(1))}, nil
	})
	get := func(url string, maxAge time.Duration) byte {
		t.Helper()
		raw, err := stills.Get(context.Background(), url, maxAge)
		if err != nil {
			t.Fatal(err)
		}
		return raw[0]
	}
	if got := get("a", time.Minute); got != 1 {
		t.Fatalf("first: frame %d", got)
	}
	now = now.Add(time.Minute)
	if got := get("a", time.Minute); got != 1 {
		t.Errorf("a minute old with a minute accepted: frame %d, want the kept one", got)
	}
	if got := get("a", 30*time.Second); got != 2 {
		t.Errorf("a minute old with 30 s accepted: frame %d, want a new one", got)
	}
	if got := get("a", 0); got != 3 {
		t.Errorf("no age accepted: frame %d, want a new one", got)
	}
	if got := get("b", time.Hour); got != 4 {
		t.Errorf("another camera: frame %d, want its own", got)
	}
	// A frame nobody refreshed for longer than the limit leaves the memory.
	now = now.Add(maxStillAge + time.Second)
	get("b", 0)
	stills.mu.Lock()
	_, kept := stills.frames["a"]
	stills.mu.Unlock()
	if kept {
		t.Error("the old frame of camera a is still kept")
	}
}

func TestStillsShareOnePullAndDoNotKeepAFailure(t *testing.T) {
	release := make(chan struct{})
	var pulls atomic.Int32
	fail := errors.New("camera unreachable")
	stills := NewStills(time.Now, func(context.Context, string) ([]byte, error) {
		<-release
		if pulls.Add(1) == 1 {
			return nil, fail
		}
		return []byte("ok"), nil
	})
	var wg sync.WaitGroup
	errs := make([]error, 5)
	for i := range errs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, errs[i] = stills.Get(context.Background(), "a", time.Minute)
		}()
	}
	// Every caller waits for the pull before it is let go.
	for {
		stills.mu.Lock()
		running := len(stills.pulling)
		stills.mu.Unlock()
		if running == 1 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	time.Sleep(20 * time.Millisecond)
	close(release)
	wg.Wait()
	for i, err := range errs {
		if !errors.Is(err, fail) {
			t.Errorf("caller %d: %v, want the failure of the shared pull", i, err)
		}
	}
	if raw, err := stills.Get(context.Background(), "a", time.Minute); err != nil || string(raw) != "ok" {
		t.Errorf("after a failure: %q, %v; want a new pull", raw, err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	slow := NewStills(time.Now, func(ctx context.Context, _ string) ([]byte, error) { <-ctx.Done(); return nil, ctx.Err() })
	if _, err := slow.Get(ctx, "a", 0); !errors.Is(err, context.Canceled) {
		t.Errorf("a client that left: %v, want its cancellation", err)
	}
}
