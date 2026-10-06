package sim

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// Run simulates the whole fleet until cfg.Duration elapses or ctx is
// cancelled, then shuts every edge down gracefully and returns the totals.
func Run(ctx context.Context, cfg Config, tr Transport, seqlog *SeqLog, m *Metrics, logger *slog.Logger) (Summary, error) {
	if err := cfg.Validate(); err != nil {
		return Summary{}, err
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	if cfg.Duration > 0 {
		var stop context.CancelFunc
		if cfg.Linger > 0 {
			cfg.produceUntil = time.Now().Add(cfg.Duration)
		}
		runCtx, stop = context.WithTimeout(runCtx, cfg.Duration+cfg.Linger)
		defer stop()
	}

	edges := cfg.Edges()
	logger.Info("simulation starting", "machines", cfg.Machines, "edges", edges,
		"window", cfg.Window.String(), "duration", cfg.Duration.String(), "faults", cfg.Faults.String(),
		"fault_rate", cfg.FaultRate)

	stats := &Stats{}
	var wg sync.WaitGroup
	for i := 0; i < edges; i++ {
		edge := newEdge(cfg, i, tr, seqlog, m, stats, logger)
		delay := time.Duration(int64(cfg.Ramp) * int64(i) / int64(edges))
		wg.Add(1)
		go func() {
			defer wg.Done()
			edge.Run(runCtx, delay)
		}()
	}

	// Keep the sequence log reasonably fresh on disk while running.
	flushDone := make(chan struct{})
	go func() {
		defer close(flushDone)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-ticker.C:
				_ = seqlog.Flush()
			}
		}
	}()

	<-runCtx.Done()
	logger.Info("simulation stopping, draining buffers")
	wg.Wait()
	<-flushDone
	err := seqlog.Flush()
	summary := stats.Snapshot()
	logger.Info("simulation finished", "acked", summary.Acked, "replayed", summary.Replayed,
		"unacked", summary.Unacked, "dropped", summary.Dropped, "publish_errors", summary.PublishErrors,
		"connect_errors", summary.ConnectErrors, "reconnects", summary.Reconnects, "faults", summary.Faults,
		"resent", summary.Resent)
	return summary, err
}
