CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Machine catalogue.
CREATE TABLE machine (
  machine_id text        PRIMARY KEY,
  plant      text        NOT NULL,
  line       text        NOT NULL,
  name       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX machine_plant_line_idx ON machine (plant, line);

-- Current configuration of every gauge; config holds the Gauge message of
-- config.proto as JSON (roi, calib, rules).
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

-- Edge devices as last reported on the status topic.
CREATE TABLE edge_node (
  edge_id        text        PRIMARY KEY,
  machine_id     text,
  sw_version     text,
  config_version integer,
  status         text        NOT NULL DEFAULT 'unknown',
  last_seen      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX edge_node_machine_idx ON edge_node (machine_id);
