-- Gauges found on camera frames by discover-svc. A detection where no gauge
-- is declared becomes a candidate; a person checks its region on the camera
-- page and assigns it to a machine (the candidate is then accepted) or marks
-- it as no gauge to read (ignored, never proposed again).
CREATE TABLE gauge_candidate (
  candidate_id bigserial   PRIMARY KEY,
  camera_id    text        NOT NULL,
  roi          int[]       NOT NULL,              -- x, y, w, h in pixels of the camera frame
  type         text        NOT NULL,              -- gauge type the detector suggests
  score        real        NOT NULL,              -- best detector score so far
  hint         jsonb       NOT NULL DEFAULT '{}', -- suggested calib (dial points, digit count, colour)
  crop_jpeg    bytea,                             -- the region on the last frame it was seen on
  seen         int         NOT NULL DEFAULT 1,    -- scans that found it
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now(),
  status       text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'ignored')),
  machine_id   text,                              -- set when accepted: the gauge it became
  gauge_id     text,
  decided_at   timestamptz
);
CREATE INDEX gauge_candidate_camera ON gauge_candidate (camera_id);

-- The last scan of every camera, and the last scan that still found each
-- declared gauge: a gauge found before and missing from later scans has been
-- removed, covered or the camera turned.
CREATE TABLE camera_scan (
  camera_id  text        PRIMARY KEY,
  scanned_at timestamptz NOT NULL,
  width      int         NOT NULL,
  height     int         NOT NULL,
  detections int         NOT NULL
);
CREATE TABLE gauge_sighting (
  machine_id text        NOT NULL,
  gauge_id   text        NOT NULL,
  last_seen  timestamptz NOT NULL,
  PRIMARY KEY (machine_id, gauge_id)
);
