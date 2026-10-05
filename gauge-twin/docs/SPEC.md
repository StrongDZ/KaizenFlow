# Tech Spec v2 — Hệ thống số hóa đồng hồ công nghiệp (Edge → Server)

Phiên bản: 2026-10-03 · Tác giả: Hoang Manh

## 1. Tổng quan & phạm vi

Hệ thống biến camera tại trạm máy thành cảm biến: edge đọc đồng hồ, chỉ gửi số và text về server, server lưu time-series sạch cho mô hình Predict. Mục tiêu giai đoạn này: xây và chứng minh toàn bộ luồng chịu tải trên môi trường mô phỏng, để khi có ảnh thật và Jetson chỉ cần thay model và đo lại.

**Giả định hiện tại**

- Chưa có ảnh thật từ xưởng; dùng ảnh synthetic và dataset công khai.
- Chưa có Jetson; phát triển DeepStream trên server x86 có GPU NVIDIA, build image L4T song song.
- 5 loại hiển thị: kim (áp suất, nhiệt độ), LED/LCD 7 đoạn (Volt/Ampe), timer MM:SS, số lăn cơ học (hour meter). Loại hiển thị là cấu hình, không hard-code.
- Quy mô thiết kế: 1.000 máy, test tới 5.000 máy giả lập (con số giả định, cần xác nhận với dự án).

**Nguyên tắc thiết kế**

1. Xử lý ảnh hoàn toàn tại edge; không gửi video về server, chỉ gửi crop ảnh khi reading có quality thấp (phục vụ active learning).
2. Không mất dữ liệu: QoS 1, buffer offline tại edge, Kafka làm bộ đệm, ghi idempotent.
3. Không nghẽn: gom theo máy và cửa sổ, deadband, batch insert, scale ngang bằng partition.
4. Chính xác có kiểm chứng: mọi reading có quality score và flags; server kiểm tra ràng buộc vật lý; độ chính xác đo tự động bằng ground truth của bộ mô phỏng.
5. Tách video khỏi nghiệp vụ: DeepStream chỉ lo decode + suy luận; logic đọc số, lọc, gom nằm ở post-processor riêng, test được độc lập.

## 2. Kiến trúc tổng thể

Video dừng ở edge; chỉ bản tin số đi qua mạng. Kafka nằm giữa broker và DB nên khi DB chậm, dữ liệu dồn lại ở Kafka thay vì làm nghẽn broker hay edge.

```text
┌──────────────── Edge · Jetson Orin Nano (mỗi trạm) ────────────────┐
│  Camera RTSP ──► ds-pipeline (DeepStream) ──ZeroMQ──► edge-agent (Go) │
│  1–5 fps         decode, ROI, TensorRT                lọc, gom, buffer │
└───────────────────────────────────────────────────────────┬────────┘
                                          telemetry · QoS 1  │
                                                             ▼
   config-api ──config (retained)──► EMQX 5.8 + mqtt-bridge ──► Kafka / Redpanda
   config trạm, OTA                  MQTT, mTLS → Kafka (Go)    đệm bền, key = machine_id
                                                             │
                              ┌──────────────────────────────┼───────────────┐
                              ▼                              ▼               ▼
                           ingest                          state           alert
                    validate, dedup, batch          edge online, seq gap  ngưỡng, mất tín hiệu
                         │            │
                         ▼            ▼
                    TimescaleDB     Redis                  query-api → Predict
                 gauge_reading,   giá trị mới nhất         API cho mô hình dự báo
                    gauge_1m ───────── đọc dữ liệu đã lọc theo quality ──────▲
```

Config đi ngược chiều: config-api publish retained lên EMQX, edge tự nhận khi kết nối. Prometheus + Grafana thu metric từ mọi khối, không vẽ để sơ đồ gọn.

EMQX ghim bản 5.8.x (Apache 2.0): từ 5.9 EMQX chuyển sang BSL 1.1 và cluster nhiều node cần license, còn 5.8.x mã nguồn mở không có Kafka sink. Vì vậy service **mqtt-bridge** (Go) subscribe chung `$share/bridge/denso/+/+/+/telemetry` và `status`, produce sang Kafka, và chỉ PUBACK MQTT sau khi Kafka xác nhận.

## 3. Mô hình dữ liệu

Bốn lớp dữ liệu phải chốt trước khi code: config trạm, bản tin MQTT, bảng DB, khóa Redis. Schema nằm trong thư mục `schemas/` và là nguồn duy nhất cho cả edge lẫn server.

### 3.1 Config trạm (server → edge, MQTT retained)

```json
{
  "config_version": 7,
  "machine_id": "STAMPING_PRESS_01",
  "plant": "DENSO_HN", "line": "L03",
  "camera": {"url": "rtsp://10.1.3.21/stream1", "sample_fps": 2},
  "window_sec": 1,
  "gauges": [
    {"gauge_id": "MAIN_PRESSURE", "type": "analog_dial", "unit": "bar",
     "roi": [812, 344, 260, 260], "quad": [[818, 350], [1066, 356], [1062, 598], [822, 592]], "rect_size": 256,
     "calib": {"center": [130, 131], "min_pt": [52, 205], "max_pt": [208, 205],
               "min_val": 0, "max_val": 150, "sweep": "cw", "scale": "linear"},
     "rules": {"max_rate_per_s": 30, "deadband": 0.5}},
    {"gauge_id": "VOLTMETER", "type": "seg7", "unit": "V",
     "roi": [1210, 402, 180, 64],
     "calib": {"digits": 4, "decimal_pos": 3, "color": "red_led"},
     "rules": {"min": 0, "max": 500}},
    {"gauge_id": "CYCLE_TIMER", "type": "timer_mmss", "unit": "s",
     "roi": [1210, 500, 180, 64], "calib": {"digits": 4, "colon_after": 2}},
    {"gauge_id": "TOTAL_HOUR_METER", "type": "rolling_counter", "unit": "h",
     "roi": [600, 620, 220, 70], "calib": {"digits": 6, "decimal_digits": 1},
     "rules": {"monotonic": true, "report_interval_s": 300}}
  ],
  "model_versions": {"dial_pose": "dial-pose-0.3", "digit_cls": "digit-0.2"}
}
```

Tọa độ `calib` tính trong mặt phẳng đã nắn: `quad` (4 điểm TL, TR, BR, BL trong khung hình; với mặt tròn là hình vuông ngoại tiếp mặt đồng hồ) được ánh xạ bằng homography về hình vuông `rect_size` × `rect_size` (mặc định 256). Không có `quad` thì dùng nguyên `roi` (coi như nhìn thẳng); `roi` luôn là hộp bao để crop. Đồng hồ kim: edge-agent đưa keypoint qua homography; 7 đoạn và số lăn: warp ảnh trước khi cắt ô. Edge chỉ áp dụng config khi `config_version` mới hơn bản đang chạy, và gửi lại version đang dùng trong heartbeat.

### 3.2 Topic MQTT

| Topic | Chiều | QoS | Retained | Nội dung |
| --- | --- | --- | --- | --- |
| `denso/{plant}/{line}/{machine}/telemetry` | edge → server | 1 | không | Bản tin đo theo cửa sổ |
| `denso/{plant}/{line}/{machine}/status` | edge → server | 1 | có | `Status` (mục 3.3b); LWT cũng là `Status` với `STATE_OFFLINE` |
| `denso/{plant}/{line}/{machine}/config` | server → edge | 1 | có | Config trạm (3.1) |
| `denso/{plant}/{line}/{machine}/sample` | edge → server | 0 | không | Tham chiếu crop ảnh quality thấp (ảnh nằm trên MinIO) |
| `denso/{plant}/edge/{edge_id}/cmd/resend` | server → edge | 1 | không | `ResendRequest {edge_id, from_seq, to_seq}` (bao gồm hai đầu, ≤ 10.000 seq) |
| `denso/{plant}/edge/{edge_id}/cmd/resend/ack` | edge → server | 1 | không | `ResendAck`: số seq đã gửi lại, các khoảng không còn trong buffer (service state ghi nhận mất thật) |

### 3.3 Payload telemetry (Protobuf, JSON tương đương để debug)

```protobuf
syntax = "proto3";
package denso.gauge.v1;

message Telemetry {
  uint32 schema_version = 1;
  string edge_id = 2;
  uint64 seq = 3;              // tăng dần theo edge, dùng dedup và phát hiện mất gói
  string machine_id = 4;
  int64 window_start_ms = 5;
  int64 window_end_ms = 6;
  uint32 config_version = 7;
  string model_version = 8;
  repeated Measurement measurements = 9;
  bool replayed = 10;          // true nếu xả từ buffer offline
}

message Measurement {
  string gauge_id = 1;
  optional double value = 2;   // trống = không đọc được
  double v_min = 3;
  double v_max = 4;
  uint32 n_frames = 5;         // số frame hợp lệ trong cửa sổ
  uint32 n_rejected = 6;
  float quality = 7;           // 0..1
  repeated Flag flags = 8;
  string unit = 9;
}

enum Flag {
  FLAG_UNSPECIFIED = 0; FLAG_BLUR = 1; FLAG_GLARE = 2; FLAG_OCCLUDED = 3; FLAG_OUT_OF_RANGE = 4;
  FLAG_RATE_LIMIT = 5; FLAG_NON_MONOTONIC = 6; FLAG_FORMAT_INVALID = 7; FLAG_ROI_DRIFT = 8; FLAG_STALE = 9;
  FLAG_CLOCK_SKEW = 10;   // timestamp lệch > 5 phút so với giờ server (gắn ở ingest)
  FLAG_NO_CONFIG = 11;    // máy chưa có config trong config-api (gắn ở ingest)
}
```

Quy tắc: timer gửi số giây; không đọc được thì bỏ trống `value` kèm flags, không bỏ bản tin; mỗi bản tin chứa một máy, một cửa sổ.

### 3.3b Payload status (Protobuf)

```protobuf
message Status {
  string edge_id = 1;
  repeated string machine_ids = 2;   // một edge phục vụ nhiều máy
  int64 ts_ms = 3;                   // LWT: là lúc kết nối; service state dùng thời điểm nhận làm mốc offline
  State state = 4;
  string sw_version = 5;
  uint32 config_version = 6;
  string model_version = 7;
  float fps_actual = 8;
  float gpu_util = 9;                // 0..1
  uint64 ram_bytes = 10;
  optional float temperature_c = 11;
  uint64 buffer_bytes = 12;
  uint64 buffer_msgs = 13;
}

enum State { STATE_UNSPECIFIED = 0; STATE_ONLINE = 1; STATE_OFFLINE = 2; }
```

Heartbeat publish retained mỗi 30 s; tắt êm thì publish `STATE_OFFLINE` retained rồi mới ngắt.

### 3.4 Schema TimescaleDB

```sql
CREATE TABLE gauge_reading (
  ts            timestamptz NOT NULL,   -- window_end
  machine_id    text        NOT NULL,
  gauge_id      text        NOT NULL,
  value         double precision,
  v_min         double precision,
  v_max         double precision,
  n_frames      int,
  quality       real,
  flags         smallint[],
  edge_id       text,
  seq           bigint,
  replayed      boolean     NOT NULL DEFAULT false,  -- bản tin xả từ buffer hoặc gửi lại theo cmd/resend
  model_version text,
  ingested_at   timestamptz DEFAULT now(),
  PRIMARY KEY (machine_id, gauge_id, ts)  -- idempotent: ON CONFLICT DO NOTHING
);
SELECT create_hypertable('gauge_reading', 'ts', chunk_time_interval => interval '1 day');
ALTER TABLE gauge_reading SET (timescaledb.compress, timescaledb.compress_segmentby = 'machine_id, gauge_id');
SELECT add_compression_policy('gauge_reading', interval '7 days');

-- FILE MIGRATION RIÊNG (continuous aggregate không tạo được trong transaction)
-- dữ liệu cho Predict: chỉ tính reading đạt ngưỡng, gộp 1 phút
-- ngưỡng 0.7 hard-code: đổi ngưỡng ở GD5 thì phải tạo lại view
CREATE MATERIALIZED VIEW gauge_1m WITH (timescaledb.continuous) AS
SELECT time_bucket('1 minute', ts) AS bucket, machine_id, gauge_id,
       avg(value) FILTER (WHERE quality >= 0.7) AS avg_v,
       min(v_min) FILTER (WHERE quality >= 0.7) AS min_v,
       max(v_max) FILTER (WHERE quality >= 0.7) AS max_v,
       avg(value)                               AS avg_v_all,  -- debug, Predict không dùng
       count(*)   FILTER (WHERE quality >= 0.7) AS n_good,
       count(*)                                 AS n_all
FROM gauge_reading WHERE value IS NOT NULL
GROUP BY bucket, machine_id, gauge_id;

-- FILE MIGRATION RIÊNG: tự cập nhật view; start_offset 2h để tính lại dữ liệu xả từ buffer offline
-- mất mạng lâu hơn 2h: gọi refresh_continuous_aggregate thủ công (ghi trong runbook)
SELECT add_continuous_aggregate_policy('gauge_1m',
  start_offset => INTERVAL '2 hours',
  end_offset   => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute');
```

Phía đọc: thứ tự ghi không trùng thứ tự `ts` (replay, failover). Mọi truy vấn sắp xếp theo `ts`; reader đọc tăng dần (stream sang Predict) dùng con trỏ theo `ingested_at` và dedup theo khóa chính, không dùng con trỏ theo `ts`. View `gauge_1m` tính lại cửa sổ 2 giờ gần nhất nên tự hấp thụ dòng đến trễ vài phút.

Bảng phụ: `machine` (danh mục máy, line, plant); `station_config` (machine_id, config_version, config jsonb, published_version, updated_at) là nguồn sự thật duy nhất của config; `gauge` là VIEW đọc từ `station_config.config -> 'gauges'`, không phải bảng; `edge_node` (phiên bản phần mềm, last_seen, `machine_ids text[]`); `rejected_reading` (bản tin bị reject kèm lý do, giữ 30 ngày, unique theo (kafka_topic, kafka_partition, kafka_offset)).

### 3.5 Khóa Redis

| Khóa | Kiểu | Nội dung | TTL |
| --- | --- | --- | --- |
| `latest:{machine}:{gauge}` | hash | value, quality, ts | không |
| `edge:{edge_id}:last_seen` | string | timestamp heartbeat | 120 s |
| `seq:{edge_id}` | string | seq lớn nhất đã nhận, phát hiện mất gói | không |
| `hourmeter:{machine}` | string | giá trị đơn điệu gần nhất đã chấp nhận | không |
| `seqgap:{edge_id}` | sorted set | seq còn thiếu, score = thời điểm phát hiện; chỉ tính mất sau 10 phút khi edge ONLINE và `buffer_msgs == 0`; seq đến muộn thì xóa và đếm `edge_seq_late_total`; tối đa 10.000 phần tử | 7 ngày |
| `seqasked:{edge_id}` | sorted set | seq đã gửi `cmd/resend` (mỗi seq chỉ hỏi một lần): service state hỏi khi seq thiếu quá `RESEND_AFTER` (mặc định 1 phút) và edge ONLINE với `buffer_msgs == 0`; khoảng edge trả lời "không còn" trong `ResendAck.missing` được tính mất ngay; tắt bằng `RESEND_ENABLED=false` | 7 ngày |

## 4. Thiết kế edge

Edge gồm hai tiến trình trong hai container: **ds-pipeline** (DeepStream, C++) lo video và suy luận; **edge-agent** (Go) lo đọc số, lọc, gom, buffer và MQTT. Hai tiến trình nói chuyện qua ZeroMQ (IPC socket), mỗi tiến trình chết thì tiến trình kia vẫn sống.

### 4.1 ds-pipeline (DeepStream)

1. `nvurisrcbin` × N camera, bật tự kết nối lại RTSP; giảm tần số bằng `drop-frame-interval` về `sample_fps` trong config.
2. `nvstreammux` gom batch theo số camera.
3. `nvdspreprocess` cắt các ROI từ config, resize theo kích thước input model.
4. `nvinfer` (TensorRT FP16), mỗi loại hiển thị một model:
   - `dial_pose`: mạng keypoint tự viết (backbone torchvision MobileNetV3-small hoặc ResNet18, head heatmap 5 kênh + độ tin cậy từng điểm), input crop 256×256 chưa nắn. 5 keypoint: center (trục kim), start (vạch Min), end (vạch Max), mid (vạch 50% giá trị), tip (đầu kim). Không dùng Ultralytics (AGPL-3.0).
   - `digit_cls`: CNN nhỏ phân loại từng ô chữ số (0–9, trống, đang chuyển), dùng chung cho 7 đoạn, timer và số lăn.
5. Probe cuối pipeline đọc metadata thô (keypoint + độ tin cậy, xác suất từng ô), tính độ nét Laplacian và tỷ lệ pixel cháy sáng trên ROI, rồi gửi sang edge-agent. Probe không chứa logic nghiệp vụ.
6. Mỗi 10 phút, so frame với ảnh tham chiếu bằng ORB hoặc marker ArUco; lệch quá ngưỡng thì gắn cờ `FLAG_ROI_DRIFT`.

Bản tin nội bộ ds-pipeline → edge-agent (Protobuf `FrameResult`): `camera_id`, `frame_ts_ms`, danh sách `RoiResult {gauge_id, keypoints[], kp_conf[], slot_probs[][], sharpness, glare_ratio, roi_drift, drift_px}`. Keypoint tính theo pixel khung hình gốc; edge-agent tự áp homography của `quad`.

Lệnh edge-agent → ds-pipeline (Protobuf `Command`, socket ZeroMQ riêng, REQ/REP hoặc DEALER/ROUTER có timeout): `RELOAD_CONFIG {config_version}` và `RESTART`; ds-pipeline trả `CommandReply {command_id, ok, error}`. Edge-agent chỉ báo `config_version` mới trong heartbeat sau khi nhận `ok`.

Tiền xử lý model (resize, nội suy, thứ tự kênh, mean/std, xám/màu) mô tả trong `preprocess.json` đi kèm mỗi ONNX; train, ds-sim và config nvdspreprocess đều đọc từ file này.

### 4.2 edge-agent (Go)

| Bước | Kim (áp suất, nhiệt độ) | 7 đoạn / timer | Số lăn (hour meter) |
| --- | --- | --- | --- |
| Giải mã | Góc kim từ center→tip, nội suy theo min_pt/max_pt | Ghép ô theo `digits`, chèn dấu thập phân/":" từ config | Ghép ô; ô "đang chuyển" lấy chữ số nhỏ hơn |
| Kiểm tra | Trong dải, tốc độ ≤ `max_rate_per_s` | Format, trong dải | Đơn điệu, tăng ≤ thời gian thực đã trôi |
| Làm mượt | Median trong cửa sổ + min/max | Mode (giá trị xuất hiện nhiều nhất) | Giữ giá trị chấp nhận gần nhất |
| Gửi | Mỗi cửa sổ `window_sec` | Mỗi cửa sổ, hoặc khi đổi vượt deadband | Mỗi `report_interval_s` hoặc khi đổi |

**Quality score (0–1)** = tích của các thành phần: độ tin cậy model (trung bình kp_conf hoặc tích xác suất ô), độ nét, mức cháy sáng, độ nhất quán trong cửa sổ (tỷ lệ frame đồng thuận), và hệ số phạt khi có flag. Công thức cụ thể và ngưỡng 0.7 được hiệu chỉnh lại bằng dữ liệu mô phỏng ở Giai đoạn 5.

### 4.3 Chống nghẽn và chống mất dữ liệu tại edge

- **Buffer offline**: mọi bản tin ghi vào SQLite (WAL) trước khi publish; nhận PUBACK thì đánh dấu đã gửi và giữ thêm 24 giờ để phục vụ `cmd/resend`. Giới hạn 500 MB ưu tiên hơn 24 giờ: đầy thì xóa bản đã PUBACK cũ nhất trước, bản chưa gửi xóa sau cùng.
- **Xả buffer có giới hạn tốc độ** (token bucket, ví dụ 50 msg/s mỗi edge), đánh dấu `replayed = true`; dữ liệu realtime luôn được ưu tiên hơn dữ liệu xả.
- **Reconnect** exponential backoff 1 s → 60 s cộng jitter ngẫu nhiên ±50%.
- **Heartbeat** 30 s trên topic status: version phần mềm, config_version, FPS thực tế, GPU/RAM/nhiệt độ, kích thước buffer (message `Status`, mục 3.3b). LWT = `Status` với `STATE_OFFLINE`. Bản tin `replayed=true` đến sau bản realtime nên thứ tự theo máy trong Kafka bị đảo; ingest kiểm tra đơn điệu/tốc độ theo `window_end`, không so với `latest` trong Redis và không ghi đè `latest` bằng dữ liệu cũ hơn.
- **Đồng bộ giờ**: chrony với NTP nội bộ xưởng; timestamp lấy từ frame, không lấy lúc gửi.
- **Watchdog**: systemd restart container; ds-pipeline treo quá 30 s không ra frame thì edge-agent gửi flag `FLAG_STALE` và khởi động lại nó.

## 5. Thiết kế server

Server nhận MQTT, đệm qua Kafka, rồi các service Go đọc theo consumer group; mọi service đều stateless trừ DB và Redis, nên scale ngang bằng cách tăng số replica.

| Service | Vai trò | Đầu vào → đầu ra | Scale |
| --- | --- | --- | --- |
| EMQX 5.8.x (3 node, Apache 2.0) | Broker MQTT, xác thực edge bằng mTLS, ACL theo topic | edge → mqtt-bridge | Thêm node |
| mqtt-bridge (Go) | Shared subscription, produce Kafka key = `machine_id`, `acks=all`, idempotent producer; PUBACK MQTT chỉ sau khi Kafka xác nhận | MQTT → Kafka `gauge.telemetry`, `gauge.status` | Thêm replica (shared subscription) |
| Kafka / Redpanda (3 broker) | Bộ đệm bền | `gauge.telemetry` 24 partition, giữ 7 ngày; `gauge.status`, `gauge.rejected` 6 partition; `gauge.dlq` 3 partition | Thêm partition (lên kế hoạch trước) |
| ingest (Go) | Decode, validate, dedup, batch insert | Kafka → TimescaleDB, Redis, `gauge.rejected` | Replica ≤ số partition |
| state (Go) | Giám sát edge: last_seen, mất gói theo seq | `gauge.status` → Redis, bảng `edge_node` | 1–2 replica |
| alert (Go) | Ngưỡng vận hành, mất tín hiệu, quality thấp kéo dài | Kafka → webhook / email | 1–2 replica |
| config-api (Go) | CRUD config trạm, publish retained, tool commissioning | REST → Postgres + MQTT | 2 replica |
| query-api (Go) | API cho Predict và dashboard | TimescaleDB / Redis → REST/gRPC | Theo tải |
| Prometheus + Grafana | Metric toàn hệ thống | — | — |

### 5.1 Luồng xử lý của ingest

1. Đọc batch từ Kafka (tối đa 1.000 bản tin hoặc 200 ms).
2. Decode Protobuf; sai schema → `gauge.rejected` kèm lý do.
3. Validate theo config hiện hành (cache từ config-api): dải đo, tốc độ thay đổi, đơn điệu với hour meter (so `hourmeter:{machine}`), timestamp không lệch quá 5 phút so với giờ server (trừ bản tin `replayed`).
4. Vi phạm ràng buộc: vẫn ghi nhưng gắn thêm flag (lệch giờ = `FLAG_CLOCK_SKEW`) và hạ quality xuống tối đa 0,3, để Predict tự lọc; chỉ bản tin hỏng cấu trúc mới bị loại. Bản tin đến muộn, tức `replayed=true` hoặc có `window_end` cũ hơn `latest` hiện tại (kể cả bản realtime đến trễ sau khi broker/bridge failover), không so với `latest`/`hourmeter` và không ghi đè `latest`; `latest`/`hourmeter` chỉ cập nhật khi `window_end` mới hơn; bản tin lệch giờ không cập nhật `latest`. Máy chưa có config: vẫn ghi, bỏ qua kiểm tra dải, gắn `FLAG_NO_CONFIG`, không hạ quality, đếm metric và alert.
5. `COPY` / multi-row `INSERT … ON CONFLICT DO NOTHING` vào `gauge_reading`.
6. Cập nhật Redis `latest:*` bằng pipeline.
7. Commit offset Kafka **sau khi** DB ghi thành công (at-least-once + idempotent = không trùng, không mất).

### 5.2 Backpressure

- DB chậm → ingest chậm commit → lag Kafka tăng; không service nào bị nổ. Cảnh báo khi lag vượt 60 s.
- Lỗi hạ tầng (mất kết nối DB/Redis, timeout): retry mãi với backoff trần 30 s, không commit offset, `/healthz` báo degraded; dữ liệu dồn ở Kafka (kịch bản 6).
- Lỗi do dữ liệu: sau 5 lần thì chia đôi batch để tìm đúng bản tin gây lỗi, chỉ bản tin đó vào `gauge.dlq`, phần còn lại đi tiếp.
- mqtt-bridge: tối thiểu 2 replica, client ID ổn định theo replica, session bền; tăng `max_mqueue_len` cho session bridge; alert khi nhóm `$share/bridge` không còn subscriber.
- EMQX giới hạn tốc độ mỗi client (ví dụ 100 msg/s) để một edge lỗi không làm nghẽn cả cluster.

### 5.3 Metric bắt buộc

- `ingest_messages_total{result}`, `ingest_batch_latency_seconds`, `kafka_consumer_lag` (cập nhật mỗi 10 s từ offset của broker, độc lập với việc ghi batch; alert dự phòng theo lag phía broker).
- `ingest_late_total` (bản tin realtime đến muộn theo `window_end`) và `bridge_messages_total{stage}` (đếm theo chặng received/produced/acked để định vị mất dữ liệu).
- `edge_online`, `edge_seq_gap_total`, `edge_buffer_bytes`.
- `reading_quality_bucket{gauge_type}`, `reading_flag_total{flag}`.
- Độ trễ end-to-end = `ingested_at − window_end` (histogram).

## 6. Môi trường mô phỏng

Bộ mô phỏng thay cho ảnh thật và Jetson: nó sinh video có ground truth, phát thành RTSP, và giả lập hàng nghìn edge để test tải server.

| Công cụ | Việc làm | Đầu ra |
| --- | --- | --- |
| `gauge-renderer` (Python, OpenCV/PIL) | Vẽ 5 loại hiển thị với giao diện ngẫu nhiên (cỡ mặt, cung quét 180–320°, kiểu kim, font 7 đoạn, màu LED/LCD) và giá trị chạy theo kịch bản | Video MP4 + `groundtruth.parquet` (ts, gauge_id, value) + config trạm khớp với video |
| Bộ nhiễu (trong renderer) | Rung (dịch chuyển + motion blur theo nhịp dập), lóa, đổi sáng ngày/đêm, người che, nhiễu nén H.264, phối cảnh nghiêng | Tham số nhiễu lưu cùng ground truth |
| `dataset-builder` | Cắt ROI từ video synthetic + dataset công khai thành tập train | Thư mục YOLO-pose và tập ô chữ số |
| MediaMTX + ffmpeg | Phát lặp video thành N luồng `rtsp://sim:8554/machine_XXX` | RTSP giống camera thật |
| `edge-sim` (Go) | Giả lập 1–5.000 edge-agent: đúng schema, seq, heartbeat, buffer, reconnect; có chế độ bơm lỗi | Tải MQTT thật lên server |
| `ds-sim` (Python, onnxruntime, pyzmq) | Làm đúng việc của ds-pipeline trên CPU: đọc RTSP giả, cắt ROI, warp ô chữ số, chạy 2 model ONNX theo preprocess.json, tính độ nét/lóa/drift, gửi `FrameResult` qua ZeroMQ, nhận `Command` | Test edge-agent đầu-cuối không cần GPU; chuẩn đối chiếu cho bản DeepStream |
| `accuracy-eval` (Python) | Join dữ liệu trong DB với ground truth theo (machine, gauge, ts) | Báo cáo MAE, exact-match, tỷ lệ reject, đường cong quality ↔ độ đúng |

**Kịch bản giá trị trong renderer**: áp suất dao động theo chu kỳ dập cộng nhiễu; nhiệt độ tăng chậm rồi bão hòa; điện áp quanh một mức có sụt ngắn; timer đếm và reset theo chu kỳ; hour meter tăng (cho phép tua nhanh để thấy chuyển số). Có cả đoạn bất thường (vượt dải, đứng im) để test alert.

**Dataset công khai dùng kèm**: ảnh thật của WACV 2024 (automatic-gauge-reading), Roboflow analogv2 / analog-gauge-reader cho kim; UFPR-AMR và Copel-AMR cho số lăn; YUVA EB và Roboflow 7-segment cho màn số. Kiểm tra giấy phép từng bộ trước khi dùng cho sản phẩm.

## 7. Kịch bản triển khai theo giai đoạn

Tám giai đoạn, khoảng 10–11 tuần với 2–3 người; GD3 và GD4 chạy song song sau khi schema chốt. Thời lượng là ước lượng ban đầu.

1. **GD0 – Nền móng (tuần 1)**
   - Việc: monorepo, CI cơ bản, `schemas/` (Protobuf + SQL migration), docker-compose hạ tầng.
   - Xong khi: `make up` dựng đủ EMQX, Kafka, TimescaleDB, Redis, Prometheus, Grafana, MinIO; `make proto` sinh code Go/Python/C++.
2. **GD1 – Bộ mô phỏng (tuần 1–2)**
   - Việc: `gauge-renderer`, bộ nhiễu, MediaMTX phát RTSP, `edge-sim`.
   - Xong khi: 20 luồng RTSP giả chạy ổn định 1 giờ; `edge-sim` 1.000 máy publish đúng schema.
3. **GD2 – Backend ingest (tuần 2–3)**
   - Việc: mqtt-bridge (MQTT → Kafka), ingest, state, config-api, dashboard Grafana.
   - Xong khi: `edge-sim` 1.000 máy → dữ liệu vào DB đủ, không trùng; dashboard hiển thị msg/s, lag, edge online.
4. **GD3 – Model (tuần 3–5)**
   - Việc: `dataset-builder`; train model keypoint kim (5 điểm, mục 4.1) và digit classifier trên synthetic + dataset công khai; log MLflow; export ONNX.
   - Xong khi: trên tập test synthetic, kim sai số ≤ 1,5% full scale, chữ số đúng ≥ 99% từng ô.
5. **GD4 – Edge pipeline (tuần 3–6)**
   - Việc: ds-pipeline (DeepStream trên x86), custom parser, edge-agent Go, buffer SQLite, heartbeat, nhận config.
   - Xong khi: 8 luồng RTSP giả → edge → server chạy liên tục 24 giờ; đổi config qua config-api có hiệu lực không cần restart.
6. **GD5 – Độ chính xác end-to-end (tuần 6–7)**
   - Việc: `accuracy-eval`, hiệu chỉnh quality score và ngưỡng, đưa vào CI.
   - Xong khi: reading có quality ≥ 0,7 đạt mục tiêu chính xác của GD3; tỷ lệ reject ≤ 5% trong điều kiện nhiễu vừa.
7. **GD6 – Test tải và chịu lỗi (tuần 7–9)**
   - Việc: 8 kịch bản ở mục 8; tối ưu theo kết quả.
   - Xong khi: cả 8 kịch bản đạt tiêu chí; có báo cáo capacity (msg/s tối đa, số luồng tối đa trên GPU dev).
8. **GD7 – Sẵn sàng cho Jetson và pilot (tuần 9–11)**
   - Việc: build image `deepstream-l4t`, tool commissioning trên web (kéo ROI, chấm tâm/min/max), luồng active learning (crop → MinIO → CVAT → MLflow → OTA), runbook.
   - Xong khi: image ARM build xanh trong CI; khi có Jetson, chỉ cần build TensorRT engine từ ONNX và chạy lại benchmark edge.

Khi có ảnh thật: gán nhãn một ít, fine-tune, chạy lại GD5 với ground truth ghi tay. Không sửa kiến trúc.

## 8. Test tải & chịu lỗi

Tám kịch bản chạy bằng `edge-sim`; tiêu chí là đề xuất ban đầu, chốt lại với team. Mỗi script nhận tham số thời lượng và quy mô: mặc định là bản rút gọn (chạy trên laptop để kiểm tra script), `FULL=1` chạy đúng bảng dưới. Bản FULL chạy trên server dùng chung trong khung giờ đã báo trước, mạng Docker riêng, không mở cổng ra host, có giới hạn cpus/mem_limit. Hiện chỉ có một server nên edge-sim chạy chung máy với hạ tầng, tách lõi bằng cpuset; báo cáo ghi rõ điều này.

| # | Kịch bản | Cách làm | Tiêu chí đạt |
| --- | --- | --- | --- |
| 1 | Tải ổn định | 1.000 máy × 1 msg/s, 24 giờ | Mất 0 bản tin (đối chiếu seq); p99 edge → DB < 2 s |
| 2 | Tải gấp 5 | 5.000 máy trong 1 giờ | Lag Kafka về 0 trong 5 phút sau khi giảm tải |
| 3 | Bão reconnect | Restart cả cluster EMQX, bật resend | 100% edge kết nối lại < 2 phút, CPU broker < 80%, 0 mất sau khi resend xong |
| 3g | Mất sau PUBACK có chủ đích | edge-sim `--faults gap` 1% seq, bật resend | 0 mất sau khi resend xong; ghi thời gian hồi phục |
| 4 | Mất mạng xưởng | Cắt mạng 20% edge trong 30 phút rồi nối lại | Buffer xả đủ, không trùng, realtime không bị trễ quá 5 s |
| 5a | Chết node broker, tắt resend | Kill 1 node EMQX và 1 broker Kafka | Đo số bản tin mất thật (lỗ hổng tầng broker); cụm tự phục hồi |
| 5b | Chết node broker, bật resend tự động | Như 5a, service state tự gửi cmd/resend | 0 mất sau khi resend xong; ghi thời gian hồi phục |
| 6 | DB chậm | Giới hạn IO TimescaleDB 30 phút | Dữ liệu dồn ở Kafka, không rơi, hồi phục tự động |
| 7 | Dữ liệu bẩn | 5% bản tin ngoài dải, sai schema, trùng, lệch giờ | 100% được gắn flag hoặc đưa vào rejected; không dòng trùng |
| 8 | Edge thật dài hạn | 8 luồng RTSP giả qua ds-pipeline, 72 giờ (khi chưa có ds-pipeline: ds-sim) | Không rò bộ nhớ (RAM tăng < 5%), 0 lần restart, FPS ổn định (với ds-sim chỉ ghi FPS để tham khảo) |

Đợt đầu: kịch bản 2–7 chạy FULL; kịch bản 1 chạy 4 giờ, kịch bản 8 chạy 12 giờ với ds-sim. Bản 24 giờ / 72 giờ chạy sau khi đã sửa các nút thắt tìm được.

Công cụ: `edge-sim` cho 1–7; Toxiproxy chỉ cho kịch bản 6 (làm chậm ingest → TimescaleDB); các kịch bản khác dùng `docker kill`, `docker restart`, `docker network disconnect`; `emqtt-bench` để đối chiếu; snapshot Grafana qua API. `seqcheck` đếm mất, trùng và sai thứ tự (dựa trên cột `replayed` và `ingested_at`).

## 9. Cấu trúc repo & cách triển khai

Một monorepo, mỗi thư mục cấp 1 là một đơn vị build độc lập; schema sinh code cho mọi ngôn ngữ.

```text
gauge-twin/
├── schemas/            # proto/ (telemetry, config, frame_result), sql/ (migrations)
├── edge/
│   ├── ds-pipeline/    # C++: DeepStream app, custom parser, probe → ZeroMQ
│   └── edge-agent/     # Go: decode, filter, window, SQLite buffer, MQTT
├── server/
│   ├── mqtt-bridge/  ingest/  state/  alert/  config-api/  query-api/   # Go
│   └── pkg/            # thư viện dùng chung: kafka, db, metrics, validate
├── sim/
│   ├── gauge-renderer/ # Python
│   ├── edge-sim/       # Go
│   └── accuracy-eval/  # Python
├── ml/                 # dataset-builder, train, export ONNX, MLflow
├── infra/
│   ├── compose/        # docker-compose: dev, loadtest
│   ├── k8s/            # Helm chart cho server khi lên production
│   └── grafana/        # dashboard JSON
├── loadtest/           # kịch bản 1–8, script báo cáo
└── Makefile            # up, down, proto, test, sim, loadtest-N
```

**Môi trường**

| Môi trường | Chạy gì | Ở đâu |
| --- | --- | --- |
| Dev | docker-compose profile dev (1 EMQX, 1 Redpanda) + sim, DeepStream x86 trong `nvcr.io/nvidia/deepstream:7.1-triton-multiarch` | Server GPU của team |
| Loadtest | Profile cluster trên server tách riêng: 3 node EMQX 5.8.x, 3 Redpanda, 1 TimescaleDB; `edge-sim` trên máy khác | 2–3 máy |
| Production server | Kubernetes (Helm) hoặc docker-compose nhiều máy; TimescaleDB có replica | Server tại nhà máy |
| Production edge | Docker trên JetPack: `ds-pipeline` (deepstream-l4t) + `edge-agent`; systemd giữ container sống | Jetson Orin Nano tại trạm |

**CI (GitLab)**: lint + unit test mọi service; build image `linux/amd64` và `linux/arm64` (ds-pipeline dùng base khác nhau cho x86 và L4T); job `accuracy-eval` chạy video synthetic cố định và chặn merge nếu độ chính xác giảm; job loadtest nhỏ (100 máy, 10 phút) mỗi đêm.

**Model**: chỉ lưu ONNX trong MLflow registry; TensorRT engine được build lần đầu chạy trên từng thiết bị đích rồi cache lại, vì engine không mang được giữa GPU khác kiến trúc.

**Bảo mật**: mTLS edge ↔ EMQX, mỗi edge một certificate; ACL chỉ cho edge publish vào topic máy của mình; mạng OT tách VLAN, edge không cần ra internet.

## 10. Rủi ro & việc còn mở

| Rủi ro | Ảnh hưởng | Cách giảm |
| --- | --- | --- |
| Model train synthetic giảm chính xác trên ảnh thật | Số liệu GD5 không đại diện hiện trường | Ghi rõ "đo trên mô phỏng"; fine-tune ngay khi có vài trăm ảnh thật; active learning |
| Thiết bị thật khác giả định (volt kế là kim, timer không hiển thị) | Phải thêm nhánh mới | Loại hiển thị là config; nhánh mới = model + decoder mới, không đổi hạ tầng |
| EMQX 5.8.x là dòng Apache 2.0 cuối cùng | Ít bản vá bảo mật về sau | mqtt-bridge tách server khỏi broker; đánh giá lại (license EMQX 5.9+, broker khác) trước production; nếu bàn giao cho Denso như sản phẩm thì hỏi pháp chế về BSL |
| DeepStream 7.x trên GPU Volta chưa chắc được hỗ trợ | Không chạy được trên server V100 | Kiểm tra release notes; dùng 6.4 hoặc thuê T4/L4 cho dev |
| Giấy phép thư viện model (Ultralytics AGPL-3.0) | Phải mở mã hoặc mua license nếu giao cho Denso | Không dùng Ultralytics; model keypoint tự viết trên torchvision (BSD-3); xác nhận với pháp chế |
| Hiệu năng Orin Nano chưa biết | Không tính được số Jetson cần mua | Mua sớm 1 dev kit chỉ để benchmark |
| Bias do bỏ frame mờ khi máy chạy tải | Predict học trên dữ liệu lệch | Shutter nhanh, giá tách rung; log tỷ lệ reject theo trạng thái máy |
| Mạng OT xưởng hạn chế | Không đẩy được dữ liệu hoặc OTA | Xác nhận sớm với IT Denso về VLAN, cổng 8883, NTP nội bộ |
| Edge xóa buffer khi broker PUBACK, trước khi bản tin tới Kafka | Mất dữ liệu nếu tràn hàng đợi broker hoặc node broker chết trước khi bridge đọc | GD2: đo giới hạn hàng đợi, tăng `max_mqueue_len`, ≥2 replica bridge, alert subscriber = 0. GD4: edge giữ bản tin trong SQLite 24 giờ sau PUBACK + topic `.../cmd/resend` cho khoảng seq; service state tự yêu cầu resend khi phát hiện mất |

**Câu hỏi cần chốt với team và Denso**

- [ ] Số máy thực tế và số đồng hồ mỗi máy?
- [ ] Predict cần biến nào, ở tần số nào (1 s hay 1 phút)?
- [ ] Server đặt tại nhà máy hay cloud?
- [ ] Ai gắn camera và ai làm commissioning tại trạm?
