-- +goose Up
-- Nguồn dữ liệu (thiết bị, topic) của từng mô hình: sống sót qua việc khởi động lại API và tắt feed,
-- để trang "Nguồn dữ liệu" và hộp Ghép nối luôn có danh sách để chọn.
CREATE TABLE data_source (
  model_key   text        NOT NULL,
  source      text        NOT NULL,
  description text        NOT NULL DEFAULT '',
  origin      text        NOT NULL DEFAULT 'feed' CHECK (origin IN ('feed', 'manual')),
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  msg_count   bigint      NOT NULL DEFAULT 0,
  sample      jsonb,
  PRIMARY KEY (model_key, source)
);

-- +goose Down
DROP TABLE data_source;
