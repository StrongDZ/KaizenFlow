-- Messages ingest could not store, with the reason; kept for 30 days.
CREATE TABLE rejected_reading (
  rejected_at     timestamptz NOT NULL DEFAULT now(),
  reason          text        NOT NULL,
  detail          text,
  machine_id      text,
  edge_id         text,
  seq             bigint,
  kafka_topic     text,
  kafka_partition integer,
  kafka_offset    bigint,
  payload         bytea
);
SELECT create_hypertable('rejected_reading', 'rejected_at', chunk_time_interval => interval '1 day');
CREATE INDEX rejected_reading_machine_idx ON rejected_reading (machine_id, rejected_at DESC);
SELECT add_retention_policy('rejected_reading', interval '30 days');
