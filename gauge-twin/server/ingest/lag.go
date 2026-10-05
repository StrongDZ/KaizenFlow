package main

import (
	"context"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"
)

// endOffsetLister is the part of the Kafka admin client reportLag needs.
type endOffsetLister interface {
	ListEndOffsets(ctx context.Context, topics ...string) (kadm.ListedOffsets, error)
}

// partitionLag computes, for every partition this replica has a committed
// offset for, the records between that offset and the end of the partition.
func partitionLag(committed map[int32]kgo.EpochOffset, ends map[int32]int64) map[int32]int64 {
	lag := make(map[int32]int64, len(committed))
	for partition, offset := range committed {
		end, ok := ends[partition]
		if !ok || offset.Offset < 0 {
			continue
		}
		lag[partition] = max(end-offset.Offset, 0)
	}
	return lag
}

// reportLag sets kafka_consumer_lag for the partitions of this replica from
// the end offsets the broker reports. Partitions the replica no longer owns
// are dropped, so the sum over all replicas is the lag of the group.
func reportLag(ctx context.Context, admin endOffsetLister, committed map[string]map[int32]kgo.EpochOffset, topic string, gauge *prometheus.GaugeVec) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	listed, err := admin.ListEndOffsets(ctx, topic)
	if err != nil {
		return err
	}
	ends := map[int32]int64{}
	listed.Each(func(o kadm.ListedOffset) {
		if o.Err == nil {
			ends[o.Partition] = o.Offset
		}
	})
	gauge.Reset()
	for partition, lag := range partitionLag(committed[topic], ends) {
		gauge.WithLabelValues(topic, strconv.Itoa(int(partition))).Set(float64(lag))
	}
	return nil
}
