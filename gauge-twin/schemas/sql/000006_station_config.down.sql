SELECT delete_job(job_id) FROM timescaledb_information.jobs WHERE proc_name = 'purge_rejected_reading';
DROP PROCEDURE IF EXISTS purge_rejected_reading(integer, jsonb);
DROP TABLE IF EXISTS rejected_reading;
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

ALTER TABLE edge_node DROP COLUMN IF EXISTS machine_ids;

DROP VIEW IF EXISTS gauge;
CREATE TABLE gauge (
  machine_id     text        NOT NULL REFERENCES machine (machine_id) ON DELETE CASCADE,
  gauge_id       text        NOT NULL,
  type           text        NOT NULL,
  unit           text        NOT NULL DEFAULT '',
  config_version integer     NOT NULL,
  config         jsonb       NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (machine_id, gauge_id)
);

DROP TABLE IF EXISTS station_config;
