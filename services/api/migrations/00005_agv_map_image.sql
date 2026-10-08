-- +goose Up
-- Ảnh mặt bằng làm nền cho bản đồ AGV (tải lên từ trang Bản đồ). Chỗ đặt và tỉ lệ nằm trong JSON bản đồ (trường bg).
CREATE TABLE agv_map_image (
  model_key  text        PRIMARY KEY,
  mime       text        NOT NULL CHECK (mime IN ('image/png', 'image/jpeg')),
  data       bytea       NOT NULL,
  width      int         NOT NULL CHECK (width > 0),
  height     int         NOT NULL CHECK (height > 0),
  rev        bigint      NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE agv_map_image;
