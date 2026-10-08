package main

import (
	"context"
	"sync"
	"time"
)

// maxStillAge is the oldest frame a client can ask for, and how long an
// unused frame stays in memory.
const maxStillAge = time.Hour

// Stills keeps the frame pulled last from every camera, in memory only: the
// thumbnails of an overview need the look of a station, not the current
// frame, and pulling one frame from an RTSP camera costs seconds. Clients say
// how old a frame they accept; requests for the same camera share one pull.
type Stills struct {
	now  func() time.Time
	pull func(ctx context.Context, url string) ([]byte, error)

	mu      sync.Mutex
	frames  map[string]still
	pulling map[string]*stillPull
}

type still struct {
	raw []byte
	at  time.Time
}

type stillPull struct {
	done chan struct{}
	raw  []byte
	err  error
}

func NewStills(now func() time.Time, pull func(ctx context.Context, url string) ([]byte, error)) *Stills {
	return &Stills{now: now, pull: pull, frames: map[string]still{}, pulling: map[string]*stillPull{}}
}

// Get returns a frame of the camera that is at most maxAge old, pulling a
// new one when the kept one is older.
func (s *Stills) Get(ctx context.Context, url string, maxAge time.Duration) ([]byte, error) {
	s.mu.Lock()
	if kept, ok := s.frames[url]; ok && maxAge > 0 && s.now().Sub(kept.at) <= maxAge {
		s.mu.Unlock()
		return kept.raw, nil
	}
	pull, running := s.pulling[url]
	if !running {
		pull = &stillPull{done: make(chan struct{})}
		s.pulling[url] = pull
		// Not the context of the request: others may wait for this pull
		// after the first client left.
		go s.run(url, pull)
	}
	s.mu.Unlock()
	select {
	case <-pull.done:
		return pull.raw, pull.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (s *Stills) run(url string, pull *stillPull) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pull.raw, pull.err = s.pull(ctx, url)
	s.mu.Lock()
	delete(s.pulling, url)
	now := s.now()
	if pull.err == nil {
		s.frames[url] = still{raw: pull.raw, at: now}
	}
	for key, kept := range s.frames {
		if now.Sub(kept.at) > maxStillAge {
			delete(s.frames, key)
		}
	}
	s.mu.Unlock()
	close(pull.done)
}
