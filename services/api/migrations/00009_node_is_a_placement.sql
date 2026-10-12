-- +goose Up
-- Giai đoạn 2 của tách thiết bị / chỗ đặt.
--
-- `node` giờ chỉ còn là CHỖ ĐẶT một thiết bị trong một version: nó không tự khai loại, vai trò hay
-- tên nữa — ba thứ đó thuộc về thiết bị (`asset`), nên bỏ đi để không còn hai nguồn sự thật.
-- Khoá ngoại `node.key -> asset.key` để chính DB bảo đảm "node là một thiết bị đã khai".
--
-- `node.params` thì GIỮ, và đây là chủ ý: nó là phần đông cứng của một version. Publish phải bất
-- biến (chạy lại scenario cũ ra đúng số cũ), nên lúc Publish, tham số hiệu lực của thiết bị được
-- ghi vào đây; sau đó sửa `asset.params` không làm đổi đầu vào của version đã Publish.
-- Bản DRAFT thì ngược lại: `node.params` để trống và tham số đọc trực tiếp từ thiết bị, nên sửa
-- thiết bị là thấy ngay trên sơ đồ đang dựng.

-- Thiết bị cho các node còn sót chưa có trong danh mục (DB cũ chưa qua 00008 đủ).
INSERT INTO asset (key, node_type_id, name)
SELECT DISTINCT ON (n.key) n.key, n.node_type_id, coalesce(n.name, '')
FROM node n
ORDER BY n.key, n.id
ON CONFLICT (key) DO NOTHING;

-- Đông cứng tham số thiết bị vào các version ĐÃ PUBLISH/ARCHIVED để chúng không đổi khi sửa thiết bị.
-- `asset.params` nằm dưới `node.params` đúng thứ tự hợp nhất của resolve.
UPDATE node n SET params = a.params || n.params
FROM asset a, model_version v
WHERE a.key = n.key AND v.id = n.model_version_id AND v.status <> 'DRAFT' AND a.params <> '{}'::jsonb;

ALTER TABLE node
  DROP COLUMN node_type_id,
  DROP COLUMN archetype,
  DROP COLUMN name,
  ADD CONSTRAINT node_key_is_an_asset FOREIGN KEY (key) REFERENCES asset (key);
CREATE INDEX node_key_idx ON node (key);

-- Tín hiệu live của một THIẾT BỊ lưu một lần (model_key = '') thay vì một bản cho mỗi mô hình dùng
-- nó; tín hiệu của ĐƯỜNG NỐI vẫn theo mô hình. Gom các bản trùng về một, giữ bản xuất hiện trước.
DELETE FROM signal s USING signal k
WHERE s.run_id IS NULL AND k.run_id IS NULL
  AND s.subject IN (SELECT key FROM asset)
  AND k.subject = s.subject AND k.name = s.name AND k.time = s.time
  AND k.model_key < s.model_key;
UPDATE signal SET model_key = '' WHERE run_id IS NULL AND subject IN (SELECT key FROM asset);

DELETE FROM event_log e USING event_log k
WHERE e.run_id IS NULL AND k.run_id IS NULL
  AND e.subject IN (SELECT key FROM asset)
  AND k.subject = e.subject AND k.type = e.type AND k.time = e.time
  AND k.model_key < e.model_key;
UPDATE event_log SET model_key = '' WHERE run_id IS NULL AND subject IN (SELECT key FROM asset);

-- +goose Down
-- Trả tín hiệu live của thiết bị về từng mô hình đang chứa nó.
INSERT INTO signal (time, model_key, subject, name, value)
SELECT s.time, v.model_key, s.subject, s.name, s.value
FROM signal s JOIN node n ON n.key = s.subject JOIN model_version v ON v.id = n.model_version_id
WHERE s.run_id IS NULL AND s.model_key = ''
GROUP BY s.time, v.model_key, s.subject, s.name, s.value;
DELETE FROM signal WHERE run_id IS NULL AND model_key = '';

INSERT INTO event_log (time, model_key, subject, type, payload)
SELECT e.time, v.model_key, e.subject, e.type, e.payload
FROM event_log e JOIN node n ON n.key = e.subject JOIN model_version v ON v.id = n.model_version_id
WHERE e.run_id IS NULL AND e.model_key = ''
GROUP BY e.time, v.model_key, e.subject, e.type, e.payload;
DELETE FROM event_log WHERE run_id IS NULL AND model_key = '';

DROP INDEX node_key_idx;
ALTER TABLE node
  DROP CONSTRAINT node_key_is_an_asset,
  ADD COLUMN node_type_id int REFERENCES node_type,
  ADD COLUMN archetype archetype,
  ADD COLUMN name text;
UPDATE node n SET node_type_id = a.node_type_id, archetype = t.archetype, name = nullif(a.name, '')
FROM asset a JOIN node_type t ON t.id = a.node_type_id WHERE a.key = n.key;
ALTER TABLE node ALTER COLUMN node_type_id SET NOT NULL, ALTER COLUMN archetype SET NOT NULL;
