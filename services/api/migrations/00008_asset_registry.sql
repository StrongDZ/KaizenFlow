-- +goose Up
-- Danh mục thiết bị (asset): một thiết bị thật của nhà máy, định danh DUY NHẤT toàn app.
-- `node_type` vẫn là lớp trừu tượng (một loại); `asset` là một thiết bị cụ thể; node trong một
-- version mô hình chỉ còn là chỗ ĐẶT thiết bị đó (vị trí trên sơ đồ + override tham số nếu cần).
-- Nhờ vậy một thiết bị dùng được ở nhiều mô hình mà chỉ khai tham số và ghép tín hiệu một lần.
-- plant/line là phạm vi để hiển thị và để khớp với bảng `machine` của gauge-twin (machine_id = asset.key).
CREATE TABLE asset (
  key          text        PRIMARY KEY,
  plant        text        NOT NULL DEFAULT '',
  line         text        NOT NULL DEFAULT '',
  node_type_id int         NOT NULL REFERENCES node_type,
  name         text        NOT NULL DEFAULT '',
  params       jsonb       NOT NULL DEFAULT '{}',
  note         text        NOT NULL DEFAULT '',
  retired      boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX asset_plant_line_idx ON asset (plant, line);

-- Khai sinh thiết bị từ node đã có. Key trùng ở nhiều mô hình được hiểu là CÙNG một thiết bị
-- (đúng với denso-plant / denso-plant-amr: cùng nhà máy, khác cách chạy xe).
INSERT INTO asset (key, node_type_id, name)
SELECT DISTINCT ON (n.key) n.key, n.node_type_id, coalesce(n.name, '')
FROM node n
ORDER BY n.key, n.id
ON CONFLICT (key) DO NOTHING;

-- Ghép nối tín hiệu của THIẾT BỊ trở thành toàn cục: model_key = '' nghĩa là áp cho mọi mô hình
-- có thiết bị đó. Ghép nối của ĐƯỜNG NỐI vẫn thuộc mô hình, vì một đường nối chỉ tồn tại trong
-- một bố trí cụ thể, không phải một thiết bị.
DELETE FROM data_binding b USING data_binding k
WHERE b.subject IN (SELECT key FROM asset)
  AND k.subject = b.subject AND k.signal = b.signal AND k.id < b.id;
UPDATE data_binding SET model_key = '' WHERE subject IN (SELECT key FROM asset);

-- +goose Down
-- Trả ghép nối toàn cục về từng mô hình đang chứa thiết bị đó.
INSERT INTO data_binding (model_key, subject, signal, source, json_path, transform, enabled, mode, derive)
SELECT DISTINCT v.model_key, b.subject, b.signal, b.source, b.json_path, b.transform, b.enabled, b.mode, b.derive
FROM data_binding b
JOIN node n ON n.key = b.subject
JOIN model_version v ON v.id = n.model_version_id
WHERE b.model_key = ''
ON CONFLICT (model_key, subject, signal) DO NOTHING;
DELETE FROM data_binding WHERE model_key = '';
DROP TABLE asset;
