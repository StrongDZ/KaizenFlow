# Cập nhật khi pull main

Mỗi lần main có thay đổi cần làm gì thêm ngoài `git pull` (migration DB, service mới, cách làm cũ bị
vỡ), ghi một mục ở đây. Mục mới nhất lên đầu.

---

## 12/10/2026 — Danh mục Thiết bị, nguồn dữ liệu toàn cục, cầu nối đồng hồ

Commit: `84bd7c0` → `b79f396`.

Tóm tắt một câu: `node_type` vẫn là **loại** trừu tượng, nhưng giờ có thêm **thiết bị** (`asset`) là
một cái máy thật định danh duy nhất toàn app, và node trong sơ đồ chỉ còn là **chỗ đặt** thiết bị
đó. Kèm theo: nguồn dữ liệu thành danh mục toàn cục, và số đọc đồng hồ chảy được vào live twin.

### 1. Lấy code

```bash
cd ~/Code/KaizenFlow
git fetch kaizenflow
git pull --ff-only kaizenflow main
```

### 2. Dựng lại backend — **bắt buộc có `--build`**

```bash
docker compose -p kf-main -f docker-compose.yml -f <override-của-bạn> up -d --build
```

Hai lý do không được bỏ `--build`:

- Có **4 migration mới** (`00008`–`00011`) nhúng trong binary Go, chạy tự động khi API khởi động.
  Image cũ không có chúng.
- Có **service mới `gauge-bridge`** (Python).

File override bỏ cổng feed (nếu máy bạn bị chiếm 8090) vẫn như cũ:

```yaml
services:
  feed:
    ports: !reset []
```

### 3. Nên xoá DB và seed lại

```bash
docker compose -p kf-main -f docker-compose.yml -f <override> down -v
docker compose -p kf-main -f docker-compose.yml -f <override> up -d --build
python3 scripts/seed_demo.py
python3 scripts/seed_video_demo.py   # bản đồ trên ảnh mặt bằng + 21 máy đồng hồ + scenario video
```

**Vì sao nên `down -v`:** migration tự chạy được trên DB cũ, nhưng nó suy thiết bị từ node đã có. Mã
node cũ dùng chung giữa các nhà máy ví dụ (`STAMP_1` có ở cả `denso-mini` và `denso-plant`) sẽ bị
gộp thành **một** thiết bị — tức hai cái máy khác nhau thành một. Seed mới đã tách không gian mã
(`MINI_`, `P5K_`) nên DB rỗng cho dữ liệu đúng. Mất các lần chạy cũ, nhưng chạy lại nhanh.

Nếu **không** muốn mất dữ liệu: migration vẫn chạy bình thường, chỉ cần vào mục **Thiết bị** kiểm
cột "Dùng trong" — thiết bị nào nằm trong hai nhà máy không liên quan thì đó là bị gộp, tách tay.

### 4. Web — không có dependency mới

```bash
cd web
VITE_GAUGE_API_URL=http://localhost:8097 \
VITE_GAUGE_CONFIG_API_URL=http://localhost:8094 \
npm run dev -- --port 5173
```

`package.json` không đổi nên không cần `npm install`. Nếu trang hiện chữ trần (Tailwind không sinh
class do cache Vite lỗi thời): xoá `web/node_modules/.vite` rồi chạy lại.

### 5. Về service `gauge-bridge`

Mặc định trỏ `GAUGE_QUERY_URL=http://host.docker.internal:8097`.

- **Không chạy stack gauge-twin**: cầu nối log `vòng này lỗi, thử lại sau` mỗi 5 giây rồi thôi,
  không ảnh hưởng gì. Muốn tắt hẳn: `docker compose -p kf-main stop gauge-bridge`.
- **gauge-twin ở cổng khác**: đặt `GAUGE_QUERY_URL` trong `.env` cạnh `docker-compose.yml`.

### 6. Ba thay đổi làm vỡ cách làm cũ

1. **Node trên sơ đồ phải là thiết bị đã khai.** `PUT /api/versions/{id}/graph` trả **422** nếu mã
   node chưa có trong danh mục Thiết bị. Script hay tool nào tự lưu sơ đồ phải `POST /api/assets`
   trước — xem `ensure_assets` trong `scripts/seed_demo.py`.
2. **Thả node trên editor giờ mở hộp chọn thiết bị**, không tự sinh mã nữa. Mã node **là** mã thiết bị.
3. **Gán đồng hồ cho máy phải chọn trong danh mục Thiết bị**, không gõ mã tự do (gõ tay sẽ sinh ra
   một cái máy chỉ khu Đồng hồ biết và số đọc không gắn vào đâu). Máy chưa khai thì dùng
   "+ Khai thiết bị mới…" ngay trong hộp đó.

### 7. Kiểm nhanh là xong

```bash
curl -s localhost:8080/api/assets  | python3 -c "import json,sys;print(len(json.load(sys.stdin)),'thiết bị')"
curl -s localhost:8080/api/sources | python3 -c "import json,sys;print(len(json.load(sys.stdin)),'nguồn')"
docker logs kf-main-gauge-bridge-1 --tail 3   # nếu chạy gauge-twin: "đẩy N số đọc của 21 máy"
```

Rồi mở `http://localhost:5173/assets` — thấy danh mục thiết bị là xong.

### 8. Cần biết về test

- Go: **13/13 package pass** — `cd services/api && go test ./...` (cần `docker compose up -d db`).
  Test `fmcg` TR32/TR33 vốn chập chờn, chạy lại là xanh.
- Web: `cd web && npx vitest run` → **6 fail** ở `WarehousePopover.test.tsx` và một lỗi thiếu
  `jsdom` cho `BenchmarkPanel.test.tsx`. Hai cái này **đã đỏ từ trước**, không phải do lần này.

### 9. Chưa kiểm bằng tay

Hai chỗ mới nhất chỉ được kiểm qua typecheck và test API, **chưa bấm thử trong trình duyệt**:

- thả node trên editor → hộp chọn thiết bị,
- ô chọn máy ở trang Camera của khu Đồng hồ.

Ai mở trước thì xác nhận giúp (hoặc sửa) trước khi quay video demo.
