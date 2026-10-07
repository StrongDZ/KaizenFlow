# Cài đặt KaizenFlow từ đầu

Hướng dẫn dựng toàn bộ hệ thống trên một máy mới: từ clone code đến khi mở được giao diện và chạy được demo. Các lệnh trong file này đã được chạy thử trên macOS (Apple Silicon); Linux làm tương tự.

## 1. Cần cài gì

Có hai cách chạy. **Cách A (Docker)** nhanh nhất, đủ để dùng và demo. **Cách B (dev đầy đủ)** để sửa code hoặc chạy test.

| Công cụ | Cách A | Cách B | Ghi chú |
|---|---|---|---|
| Docker + Compose v2 | bắt buộc | bắt buộc | Docker Desktop hoặc Docker Engine; cần `docker compose` (không có dấu gạch) |
| Node.js | bắt buộc | bắt buộc | 20.19 trở lên (Vite 7 yêu cầu); đã thử với 25. Kèm `npm` |
| Python | chỉ để chạy `scripts/seed_demo.py` (không cần thư viện ngoài) | 3.12 | Sim và feed dùng 3.12 (đúng với image Docker). Bản mới hơn chưa được thử |
| Go | không cần | 1.26.3 | `go.mod` ghi rõ; chỉ cần khi chạy API ngoài Docker hoặc chạy test Go |
| Git | bắt buộc | bắt buộc | |

Các cổng sau phải còn trống:

| Cổng | Dịch vụ |
|---|---|
| 5433 | Postgres + TimescaleDB |
| 8081 | sim (mô phỏng) |
| 8080 | API (Go) |
| 8090 | feed (bộ phát dữ liệu giả lập) |
| 5173 | web (Vite dev server) |

## 2. Lấy code

```bash
git clone https://github.com/StrongDZ/KaizenFlow.git
cd KaizenFlow
```

Repo là private: cần đăng nhập GitHub (`gh auth login` hoặc token) trước khi clone. Nhánh chính là `main`.

> **Đừng đặt repo trong thư mục đang đồng bộ iCloud** (mặc định `~/Documents` và `~/Desktop` trên macOS nếu bật "Desktop & Documents"). iCloud sẽ tự tạo bản sao dạng `tên 2.go`, `tên 2.tsx` mỗi khi Git ghi lại nhiều file (checkout, merge), làm hỏng build. Xem mục 8.

## 3. Cách A: chạy bằng Docker (5 bước)

```bash
# 1. Dựng và bật 4 dịch vụ: db, sim, api, feed (lần đầu mất vài phút để build)
docker compose up -d --build

# 2. Kiểm tra: cả 4 phải "running", db phải "healthy"
docker compose ps

# 3. Nạp dữ liệu demo: 2 mô hình, kịch bản, vật tư, bản đồ AGV (chạy lại nhiều lần vẫn an toàn)
python3 scripts/seed_demo.py

# 4. Cài và chạy giao diện web
cd web
cp .env.example .env
npm install
npm run dev
```

Mở **http://localhost:5173**. Kiểm nhanh từng dịch vụ bằng `curl`:

```bash
curl localhost:8080/api/health     # {"status":"ok"}
curl localhost:8090/health         # {"status":"ok"}
curl localhost:8080/api/models     # danh sách mô hình (sau khi seed có denso-mini và denso-plant)
```

API tự chạy migration khi khởi động và tự nạp 14 loại node mẫu cùng vật tư mặc định khi các bảng này còn trống. Hai việc đó không cần làm tay.

### Thử ngay phần Live twin

1. Mở mô hình `denso-plant`; đầu trang **Phiên bản** có danh sách Thiết lập cho biết bước nào đã xong. Vào tab **Nguồn dữ liệu**.
2. Bấm **Bắt đầu phát dữ liệu giả lập** (chọn ×60 cho nhanh) ở tab **Nguồn dữ liệu** để thấy các thiết bị hiện ra, rồi sang **Kết nối dữ liệu**: **Gợi ý ghép tự động** và **Áp dụng**.
3. Sang tab **Trực tiếp**: workflow chạy theo dữ liệu thật; bấm **Dự báo từ bây giờ**; thử bơm sự cố.
4. Tab **Bản đồ AGV**: xe chạy, bấm một làn để chặn. Thử khung toạ độ: Đặt lại feed, tick **Hãng xe báo toạ độ riêng** rồi bắt đầu; xe sẽ "ngoài đường" cho tới khi bạn mở thẻ **Khung toạ độ xe** → Chỉnh khung → chọn một xe đang đứng yên và điểm nó đang đỗ (làm 2–3 cặp) → Tính khung → Lưu khung. Muốn quay lại feed thường thì Lưu khung "Về không đổi". Bản đồ cũ (đơn vị vẽ × `unit_m`) tự đổi sang mét khi đọc.

Kịch bản demo đầy đủ nằm trong `README.md`.

## 4. Cách B: chạy từng dịch vụ ngoài Docker (để dev)

Chỉ giữ Postgres trong Docker, các dịch vụ còn lại chạy trực tiếp để sửa code và thấy kết quả ngay. Mở mỗi lệnh ở một terminal riêng.

```bash
# 0. Postgres
docker compose up -d db

# 1. Môi trường Python dùng chung cho sim và feed (một lần)
cd services/sim
python3.12 -m venv .venv
.venv/bin/pip install -e ".[dev]" -e ../feed
cd ../..

# 2. sim, cổng 8081
cd services/sim && SIM_WORKERS=2 .venv/bin/uvicorn sim_service.api:app --port 8081

# 3. API, cổng 8080 (đọc cấu hình mặc định trỏ tới db :5433 và sim :8081)
cd services/api && go run ./cmd/api

# 4. feed, cổng 8090 (dùng lại venv của sim)
cd services/feed && ../sim/.venv/bin/uvicorn feed_service.app:app --port 8090

# 5. web, cổng 5173
cd web && cp .env.example .env && npm install && npm run dev
```

Sau đó nạp dữ liệu demo như ở cách A: `python3 scripts/seed_demo.py`.

Nếu muốn API ngoài Docker mà vẫn dùng sim hay feed trong Docker (hoặc ngược lại), đặt biến môi trường ở mục 6 cho khớp địa chỉ.

## 5. Chạy test

```bash
# Go: cần Postgres đang chạy (docker compose up -d db). Mỗi test tự tạo một database kf_test_* riêng
cd services/api && go vet ./... && go test ./...

# sim và feed: dùng venv ở mục 4
cd services/sim  && .venv/bin/python -m pytest
cd services/feed && ../sim/.venv/bin/python -m pytest

# web: test đơn vị, kiểm kiểu, build
cd web && npx vitest run && npx tsc -b && npm run build
```

Kết quả mong đợi tại thời điểm viết: sim 84 test, feed 50 test, web 491 test, Go tất cả gói `ok`. Con số có thể tăng khi thêm test; điều quan trọng là không có test nào đỏ.

Test đơn vị của web chỉ phủ phần logic thuần (thư mục `web/src/lib`). Giao diện được kiểm bằng cách mở trình duyệt.

## 6. Biến môi trường

Mọi biến đều có giá trị mặc định chạy được với Cách B, nên thường không cần đặt gì.

| Biến | Dịch vụ | Mặc định | Ý nghĩa |
|---|---|---|---|
| `KF_DB_URL` | api | `postgres://postgres:kaizen@localhost:5433/kaizenflow?sslmode=disable` | Kết nối Postgres |
| `KF_SIM_URL` | api | `http://localhost:8081` | Địa chỉ sim |
| `KF_FEED_URL` | api | `http://localhost:8090` | Địa chỉ feed (để proxy `/api/feed/*`) |
| `KF_ADDR` | api | `:8080` | Cổng lắng nghe |
| `SIM_WORKERS` | sim | `1` (Docker đặt `6`) | Số tiến trình chạy song song các lần lặp Monte Carlo |
| `KF_API_URL` | feed | `http://localhost:8080` (Docker: `http://api:8080`) | Địa chỉ API để feed đẩy dữ liệu |
| `FEED_TICK_S` | feed | `0.25` | Nhịp đẩy dữ liệu (giây thực) |
| `FEED_AUTOSTART_MODEL` | feed | trống | Đặt tên mô hình để feed tự chạy khi khởi động (tiện cho demo) |
| `FEED_AUTOSTART_SPEED` | feed | `10` | Tốc độ giờ nhà máy khi tự chạy |
| `VITE_API_URL` | web | `http://localhost:8080` | Địa chỉ API mà trình duyệt gọi (đặt trong `web/.env`) |
| `KF_TEST_DB` | test Go | `postgres://postgres:kaizen@localhost:5433/postgres?sslmode=disable` | Postgres dùng cho test Go |

Mật khẩu `kaizen` chỉ là mật khẩu Postgres cho môi trường dev cục bộ. Đổi nó trước khi đưa hệ thống ra ngoài máy cá nhân.

## 7. Dọn dẹp và làm lại từ đầu

```bash
docker compose down                 # dừng, giữ dữ liệu
docker compose down -v              # dừng và xoá cả database (làm lại sạch)
docker compose up -d --build api    # build lại một dịch vụ sau khi sửa code (api, sim hoặc feed)
python3 scripts/seed_demo.py        # nạp lại dữ liệu demo
```

Làm sạch hoàn toàn trước buổi demo: `docker compose down -v && docker compose up -d --build && python3 scripts/seed_demo.py`.

Hai điều cần nhớ: (1) kết quả các lần chạy mô phỏng chỉ nằm trong bộ nhớ của sim cho đến khi được lưu vào DB, nên sau khi sim khởi động lại hãy chạy lại run trước khi tải CSV; (2) feed không lưu trạng thái, container feed khởi động lại thì phải bấm **Bắt đầu** lại (hoặc đặt `FEED_AUTOSTART_MODEL`).

## 8. Xử lý sự cố

| Triệu chứng | Nguyên nhân thường gặp và cách xử lý |
|---|---|
| `port is already allocated` khi `docker compose up` | Cổng ở mục 1 đang bị chiếm. Tắt chương trình đó, hoặc đổi cổng bên trái trong `docker-compose.yml` |
| `go test` báo `test db unreachable` | Chưa bật Postgres: `docker compose up -d db` |
| Trang web hiện chữ trần, không có style | Cache Vite cũ làm Tailwind không sinh class. Dừng `npm run dev`, xoá `web/node_modules/.vite`, chạy lại |
| Tab Trực tiếp hoặc Kết nối dữ liệu báo "Chưa nối được feed service" | Feed chưa chạy: `docker compose up -d feed` rồi tải lại trang. Gọi `/api/feed/*` mà feed tắt sẽ ra 502 |
| Tab Trực tiếp hiện "Sơ đồ chưa nhận dữ liệu nào" | Chưa ghép tín hiệu nào (làm ở tab Kết nối dữ liệu), hoặc feed chưa bắt đầu |
| Node chuyển xám "mất tín hiệu" | Quá 15 giây thật không có bản tin: feed đang tạm dừng hoặc đã tắt |
| Bấm **Dự báo từ bây giờ** báo thiếu dữ liệu | Cần feed đang chạy và đã ghép ít nhất tín hiệu Tồn (`level:…`) của một kho |
| Dự báo 1 tuần rất chậm | Tăng `SIM_WORKERS` (không vượt quá số lõi CPU). Với 6 worker, 1 tuần × 20 lần lặp mất khoảng 20 giây |
| Xuất hiện file, thư mục tên `xxx 2.go`, `xxx 2.tsx`, `api 2/` và `go vet` báo lỗi lạ | iCloud tạo bản sao xung đột vì repo nằm trong `~/Documents` hoặc `~/Desktop`. Chuyển repo ra ngoài (ví dụ `~/Code`), rồi xoá các bản sao (`git status` sẽ liệt kê chúng ở mục untracked) |
| Docker build feed lỗi không thấy `services/sim` | Feed build với context là thư mục gốc repo (`docker-compose.yml` đã cấu hình). Chạy lệnh từ thư mục gốc, đừng `docker build` riêng trong `services/feed` |

## 9. Cấu trúc thư mục

```
KaizenFlow/
├── docker-compose.yml     db, sim, api, feed
├── contracts/             hợp đồng JSON giữa Go và sim (run.schema.json)
├── scripts/seed_demo.py   nạp mô hình, kịch bản, bản đồ AGV mẫu
├── services/
│   ├── sim/               Python, SimPy: mô phỏng Monte Carlo, phát hiện điểm nghẽn, đề xuất
│   ├── api/               Go: CRUD, resolve tham số, điều phối run, ingest dữ liệu live, WebSocket
│   └── feed/              Python: bộ phát dữ liệu "thật" giả lập, xe chạy trên bản đồ AGV
└── web/                   React + TypeScript: sơ đồ, Control Room, Kết nối dữ liệu, Trực tiếp, Bản đồ AGV
```

Kiến trúc, các quy tắc nghiệp vụ và kịch bản demo nằm trong `README.md`.
