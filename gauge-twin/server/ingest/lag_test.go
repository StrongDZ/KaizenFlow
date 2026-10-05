package main

import (
	"context"
	"errors"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"
)

type fakeAdmin struct {
	ends map[int32]int64
	err  error
}

func (f *fakeAdmin) ListEndOffsets(_ context.Context, topics ...string) (kadm.ListedOffsets, error) {
	if f.err != nil {
		return nil, f.err
	}
	listed := kadm.ListedOffsets{topics[0]: {}}
	for partition, end := range f.ends {
		listed[topics[0]][partition] = kadm.ListedOffset{Topic: topics[0], Partition: partition, Offset: end}
	}
	return listed, nil
}

func TestLagIsTheDistanceFromTheCommittedOffsetToThePartitionEnd(t *testing.T) {
	gauge := prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "lag"}, []string{"topic", "partition"})
	admin := &fakeAdmin{ends: map[int32]int64{0: 1500, 1: 40, 2: 900}}
	committed := map[string]map[int32]kgo.EpochOffset{"t": {0: {Offset: 1000}, 1: {Offset: 40}}}

	// The consume loop is stuck: nothing is committed, the partition end moves on.
	if err := reportLag(context.Background(), admin, committed, "t", gauge); err != nil {
		t.Fatal(err)
	}
	if got := testutil.ToFloat64(gauge.WithLabelValues("t", "0")); got != 500 {
		t.Errorf("partition 0: %v, want 500", got)
	}
	if got := testutil.ToFloat64(gauge.WithLabelValues("t", "1")); got != 0 {
		t.Errorf("partition 1: %v, want 0", got)
	}
	if n := testutil.CollectAndCount(gauge); n != 2 {
		t.Errorf("%d series; partition 2 belongs to another replica", n)
	}

	// After a rebalance partition 0 is gone: its series must not linger.
	delete(committed["t"], 0)
	_ = reportLag(context.Background(), admin, committed, "t", gauge)
	if n := testutil.CollectAndCount(gauge); n != 1 {
		t.Errorf("%d series after the rebalance, want 1", n)
	}

	// A failed read keeps the last values instead of reporting 0.
	admin.err = errors.New("broker away")
	if err := reportLag(context.Background(), admin, committed, "t", gauge); err == nil {
		t.Error("expected the error")
	}
	if n := testutil.CollectAndCount(gauge); n != 1 {
		t.Errorf("%d series after a failed read, want 1", n)
	}
}

func TestPartitionLagIgnoresPartitionsWithoutACommittedOffsetAndNeverGoesNegative(t *testing.T) {
	lag := partitionLag(map[int32]kgo.EpochOffset{0: {Offset: -1}, 1: {Offset: 50}, 2: {Offset: 7}},
		map[int32]int64{0: 10, 1: 40})
	if len(lag) != 1 || lag[1] != 0 {
		t.Errorf("lag: %v", lag)
	}
}
