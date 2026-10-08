-- Cameras as their own resource: a camera is defined once and the gauges of
-- any machine refer to it by camera_id. config-api copies the url into the
-- station configs it publishes, so the edge needs no access to this table.
CREATE TABLE camera (
  camera_id  text        PRIMARY KEY,
  name       text        NOT NULL DEFAULT '',
  location   text        NOT NULL DEFAULT '',
  url        text        NOT NULL,
  sample_fps integer     NOT NULL DEFAULT 2,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
