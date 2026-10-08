-- How long the history of a gauge is kept. Readings (one per window) for 30
-- days: enough to look into an incident, and the one-minute aggregate answers
-- anything older. The aggregate for 2 years. Both are background policies; to
-- change a period, remove the policy and add it again (see runbook).
-- The aggregate refreshes the last 2 hours only, so dropping old readings
-- does not empty its old buckets.
SELECT add_retention_policy('gauge_reading', INTERVAL '30 days');
SELECT add_retention_policy('gauge_1m', INTERVAL '2 years');
