-- +goose Up
-- Bước "Kết nối dữ liệu": mapping thuộc về mô hình (model_key), không thuộc version, để sửa/clone version không làm mất.
DROP TABLE data_binding;
CREATE TABLE data_binding (
  id         serial PRIMARY KEY,
  model_key  text NOT NULL,
  subject    text NOT NULL,                -- key node hoặc key edge
  signal     text NOT NULL,                -- tín hiệu chuẩn: state, level:RAW-01, moved, fleet…
  source     text NOT NULL,                -- nguồn/topic, hỗ trợ wildcard + và #
  json_path  text NOT NULL DEFAULT '',
  transform  jsonb NOT NULL DEFAULT '{}',  -- {scale, offset, enum, fields}
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model_key, subject, signal)
);

-- Đồ thị bản đồ AGV của mô hình: điểm (ngã tư, trạm, chỗ sạc) và làn.
CREATE TABLE agv_map (
  model_key  text PRIMARY KEY,
  graph      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Dữ liệu live dùng chung bảng time-series với dữ liệu mô phỏng (run_id IS NULL = thật, D7); model_key cho biết của mô hình nào.
ALTER TABLE signal ADD COLUMN model_key text;
ALTER TABLE event_log ADD COLUMN model_key text;
CREATE INDEX signal_live_idx ON signal (model_key, subject, name, time DESC) WHERE run_id IS NULL;
CREATE INDEX event_log_live_idx ON event_log (model_key, subject, time DESC) WHERE run_id IS NULL;

ALTER TABLE insight DROP CONSTRAINT insight_kind_check;
ALTER TABLE insight ADD CONSTRAINT insight_kind_check
  CHECK (kind IN ('RED_RISK','BOTTLENECK','FAULT_RISK','RECOMMENDATION','DRIFT'));

-- +goose Down
DELETE FROM insight WHERE kind = 'DRIFT';
ALTER TABLE insight DROP CONSTRAINT insight_kind_check;
ALTER TABLE insight ADD CONSTRAINT insight_kind_check
  CHECK (kind IN ('RED_RISK','BOTTLENECK','FAULT_RISK','RECOMMENDATION'));
DROP INDEX event_log_live_idx;
DROP INDEX signal_live_idx;
ALTER TABLE event_log DROP COLUMN model_key;
ALTER TABLE signal DROP COLUMN model_key;
DROP TABLE agv_map;
DROP TABLE data_binding;
CREATE TABLE data_binding (
  id        serial PRIMARY KEY,
  node_key  text NOT NULL,
  signal    text NOT NULL,
  topic     text NOT NULL,
  json_path text NOT NULL,
  transform jsonb NOT NULL DEFAULT '{}',
  enabled   boolean NOT NULL DEFAULT true
);
