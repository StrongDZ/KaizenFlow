-- +goose Up
-- Nguồn dữ liệu là MỘT THIẾT BỊ/TOPIC ngoài đời, không thuộc mô hình nào: `plc/prs-02/status` chỉ
-- tồn tại một cái. Trước đây bảng khoá theo (model_key, source) nên cùng một topic đăng ký lại ở
-- mỗi mô hình, mỗi hàng một `last_seen` và `msg_count` riêng — cùng kiểu trùng lặp đã bỏ ở
-- data_binding và signal. Giờ khoá theo `source`; "mô hình nào đang dùng nguồn này" suy ra từ
-- ghép nối, không lưu lại.
--
-- Việc lô bản tin của một feed chỉ áp cho đúng mô hình của nó KHÔNG do bảng này bảo đảm, mà do
-- IngestFor(model, …) lọc nhóm ghép nối theo mô hình — nên gộp bảng không làm hai feed lẫn nhau.

-- Gộp các hàng trùng: cộng dồn số bản tin, giữ lần đầu sớm nhất và lần cuối muộn nhất, lấy mô tả
-- và bản tin mẫu của hàng mới nhất, và manual thắng feed (người đã khai tay thì giữ là manual).
CREATE TABLE data_source_merged AS
SELECT source,
       (SELECT d2.description FROM data_source d2 WHERE d2.source = d.source AND d2.description <> ''
        ORDER BY d2.last_seen DESC LIMIT 1) AS description,
       CASE WHEN bool_or(origin = 'manual') THEN 'manual' ELSE 'feed' END AS origin,
       min(first_seen) AS first_seen,
       max(last_seen)  AS last_seen,
       sum(msg_count)  AS msg_count,
       (SELECT d3.sample FROM data_source d3 WHERE d3.source = d.source AND d3.sample IS NOT NULL
        ORDER BY d3.last_seen DESC LIMIT 1) AS sample
FROM data_source d GROUP BY source;

DROP TABLE data_source;
CREATE TABLE data_source (
  source      text        PRIMARY KEY,
  description text        NOT NULL DEFAULT '',
  origin      text        NOT NULL DEFAULT 'feed' CHECK (origin IN ('feed', 'manual')),
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  msg_count   bigint      NOT NULL DEFAULT 0,
  sample      jsonb
);
INSERT INTO data_source (source, description, origin, first_seen, last_seen, msg_count, sample)
SELECT source, coalesce(description, ''), origin, first_seen, last_seen, msg_count, sample FROM data_source_merged;
DROP TABLE data_source_merged;

-- +goose Down
-- Trả nguồn về từng mô hình đang có ghép nối dùng nguồn đó (nguồn chưa ghép ở đâu thì mất, vì
-- bảng cũ không có chỗ cho nguồn không thuộc mô hình nào).
CREATE TABLE data_source_global AS SELECT * FROM data_source;
DROP TABLE data_source;
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
INSERT INTO data_source (model_key, source, description, origin, first_seen, last_seen, msg_count, sample)
SELECT DISTINCT v.model_key, g.source, g.description, g.origin, g.first_seen, g.last_seen, g.msg_count, g.sample
FROM data_source_global g
JOIN data_binding b ON b.source = g.source
JOIN model_version v ON (b.model_key = v.model_key OR b.model_key = '')
JOIN node n ON n.model_version_id = v.id AND (b.model_key <> '' OR n.key = b.subject);
DROP TABLE data_source_global;
