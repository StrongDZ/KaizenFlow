-- Single statement on purpose: a continuous aggregate cannot be created
-- inside a transaction block, and golang-migrate sends a multi-statement file
-- as one implicit transaction.
-- Data for Predict: only readings above the quality threshold, 1-minute buckets.
-- The 0.7 threshold is hard-coded; changing it means recreating the view.
CREATE MATERIALIZED VIEW gauge_1m WITH (timescaledb.continuous) AS
SELECT time_bucket('1 minute', ts) AS bucket, machine_id, gauge_id,
       avg(value) FILTER (WHERE quality >= 0.7) AS avg_v,
       min(v_min) FILTER (WHERE quality >= 0.7) AS min_v,
       max(v_max) FILTER (WHERE quality >= 0.7) AS max_v,
       avg(value)                               AS avg_v_all,  -- debug only, not for Predict
       count(*)   FILTER (WHERE quality >= 0.7) AS n_good,
       count(*)                                 AS n_all
FROM gauge_reading WHERE value IS NOT NULL
GROUP BY bucket, machine_id, gauge_id;
