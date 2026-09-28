-- +goose Up
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TYPE archetype AS ENUM ('SOURCE','STORAGE','PROCESS','SINK','RESOURCE_POOL');

CREATE TABLE material (
  id        serial PRIMARY KEY,
  code      text UNIQUE NOT NULL,
  name      text,
  unit      text NOT NULL DEFAULT 'pcs',
  unit_load int,
  attrs     jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE node_type (
  id             serial PRIMARY KEY,
  code           text UNIQUE NOT NULL,
  name           text NOT NULL,
  archetype      archetype NOT NULL,
  param_schema   jsonb NOT NULL,
  default_params jsonb NOT NULL DEFAULT '{}',
  signals        jsonb NOT NULL DEFAULT '[]',
  failure_modes  jsonb NOT NULL DEFAULT '[]',
  ui             jsonb NOT NULL DEFAULT '{}',
  is_builtin     boolean NOT NULL DEFAULT false
);

CREATE TABLE model_version (
  id         serial PRIMARY KEY,
  model_key  text NOT NULL,
  version    int  NOT NULL,
  status     text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  settings   jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model_key, version)
);

CREATE TABLE node (
  id               serial PRIMARY KEY,
  model_version_id int NOT NULL REFERENCES model_version ON DELETE CASCADE,
  key              text NOT NULL,
  node_type_id     int NOT NULL REFERENCES node_type,
  archetype        archetype NOT NULL,
  name             text,
  params           jsonb NOT NULL DEFAULT '{}',
  canvas_pos       jsonb,
  UNIQUE (model_version_id, key)
);

CREATE TABLE edge (
  id               serial PRIMARY KEY,
  model_version_id int NOT NULL REFERENCES model_version ON DELETE CASCADE,
  key              text NOT NULL,
  src_node_id      int NOT NULL REFERENCES node ON DELETE CASCADE,
  src_port         text NOT NULL DEFAULT 'out',
  dst_node_id      int NOT NULL REFERENCES node ON DELETE CASCADE,
  dst_port         text NOT NULL DEFAULT 'in',
  material_id      int REFERENCES material,
  params           jsonb NOT NULL DEFAULT '{}',
  UNIQUE (model_version_id, key)
);

CREATE TABLE data_binding (
  id        serial PRIMARY KEY,
  node_key  text NOT NULL,
  signal    text NOT NULL,
  topic     text NOT NULL,
  json_path text NOT NULL,
  transform jsonb NOT NULL DEFAULT '{}',
  enabled   boolean NOT NULL DEFAULT true
);

CREATE TABLE scenario (
  id               serial PRIMARY KEY,
  model_version_id int NOT NULL REFERENCES model_version,
  parent_id        int REFERENCES scenario,
  origin           text NOT NULL DEFAULT 'USER' CHECK (origin IN ('USER','RECOMMENDER','NOWCAST')),
  name             text,
  horizon          interval NOT NULL,
  start_state      text NOT NULL DEFAULT 'WARMUP' CHECK (start_state IN ('EMPTY','WARMUP','LIVE_SNAPSHOT')),
  overrides        jsonb NOT NULL DEFAULT '[]',
  injections       jsonb NOT NULL DEFAULT '[]',
  action           jsonb,
  replications     int NOT NULL DEFAULT 50,
  seed             bigint,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sim_run (
  id             bigserial PRIMARY KEY,
  scenario_id    int NOT NULL REFERENCES scenario,
  purpose        text NOT NULL DEFAULT 'FORECAST' CHECK (purpose IN ('FORECAST','SYNTHETIC','BACKTEST')),
  status         text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','DONE','FAILED')),
  sim_start      timestamptz NOT NULL,
  initial_state  jsonb,
  kpis           jsonb,
  error          text,
  engine_version text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);

CREATE TABLE insight (
  id          bigserial PRIMARY KEY,
  sim_run_id  bigint REFERENCES sim_run,
  kind        text NOT NULL CHECK (kind IN ('RED_RISK','BOTTLENECK','FAULT_RISK','RECOMMENDATION')),
  subject_key text,
  eta         timestamptz,
  probability real,
  severity    smallint,
  payload     jsonb NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACK','DONE')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE signal (
  time    timestamptz NOT NULL,
  run_id  bigint,
  rep     smallint NOT NULL DEFAULT 0,
  subject text NOT NULL,
  name    text NOT NULL,
  value   double precision
);
SELECT create_hypertable('signal', 'time');
CREATE INDEX ON signal (run_id, subject, name, time DESC);

CREATE TABLE event_log (
  time    timestamptz NOT NULL,
  run_id  bigint,
  rep     smallint NOT NULL DEFAULT 0,
  subject text NOT NULL,
  type    text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'
);
SELECT create_hypertable('event_log', 'time');
CREATE INDEX ON event_log (run_id, subject, time DESC);

CREATE TABLE forecast_band (
  issued_at   timestamptz NOT NULL,
  target_time timestamptz NOT NULL,
  producer    text NOT NULL,
  ref_id      bigint,
  subject     text NOT NULL,
  metric      text NOT NULL,
  p10 real, p50 real, p90 real
);
SELECT create_hypertable('forecast_band', 'target_time');
CREATE INDEX ON forecast_band (subject, metric, producer, issued_at DESC);
CREATE INDEX ON forecast_band (ref_id, subject, metric, target_time);

-- +goose Down
DROP TABLE IF EXISTS forecast_band, event_log, signal, insight, sim_run, scenario, data_binding,
  edge, node, model_version, node_type, material;
DROP TYPE IF EXISTS archetype;
