# gauge-twin

Hệ thống edge đọc đồng hồ công nghiệp bằng camera, chỉ gửi số/text về server qua
MQTT → Kafka → TimescaleDB. Đặc tả đầy đủ: [docs/SPEC.md](docs/SPEC.md).

## Bắt đầu trong 5 phút

Yêu cầu duy nhất trên máy: **Docker** (có Compose v2, cấp ≥ 6 GB RAM) và **make**.
Go, buf, protoc, golang-migrate, Python 3.11 và các linter chạy trong image tools
(`tools/Dockerfile`), không cần cài lên máy.

```bash
make up        # dựng hạ tầng profile dev, chờ healthcheck, tạo topic Kafka
make migrate   # tạo schema TimescaleDB
make test      # sinh code từ proto, chạy test Go + Python + migration
```

Lần đầu `make up` phải tải vài GB image (riêng TimescaleDB đã gần 3 GB sau khi giải nén). Kiểm tra nhanh sau khi chạy:

| Thành phần | Địa chỉ trên máy | Đăng nhập |
| --- | --- | --- |
| EMQX (MQTT) | `localhost:1883` | — |
| EMQX dashboard | <http://localhost:18083> | `admin` / `public` |
| Redpanda (Kafka API) | `localhost:19092` | — |
| TimescaleDB | `localhost:5432`, db `gauge` | `gauge` / `POSTGRES_PASSWORD` |
| Redis | `localhost:6379` | — |
| MinIO | <http://localhost:9001> (console), S3 ở `:9000` | `gauge` / `MINIO_ROOT_PASSWORD` |
| Prometheus | <http://localhost:9090> | — |
| Grafana | <http://localhost:3000> | `admin` / `GRAFANA_PASSWORD` |
| MediaMTX (RTSP) | `rtsp://localhost:8554` | — |

Mật khẩu không nằm trong repo: lần `make` đầu tiên, `infra/compose/gen-env.sh` sinh ngẫu nhiên
`POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`, `GRAFANA_PASSWORD` và `EMQX_COOKIE` vào `infra/compose/.env`
(file này bị git bỏ qua); xem ở đó khi cần đăng nhập. Nếu cổng nào đã bị chiếm, đổi cổng trong cùng file
(mẫu: `infra/compose/.env.example`). Bên trong mạng Docker `gauge-twin`, các
service luôn gọi nhau bằng tên: `emqx:1883`, `redpanda:9092`, `timescaledb:5432`,
`redis:6379`, `minio:9000`.

## Lệnh make

| Lệnh | Việc làm |
| --- | --- |
| `make up` | Profile dev: 1 EMQX, 1 Redpanda + TimescaleDB, Redis, MinIO, Prometheus, Grafana, MediaMTX |
| `make up-cluster` | Profile cluster: 3 node EMQX, 3 broker Redpanda + phần còn lại (chạy `make down` trước khi đổi profile) |
| `make down` | Dừng mọi thứ, giữ dữ liệu; `make down DOWN_FLAGS=-v` xóa cả volume |
| `make proto` | `buf lint` rồi sinh code Go, Python (và C++ cho `frame_result`) vào `gen/` |
| `make migrate` | Áp dụng migration trong `schemas/sql`; `make migrate-down` lùi một bước |
| `make test` | `test-go`, `test-py`, `test-sql` (migration chạy trên một TimescaleDB tạm) |
| `make lint` | buf, golangci-lint, ruff, kiểm tra file compose |
| `make breaking` | So proto với nhánh `main`, báo thay đổi phá vỡ tương thích |
| `make render ARGS="..."` | Sinh video trạm giả lập kèm ground truth (xem bên dưới) |
| `make sim-up` / `make sim-down` | Phát lặp các video trong `data/sim/` thành luồng RTSP |
| `make edge-sim ARGS="..."` | Giả lập N edge-agent bắn tải MQTT (cần `make up`) |
| `make test-integration` | Test tích hợp với EMQX, Redpanda, TimescaleDB, Redis thật (cần `make up && make migrate`) |
| `make server-up` / `make server-down` | Chạy các service server: mqtt-bridge ×2, config-api ×2, ingest ×2, state, query-api |
| `make seed-configs MACHINES=200` | Đăng ký config cho các máy mà edge-sim giả lập vào config-api |
| `make seqcheck` | Đối chiếu log seq của edge-sim với DB: mất, trùng, reject, flag |
| `make edge-up` / `make edge-down` | Chạy một edge giả lập: `ds-sim` + edge-agent |
| `make telemetry-tail ARGS="--seconds 30"` | In telemetry và status dạng JSON để debug |
| `make test-ds-sim`, `make test-zmq-interop` | Test `ds-sim`; kiểm tra ZeroMQ thuần Go nói chuyện được với libzmq |

Topic Kafka được tạo sẵn: `gauge.telemetry` (24 partition, giữ 7 ngày),
`gauge.status` và `gauge.rejected` (6), `gauge.dlq` (3).

## Sinh dữ liệu mô phỏng

```bash
make render ARGS="--stations 20 --minutes 30 --fps 10 --seed 42 --out data/sim/"
```

Mỗi trạm ra một thư mục `data/sim/machine_NNN/`:

| File | Nội dung |
| --- | --- |
| `video.mp4` | H.264 1920x1080, 3–5 đồng hồ trên nền tủ máy |
| `groundtruth.parquet` | Mỗi dòng là (frame, đồng hồ): `ts_ms`, `gauge_id`, `value`, `text`, cùng tham số nhiễu của frame |
| `station_config.json` | Config trạm đúng `config.proto`: `roi`, `quad`, `rect_size`, `calib`, `rules` |
| `render_meta.json` | Seed, mức nhiễu, phép warp và thông số giao diện từng đồng hồ |
| `frames/*.png` | Vài frame gốc trước khi nén, dùng để đối chiếu từng pixel |

Tùy chọn thêm: `--noise none|low|medium|high` (mặc định `medium`), `--workers N`,
`--keep-frames N`. Cùng `--seed` luôn cho cùng kết quả; `redraw_frame()` trong
`gauge_renderer.render` vẽ lại một frame bất kỳ từ ground truth, trùng từng pixel với
frame gốc trước khi nén. `ts_ms` tính từ đầu video.

## Camera giả qua RTSP

```bash
make up && make render ARGS="--stations 20 --minutes 30 --out data/sim/"
make sim-up                                   # mỗi video thành rtsp://mediamtx:8554/<machine_id>
make sim-check MACHINE=machine_001 READ_SECONDS=30 LENGTH=12
```

Video được phát lặp bằng `ffmpeg -c copy`, không encode lại. `sim-check` đọc luồng
`READ_SECONDS` giây (phải dài hơn `LENGTH`, độ dài video tính bằng giây) và báo lỗi nếu
timestamp nhảy lùi hoặc nhảy quá 1 giây ở điểm nối vòng lặp. Từ máy host, luồng nằm ở
`rtsp://localhost:8554/<machine_id>`.

## Giả lập edge (edge-sim)

```bash
make edge-sim ARGS="--machines 1000 --window 1 --duration 10m"
make edge-sim ARGS="--machines 1000 --machines-per-edge 4 --window 0.2 --duration 5m \
                    --faults out_of_range,bad_schema,duplicate,clock_skew,disconnect --fault-rate 0.05"
```

| Flag | Ý nghĩa |
| --- | --- |
| `--machines` | Tổng số máy |
| `--machines-per-edge` | Số máy dùng chung một edge, tức một kết nối MQTT (mặc định 1); `seq` đếm theo edge |
| `--window` | Độ dài cửa sổ (giây); mỗi máy gửi đúng 1 bản tin mỗi cửa sổ |
| `--duration` | Thời gian chạy, ví dụ `10m`; 0 là chạy tới khi bị ngắt |
| `--faults`, `--fault-rate` | Lỗi bơm và tỷ lệ bản tin bị bơm lỗi (0..1) |
| `--disconnect-every`, `--disconnect-for` | Khoảng cách trung bình giữa hai lần cắt mạng của một edge và độ dài mỗi lần |
| `--buffer-max`, `--replay-rate` | Dung lượng buffer offline (bản tin/edge) và tốc độ xả (bản tin/giây/edge) |

Mọi flag đều đặt được qua biến môi trường `EDGE_SIM_<TÊN>` (ví dụ `EDGE_SIM_MACHINES`).
Metric Prometheus ở <http://localhost:9100/metrics>, kiểm tra sống ở `/healthz`.

Log seq nằm ở `data/edge-sim/seq.jsonl`, mỗi dòng là một lần publish đã được broker xác nhận:

```json
{"ts_ms":1759490000123,"edge_id":"edge-0001","machine_id":"machine_001","seq":17,"window_end_ms":1759490000000,"fault":"","replayed":false,"acked":true}
```

Khi đối chiếu với DB: số dòng mong đợi là số cặp (`edge_id`, `seq`) khác nhau có `acked = true`.
Dòng `fault = "bad_schema"` có `seq = 0` và phải nằm ở `gauge.rejected`; dòng
`fault = "duplicate"` lặp lại một cặp đã có. Dòng `acked = false` là bản tin chưa gửi được
khi tắt (edge-sim thoát với mã 3 nếu có).

Status và LWT của một edge được publish trên topic `status` của **máy đầu tiên** của edge đó;
bản tin liệt kê mọi máy trong `machine_ids`.

## Server

```bash
make up && make migrate      # hạ tầng và schema
make server-up               # mqtt-bridge, config-api, ingest, state
make seed-configs MACHINES=200
make edge-sim ARGS="--machines 200 --window 1 --duration 5m --faults out_of_range,bad_schema,duplicate,clock_skew"
make seqcheck                # mọi bản tin broker đã xác nhận phải có trong DB
```

Luồng: edge → EMQX → **mqtt-bridge** → Kafka → **ingest** → TimescaleDB + Redis; **state** theo dõi
edge; **config-api** quản lý config trạm; **query-api** cho giao diện đọc dữ liệu. Dashboard Grafana: "gauge-twin: server pipeline".

| Service | Việc làm | Điểm cần biết |
| --- | --- | --- |
| mqtt-bridge | MQTT → Kafka, key = `machine_id` | Chỉ ack MQTT sau khi Kafka xác nhận. Mỗi replica có client ID cố định và session bền: replica chết phải được khởi động lại đúng ID cũ để nhận lại hàng đợi của nó |
| config-api | REST `GET/PUT/DELETE /v1/stations/{machine_id}` (cổng 8090, 8091) | Server tự tăng `config_version`; publish retained lên MQTT, tự thử lại khi broker sập |
| ingest | Kafka → `gauge_reading`, Redis `latest:*`, `hourmeter:*` | Commit offset sau khi ghi DB; ghi idempotent. Vi phạm ràng buộc thì vẫn ghi, gắn flag và hạ quality xuống tối đa 0,3 |
| state | Topic status → `edge_node`, Redis; theo dõi seq theo edge | Seq thiếu chỉ tính là mất sau 10 phút khi edge online và buffer đã rỗng |
| query-api | REST chỉ đọc cho màn giám sát trực tiếp (cổng 8092): trạm, giá trị mới nhất, xu hướng, một khung hình camera | Chỉ đọc PostgreSQL; mọi truy vấn sắp theo `ts`. Trạng thái `ok`/`poor`/`alarm`/`stale` của từng đồng hồ do service tính, xem `server/query-api/README.md` |

Xử lý lỗi của ingest:

- **Lỗi hạ tầng** (DB, Redis, Kafka): thử lại mãi với backoff tới 30 s, không commit offset, `/healthz`
  trả 503. Dữ liệu dồn ở Kafka.
- **Lỗi do dữ liệu**: sau 5 lần thì chia đôi batch tới khi tìm ra bản ghi gây lỗi; chỉ bản ghi đó vào
  `gauge.dlq`.
- **Sai schema**: vào `gauge.rejected` và bảng `rejected_reading`.
- **Máy chưa có config**: vẫn ghi, gắn `FLAG_NO_CONFIG`, không hạ quality.

EMQX được đặt `max_inflight`, `max_mqueue_len` và `force_shutdown.max_heap_size` lớn hơn mặc định
(xem `infra/compose/dev.yml`). Với mặc định, EMQX bỏ bản tin QoS 1 khi hàng đợi của subscriber đầy mà
publisher không hề biết.
## Danh mục camera

Camera là tài nguyên riêng, không thuộc máy nào: khai một lần rồi đồng hồ của máy nào cũng có thể trỏ tới bằng
`camera_id`. Một camera đọc được đồng hồ của nhiều máy và một máy có thể cần nhiều camera.

| Route (config-api) | Việc làm |
| --- | --- |
| `GET /v1/cameras` | Danh sách camera, mỗi camera kèm các máy đang có đồng hồ trên nó |
| `PUT /v1/cameras/{camera_id}` | Tạo hoặc sửa (`name`, `location`, `url`, `sample_fps`). Đổi `url` hay `sample_fps` thì mọi máy dùng camera đó nhận config phiên bản mới |
| `DELETE /v1/cameras/{camera_id}` | 409 khi còn đồng hồ nằm trên camera |
| `POST /v1/commissioning/frame` | Nhận thêm `camera_id` để lấy một khung hình của camera trong danh mục |

Khi lưu config của máy, config-api chép `url` và `sample_fps` của các camera mà đồng hồ trỏ tới vào `cameras` của
config đó. Config phát xuống edge vì thế tự đủ, edge không cần đọc danh mục. Giao diện khai báo theo camera nằm ở
web KaizenFlow (mục Đồng hồ → Camera và khai báo); nó gọi config-api từ origin đặt trong `CORS_ALLOWED_ORIGIN`
(compose: `CONFIG_API_CORS_ORIGIN`, mặc định `http://localhost:5173`). Không đặt biến này thì config-api không
trả lời trang từ origin khác.

## Commissioning và nghiệm thu trạm

Trang <http://localhost:8090/commissioning/> (config-api; `?machine=<id>` mở thẳng một trạm): lấy frame từ camera,
khoanh vùng từng đồng hồ, chấm tâm/min/max, xem trước giá trị rồi lưu config. `preview-svc` chạy model của
`PREVIEW_MODEL_DIR`; việc giải mã dùng chung package `edge/decode` với edge-agent.

**Nghiệm thu** là bước cuối, làm tại chỗ: kỹ thuật viên nhập giá trị đang thấy trên đồng hồ, hệ thống lấy một frame mới,
đọc bằng đúng bộ giải mã của edge và so sánh.

| Quy tắc | Mặc định | Biến môi trường của config-api |
| --- | --- | --- |
| Đồng hồ kim: lệch tối đa | 2% toàn thang | `ACCEPT_DIAL_TOLERANCE_PERCENT` |
| Màn hình số (7 đoạn, timer, số lăn) | đúng từng chữ số | — |
| Số mẫu đạt để chấp nhận một đồng hồ | 3, và không mẫu nào sai | `ACCEPT_MIN_SAMPLES` |

- Một mẫu sai là đồng hồ **không đạt**: chỉnh lại vùng/calib, xóa mẫu rồi làm lại. Đồng hồ model không đọc được
  (ví dụ kim có đối trọng lớn) lộ ra ngay ở bước này thay vì âm thầm gửi dữ liệu sai.
- Mẫu đọc đúng nhưng quality < 0,7 được đếm riêng: dữ liệu của đồng hồ đó sẽ bị loại khỏi `gauge_1m`.
- Mỗi mẫu được lưu cùng frame của nó ở `ACCEPTANCE_DIR` (volume `acceptance`, hoặc thư mục host qua
  `ACCEPTANCE_DATA_DIR`): `<machine>/<gauge>/<ts_ms>.json` và `.jpg`. Đây là ảnh có nhãn của chính hiện trường, dùng để
  fine-tune model sau này.

API: `POST /v1/commissioning/acceptance` (`config`, `gauge_id`, `truth`), `GET /v1/commissioning/acceptance/{machine}`,
`DELETE /v1/commissioning/acceptance/{machine}/{gauge}`, `GET .../{machine}/{gauge}/{id}.jpg`.

## Edge: ds-sim và edge-agent

Edge thật gồm `ds-pipeline` (DeepStream, cần GPU NVIDIA) và `edge-agent`. Khi chưa có GPU, `ds-sim`
thay cho `ds-pipeline`: nó làm đúng việc đó trên CPU bằng onnxruntime và là chuẩn đối chiếu sau này.

```bash
make up                                          # EMQX, MediaMTX...
make render ARGS="--stations 8 --minutes 2 --out data/sim"
make sim-up                                      # 8 luồng RTSP
make export-dial export-digit                    # cần model đã train trong data/ml-runs
make edge-up EDGE_MACHINES="SIM/L01/machine_001,SIM/L01/machine_002"
make telemetry-tail ARGS="--seconds 30"
```

Luồng dữ liệu: RTSP → `ds-sim` (cắt ROI, warp ô chữ số, chạy `dial_pose` và `digit_cls`, đo độ nét,
lóa, lệch ROI) → `FrameResult` qua ZeroMQ → edge-agent (giải mã theo `calib`, gom cửa sổ, quality,
flag) → SQLite → MQTT.

- **Config**: edge-agent nhận config retained trên topic `config`, ghi ra thư mục dùng chung rồi gửi
  lệnh `RELOAD_CONFIG` cho pipeline. Config chỉ được dùng và báo trong heartbeat sau khi pipeline trả
  lời `ok`. Khi chưa có config-api, `make edge-up` chép sẵn `station_config.json` của từng trạm vào
  thư mục đó.
- **Buffer**: mọi bản tin ghi vào SQLite trước khi publish; sau PUBACK giữ thêm 24 giờ để phục vụ
  `cmd/resend`. Giới hạn 500 MB thắng thời gian giữ: đầy thì xóa bản đã PUBACK cũ nhất trước.
- **Resend**: server publish `ResendRequest` lên `denso/{plant}/edge/{edge_id}/cmd/resend`; edge gửi
  lại với `replayed = true` và trả `ResendAck` (số đã gửi, khoảng seq không còn).
- **Nhiều camera**: một máy có thể khai thêm camera trong `cameras` và gán từng đồng hồ bằng `camera_id`;
  một camera cũng có thể nằm trong config của nhiều máy (cùng `url`), khi đó `ds-sim` mở luồng một lần và
  đọc đồng hồ của mọi máy trên cùng khung hình. Chi tiết ở SPEC mục 3.1.
- **Xem trực tiếp**: bình thường edge chỉ gửi số. Khi có người mở trang một máy, query-api publish `watch`
  và edge-agent bảo pipeline đính ảnh thu nhỏ (rộng tối đa 960 px) vào khung hình của các camera của máy đó;
  mỗi khung được publish lên `preview` cùng số đọc trên chính khung đó, nên ảnh và số luôn khớp. Hết người xem
  thì sau tối đa 60 giây edge ngừng gửi ảnh. Ảnh không được lưu ở đâu.
- **Watchdog**: camera im lặng quá `STALE_AFTER` (30 s) thì các đồng hồ của camera đó báo `FLAG_STALE` (đồng hồ
  trên camera khác của cùng máy vẫn có số) và pipeline nhận lệnh `RESTART` (tối đa một lần mỗi phút). Trước frame đầu tiên áp dụng `STARTUP_GRACE` (2 phút), vì
  mở luồng camera mất thời gian.
- **Tiền xử lý**: `ds-sim` đọc `<model>.preprocess.json` cạnh file ONNX, không tự đặt thông số.
- **Ngưỡng giải mã** (`DECODE_*`) là giá trị tạm, sẽ hiệu chỉnh ở GD5.

Biến môi trường chính của edge-agent: `EDGE_ID`, `EDGE_MACHINES` (`plant/line/machine`, cách nhau dấu
phẩy), `MQTT_BROKER`, `CONFIG_DIR`, `BUFFER_PATH`, `BUFFER_MAX_BYTES`, `FRAMES_ENDPOINT`,
`CONTROL_ENDPOINT`. Metric ở `:8080/metrics`.

## Model (ml/)

Hai model, đều train trên dữ liệu synthetic của renderer:

| Model | Đầu vào | Đầu ra |
| --- | --- | --- |
| `dial_pose` | Ảnh cắt quanh một đồng hồ kim, chưa nắn, 256×256 RGB | 5 keypoint (center, start, end, mid, tip) + độ tin cậy từng điểm |
| `digit_cls` | Một ô chữ số 32×48 xám (sau khi warp `quad`) | 12 lớp: 0–9, blank, transition |

`dial_pose` là mạng heatmap tự viết trên backbone torchvision (MobileNetV3-small hoặc ResNet18);
repo không dùng Ultralytics. `ml/` chạy trong image riêng (`ml/Dockerfile`), không dùng image tools.

```bash
# 1. Sinh video (mỗi mức nhiễu một thư mục) và dựng dataset
make render ARGS="--stations 20 --minutes 5 --seed 1 --noise medium --keep-frames 0 --out data/sim-ml/medium"
make dataset                       # data/sim-ml -> data/ml (chia train/val/test theo trạm)

# 2. Train, đánh giá, export
make train-digit ARGS="--epochs 30"
make train-dial  ARGS="--epochs 60"
make eval-digit && make eval-dial  # ghi test-metrics.json cạnh checkpoint
make export-digit && make export-dial

make test-ml                       # test của ml/: render tập nhỏ, train vài epoch, export
```

Trên server GPU dùng cùng lệnh, thêm `TORCH_VARIANT=cu121 DEVICE=cuda ML_DOCKER_FLAGS="--gpus all"`.

- **Dataset** (`data/ml`): `dial/<split>/` gồm ảnh, `index.parquet` (keypoint, hộp cắt, `quad`, `calib`,
  giá trị) và nhãn YOLO-pose để chạy baseline; `digits/<split>.npz` gồm ảnh ô và nhãn.
- **Đánh giá kim**: keypoint dự đoán được đưa qua homography của `quad`, rồi nội suy góc trục→đầu kim
  theo `calib`; sai số tính bằng % toàn thang.
- **Đánh giá chữ số**: độ đúng từng ô và exact-match cả màn hình, báo hai số: trên mọi frame và riêng
  frame không có ô đang chuyển.
- **ONNX** (`data/ml-runs/onnx`): opset 17, H×W cố định, batch động. File `.json` đi kèm ghi định dạng
  vào/ra và TensorRT profile (`digit_cls` 1/32/128, `dial_pose` 1/8/32).
- **MLflow**: mặc định SQLite ở `data/mlflow/mlflow.db`, artifact ở `data/mlflow/artifacts`; đổi bằng
  `MLFLOW_TRACKING_URI`. Model đăng ký với tên `dial_pose` và `digit_cls`.
- **Dataset ảnh thật** (`ml/gauge_ml/dataset/public/`): train và chấm model chỉ bằng ảnh thật. Tải về
  `data/public/<tên>/` (không commit), rồi `build_real` gom thành `data/ml-real/` cùng định dạng với `data/ml`
  (chia train/val/test theo ảnh gốc, bản augment của Roboflow luôn cùng một phía):

  | Tên | Nguồn | Loại | Giấy phép | Dùng cho |
  | --- | --- | --- | --- | --- |
  | `lcd-digits` | Kaggle `markuspfeifer/lcd-digits` | ô LCD đồng hồ vạn năng (34.020) | CC0 | train/val/test; ô đóng khung lại (`slots.frame_digit`) |
  | `trodo` | Mendeley `6y8m379mkt` v2 | công tơ mét xe: số lăn cơ và LCD (21.229 ô) | CC BY 4.0 | train/val/test |
  | `meter-digits-tenth` | Kaggle `frankhaverland/tenthofstepofmeterdigits` | số lăn/LCD/LED đồng hồ nước, gas, điện (18.239), nhãn 0,1 bước | CC0 | train/val/test; x.3–x.7 thành lớp "đang chuyển" |
  | `seg7-cramatsu` | Kaggle `cramatsu/7-segment-display-yolov8` | LED 7 đoạn, hộp YOLO (2.640 ô) | MIT | train/val/test |
  | `yuva-eb` | Mendeley `fnn44p4mj8` v1 | công tơ điện LCD, ngày/đêm/mờ/nghiêng (977 ô) | CC0 | train/val/test |
  | `gauge-analog-kim` | Kaggle `nguyenhuynhhh/analog-label-kim` (Roboflow `khang-nguyen-4jqxa/gauge-analog`) | đồng hồ kim thật, keypoint center/min/max/tip (8.719 crop) | MIT | train/val/test; sai số tính theo phần trăm thang giữa vạch min và max |
  | `seg7-industrial` | Kaggle `thearshiya/7-segment-industrial-digits-dataset` | module LED 4 số trong nhà máy, số đọc ở tên file | không ghi | chỉ test; ô cắt từ vùng LED sáng, vị trí tắt bên trái là lớp "trống" |
  | `pressure-gauge` | Kaggle `juliusgrassme/pressure-gauge-reader-data`, 7 file `Data/2 Test videos/edited videos/man*cropclipscale.mp4` | video đồng hồ áp suất ở trạm bơm | CC BY-SA 4.0 | chỉ test; ground truth tự dựng (`pressure_gauge.py`) |
  | `time-displays` | Openverse + Wikimedia Commons, tự thu thập (`make time-displays`) | hour meter cơ/LCD, timer LED/LCD, đồng hồ số trên máy | theo từng ảnh (`manifest.csv`) | train/val/test với ảnh CC0/PDM/CC BY/CC BY-SA, ảnh khác chỉ test; nhãn tự động, xem dưới |

  ```bash
  kaggle datasets download -d markuspfeifer/lcd-digits -p data/public/lcd-digits --unzip
  kaggle datasets download -d frankhaverland/tenthofstepofmeterdigits -p data/public/meter-digits-tenth --unzip
  kaggle datasets download -d cramatsu/7-segment-display-yolov8 -p data/public/seg7-cramatsu --unzip
  kaggle datasets download -d thearshiya/7-segment-industrial-digits-dataset -p data/public/seg7-industrial --unzip
  kaggle datasets download -d nguyenhuynhhh/analog-label-kim -p data/public/gauge-analog-kim --unzip
  curl -L -o data/public/trodo/trodo-v01.zip \
    https://data.mendeley.com/public-files/datasets/6y8m379mkt/files/563bd4b1-26a5-42a4-ac7d-c7bf8573bccd/file_downloaded
  (cd data/public/trodo && unzip -q trodo-v01.zip)
  curl -L -o data/public/yuva-eb/coco.json \
    https://data.mendeley.com/public-files/datasets/fnn44p4mj8/files/cb924bf8-101d-41f1-9206-4958a7f867ec/file_downloaded
  curl -L -o data/public/yuva-eb/raw.zip \
    https://data.mendeley.com/public-files/datasets/fnn44p4mj8/files/b5130583-7852-4995-8421-36bf7b2857b7/file_downloaded
  (cd data/public/yuva-eb && unzip -q raw.zip)
  for i in 1 2 3 4 5 6 7; do kaggle datasets download -d juliusgrassme/pressure-gauge-reader-data \
    -f "Data/2 Test videos/edited videos/man${i}cropclipscale.mp4" -p data/public/pressure-gauge; done
  (cd data/public/pressure-gauge && for z in *.zip; do unzip -oq "$z" && rm "$z"; done)

  python -m gauge_ml.dataset.build_real --public data/public --out data/ml-real   # trong image ml
  make train-digit train-dial ML_DATA=data/ml-real ML_RUNS=data/ml-runs/real  # không ghi đè data/ml-runs
  make eval-public ONNX_DIR=data/ml-runs/onnx        # chấm ONNX trên các bộ ảnh thật
  ```

  `time-displays` không có nhãn tay: `gauge_ml.timedisp.collect` tải ảnh có license ghi rõ (bỏ ảnh trùng gần nhau),
  `gauge_ml.timedisp.autolabel` cho Claude khoanh vùng số, OpenCV tìm quad và hộp từng chữ số, rồi Claude và Gemini
  đọc độc lập; ảnh chỉ được nhận khi hai bên trùng từng chữ số và khớp số ô. Model `digit_cls` không tham gia gán nhãn.
  Ảnh khó dễ bị loại hơn nên tập test dễ hơn thực tế: đọc điểm kèm `report.json` (tỉ lệ loại theo lý do).
  `--audit 50` sinh `audit.html` để xem nhanh 50 nhãn ngẫu nhiên và đếm nhãn sai. Câu trả lời của VLM được cache trong
  `cache/`, chạy lại không tốn phí.

  ```bash
  export ANTHROPIC_API_KEY=... GEMINI_API_KEY=...
  make time-displays ARGS="--limit 30 --audit 30"   # chạy thử, xem report.json và audit.html
  make time-displays ARGS="--audit 50"              # phần còn lại (ảnh đã gán nhãn được bỏ qua)
  ```

  **Thêm ô LED giả lập vào dữ liệu thật.** Dữ liệu thật có ít màn hình LED (phần lớn ô `seg7` là LCD), nên
  `gauge_ml.dataset.led_slots` sinh ô LED 7 đoạn như camera thấy ở xưởng (đoạn tắt vẫn lộ, LED cháy trắng có quầng
  màu, chữ số bên cạnh lấn vào, ô cắt lệch) và trộn vào tập train/val; tập test giữ nguyên là ảnh thật.

  ```bash
  python -m gauge_ml.dataset.led_slots --real data/ml-real --out data/ml-led-mix --train 15000 --val 1500   # trong image ml
  make train-digit ML_DATA=data/ml-led-mix ML_RUNS=data/ml-runs/led-mix
  ```

  Đo ngày 2026-10-08, exact-match cả màn hình trên `eval-public`, so với cùng cách train chỉ bằng ảnh thật:
  `seg7-industrial` 26,2% → 33,8% (15.000 ô) hoặc 36,7% (60.000 ô); `trodo` 96,0% → 95,1% hoặc 94,2% (phần giảm
  nằm ở số lăn); các bộ còn lại lệch dưới 1 điểm. Càng nhiều ô giả lập thì LED càng tốt và số lăn càng giảm.

  Chưa có loader (phải tải tay qua trình duyệt hoặc xin phép): SCUT-WMN, WMeter5K (OneDrive), đồng hồ nước
  word-wheel (Dryad, CC0), Copel-AMR/UFPR-AMR/UFPR-ADMR (đơn license có chữ ký tổ chức), các bộ Roboflow cần API
  key. Bộ phi thương mại chỉ dùng cho nghiên cứu; không train model bàn giao khi chưa hỏi pháp chế.

## Chạy đầu-cuối với video thật

Không cần thiết bị edge: `ds-sim` chạy model trên CPU, video đồng hồ áp suất thật (bộ `pressure-gauge`) phát lặp qua
RTSP, và giá trị trong DB được đối chiếu với ground truth của video.

```bash
python -m gauge_ml.real_stations --public data/public --out data/sim-real   # trong image ml: video, config, ground truth
make up && make migrate && make server-up
for d in data/sim-real/pump_*; do curl -s -X PUT -H 'Content-Type: application/json' \
  --data @$d/station_config.json http://localhost:8090/v1/stations/$(basename $d) >/dev/null; done
export SIM_DATA_DIR="$PWD/data/sim-real" EDGE_MODEL_DIR="$PWD/data/ml-runs/onnx" EDGE_SEED_CONFIGS=0
make sim-up
make edge-up EDGE_MACHINES="$(ls data/sim-real | grep pump_ | sed 's|^|REAL/PUMP/|' | paste -sd, -)"
# sau khoảng 8 phút (video dài nhất 394 s):
docker exec gauge-twin-timescaledb-1 psql -U gauge -d gauge -c "\copy (select machine_id, extract(epoch from ts), value,
  quality, array_to_string(flags, ' '), n_frames from gauge_reading where machine_id like 'pump_%' order by ts)
  to stdout csv" > data/sim-real/readings.csv
python -m gauge_ml.e2e_real --stations data/sim-real --readings data/sim-real/readings.csv   # trong image ml
```

`EDGE_SEED_CONFIGS=0` để edge nhận config từ config-api qua MQTT thay vì file chép sẵn. Video phát lặp nên
`e2e_real` tự ước lượng độ lệch pha của từng luồng trước khi so.

## Cấu trúc repo

```text
schemas/   proto/ và sql/ — nguồn sự thật duy nhất cho mọi struct và bảng
gen/       code sinh từ proto (không commit; `make proto` tạo lại)
edge/      ds-pipeline (C++/DeepStream, chưa có), edge-agent (Go)
server/    mqtt-bridge, ingest, state, alert, config-api, query-api, pkg/ (Go)
sim/       gauge-renderer, ds-sim, accuracy-eval (Python), edge-sim (Go)
ml/        dataset-builder, train, eval, export ONNX (image riêng)
infra/     compose/, grafana/, k8s/
loadtest/  seed-configs.sh, seqcheck.sh; kịch bản tải 1–8 (chưa có)
tools/     image chứa toolchain
```

## Quy ước schema

- Muốn đổi proto hoặc bảng: sửa trong `schemas/`, không định nghĩa lại struct ở nơi khác.
- Proto: package `denso.gauge.v1`, lint theo bộ rule `STANDARD` của buf (tên mới của `DEFAULT`).
- Migration: mỗi thay đổi là một cặp file `NNNNNN_ten.up.sql` / `.down.sql`. Câu lệnh
  không chạy được trong transaction (ví dụ tạo continuous aggregate) phải nằm riêng
  một file, một câu lệnh.
- Go dùng code sinh ra qua module `gauge-twin/gen/go`; Python thêm `gen/python` vào
  `PYTHONPATH` (pytest đã cấu hình sẵn trong `pyproject.toml`).
