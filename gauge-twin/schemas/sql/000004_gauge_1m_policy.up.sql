-- start_offset of 2 hours recomputes buckets touched by data replayed from the
-- edge offline buffer. Outages longer than that need a manual
-- refresh_continuous_aggregate call (see runbook).
SELECT add_continuous_aggregate_policy('gauge_1m',
  start_offset => INTERVAL '2 hours',
  end_offset   => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute');
