-- station_config is the single source of truth for station configs; config
-- holds the StationConfig message of config.proto as JSON. published_version
-- is the last version confirmed as published (retained) on MQTT.
CREATE TABLE station_config (
  machine_id        text        PRIMARY KEY,
  config_version    integer     NOT NULL,
  config            jsonb       NOT NULL,
  published_version integer     NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- gauge becomes a view over station_config, so there is nothing to keep in sync.
DROP TABLE gauge;
CREATE VIEW gauge AS
SELECT sc.machine_id,
       g ->> 'gauge_id'            AS gauge_id,
       g ->> 'type'                AS type,
       COALESCE(g ->> 'unit', '')  AS unit,
       sc.config_version,
       g                           AS config,
       sc.updated_at
FROM station_config sc
CROSS JOIN LATERAL jsonb_array_elements(sc.config -> 'gauges') AS g;

-- One edge serves several machines.
ALTER TABLE edge_node ADD COLUMN machine_ids text[] NOT NULL DEFAULT '{}';

-- rejected_reading: one row per rejected Kafka record, unique on the record
-- position so that reprocessing a batch cannot duplicate it. A hypertable
-- cannot have a unique index without its time column, so this becomes a
-- plain table; the 30-day retention is a scheduled job instead of a policy.
DROP TABLE rejected_reading;
CREATE TABLE rejected_reading (
  rejected_at     timestamptz NOT NULL DEFAULT now(),
  reason          text        NOT NULL,
  detail          text,
  machine_id      text,
  edge_id         text,
  seq             bigint,
  kafka_topic     text        NOT NULL,
  kafka_partition integer     NOT NULL,
  kafka_offset    bigint      NOT NULL,
  payload         bytea,
  UNIQUE (kafka_topic, kafka_partition, kafka_offset)
);
CREATE INDEX rejected_reading_time_idx ON rejected_reading (rejected_at);
CREATE INDEX rejected_reading_machine_idx ON rejected_reading (machine_id, rejected_at DESC);

CREATE PROCEDURE purge_rejected_reading(job_id integer, config jsonb)
LANGUAGE sql AS $$
  DELETE FROM rejected_reading WHERE rejected_at < now() - interval '30 days';
$$;
SELECT add_job('purge_rejected_reading', interval '1 day');
