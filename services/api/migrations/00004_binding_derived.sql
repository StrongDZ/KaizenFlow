-- +goose Up
-- Ghép nối tự tính: một tín hiệu có thể lấy giá trị từ trường của một nguồn (source) hoặc được tính từ các tín hiệu khác trong
-- sơ đồ (derived). Ghép nối tự tính không có nguồn; công thức nằm trong cột derive.
ALTER TABLE data_binding
  ADD COLUMN mode   text NOT NULL DEFAULT 'source' CHECK (mode IN ('source', 'derived')),
  ADD COLUMN derive jsonb,
  ADD CONSTRAINT data_binding_mode_shape CHECK ((mode = 'source' AND source <> '') OR (mode = 'derived' AND derive IS NOT NULL));

-- +goose Down
ALTER TABLE data_binding DROP CONSTRAINT data_binding_mode_shape, DROP COLUMN derive, DROP COLUMN mode;
