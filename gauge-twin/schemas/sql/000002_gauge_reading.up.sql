CREATE TABLE gauge_reading (
  ts            timestamptz NOT NULL,   -- window_end
  machine_id    text        NOT NULL,
  gauge_id      text        NOT NULL,
  value         double precision,
  v_min         double precision,
  v_max         double precision,
  n_frames      int,
  quality       real,
  flags         smallint[],
  edge_id       text,
  seq           bigint,
  model_version text,
  ingested_at   timestamptz DEFAULT now(),
  PRIMARY KEY (machine_id, gauge_id, ts)  -- idempotent: ON CONFLICT DO NOTHING
);
SELECT create_hypertable('gauge_reading', 'ts', chunk_time_interval => interval '1 day');
ALTER TABLE gauge_reading SET (timescaledb.compress, timescaledb.compress_segmentby = 'machine_id, gauge_id');
SELECT add_compression_policy('gauge_reading', interval '7 days');
