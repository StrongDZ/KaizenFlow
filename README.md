# KaizenFlow — Digital twin logistics (DENSO Factory Hacks 2026 · D2)

Mô phỏng workflow nhà máy → dự báo rủi ro Đỏ → phát hiện điểm nghẽn → đề xuất hành động đã kiểm chứng bằng mô phỏng.

## Chạy

```bash
docker compose up -d --build        # db (TimescaleDB :5433), sim (:8081), api (:8080), feed (:8090, bộ phát dữ liệu giả lập)
python3 scripts/seed_demo.py        # dựng 2 mô hình demo (`denso-mini` dây chuyền thẳng, `denso-plant` nhiều kho nối nhiều máy) kèm bản đồ AGV của từng mô hình; idempotent
cd web && cp .env.example .env && npm install && npm run dev   # http://localhost:5173
```

Test: `cd services/sim && pytest` · `cd services/feed && ../sim/.venv/bin/python -m pytest` · `cd services/api && go test ./...` (cần `docker compose up -d db`) · `cd web && npx vitest run`.

### Giao diện web (dev)

- `cd web && npm install && npm run dev` (mặc định `http://localhost:5173`, API ở `VITE_API_URL`).
- Theme tối là mặc định; nút mặt trời/mặt trăng ở góc phải header đổi sang sáng và nhớ lựa chọn (`localStorage`, khoá `kf-theme`). Trang Báo cáo và bản in luôn dùng theme sáng.
- Editor (sơ đồ): kéo trên vùng trống để chọn nhiều node (Shift/Ctrl/⌘ + bấm để thêm), Space hoặc chuột giữa hoặc công cụ Bàn tay (`H`) để kéo canvas, `Ctrl/⌘ + C/V/D` sao chép, dán, nhân đôi (dán được sang phiên bản khác trong cùng tab), `Ctrl/⌘ + Z / Shift+Z` hoàn tác và làm lại nhiều bước, `Ctrl/⌘ + S` lưu, `?` xem bảng phím tắt. Thêm node: nút "Thêm node" (danh sách có ô tìm), `Tab` hoặc `/` hoặc bấm đúp chỗ trống (ô tìm tại con trỏ), hoặc thả dây từ một chấm ra chỗ trống để thêm và tự nối. Thanh công cụ ngang ở đáy gộp thu phóng, "Xếp ngang/dọc" (tự sắp xếp, chỉ bản DRAFT), hoàn tác, khoá sơ đồ. Hướng sơ đồ suy ra từ vị trí node, không lưu riêng. Rời trang khi chưa lưu thì trình duyệt hỏi lại (chuyển trang trong app thì chưa có cảnh báo).
- Control Room: hạt chạy trên edge cho thấy hàng đang chảy. Số hạt tỉ lệ với lưu lượng thật (chỉ số `moved` của sim, trung bình 10 mốc gần nhất, so với mức bận điển hình của run); tốc độ theo thời gian di chuyển của edge (30 giây thật ≈ 1 giây trên màn hình). Replay chạy nhanh hơn thời gian thật hàng trăm lần nên không thể chảy 1:1. Run tạo trước khi có `moved` dùng `in_transit`.
- Nếu trang hiện chữ trần không có style (Tailwind không sinh class do cache Vite lỗi thời): dừng `npm run dev`, xoá `web/node_modules/.vite`, chạy lại.
- Phím tắt ở Control Room: `←` `→` bước 1 mốc, `Shift`+`←` `→` bước 10 mốc, `Space` phát/dừng, `Home` `End`, `F` chế độ tập trung, `Esc` thoát.
- Điều hướng: Tổng quan · Mô hình (Sơ đồ, Scenario, Lần chạy, Phiên bản) · Lần chạy · Thư viện (Node type, Vật tư). Mỗi loại object có bảng, trang chi tiết và các thao tác tạo, sửa, nhân bản, xoá theo quy tắc bất biến bên dưới.
- Font IBM Plex Sans được tự host (`web/src/fonts.css`, chỉ hai subset latin và vietnamese) nên demo không cần mạng.

## Kiến trúc

| Thành phần | Công nghệ | Vai trò |
|---|---|---|
| `services/sim` | Python, SimPy, FastAPI | Mô phỏng Monte Carlo, tiêm lỗi P-F + dữ liệu tổng hợp có nhãn, Detect, Recommend |
| `services/api` | Go, Postgres + TimescaleDB | Lưu model/scenario/run, validate, resolve tham số, điều phối, WebSocket |
| `services/feed` | Python, SimPy, FastAPI | Bộ phát dữ liệu "thật" giả lập: bọc engine sim chạy theo đồng hồ thật × tốc độ, xe chạy trên bản đồ AGV, bơm sự cố |
| `web` | React, React Flow | Editor, Scenario, Control Room, So sánh, Báo cáo, Kết nối dữ liệu, Trực tiếp, Bản đồ AGV |

Contract Go ↔ sim: `contracts/run.schema.json`. Thiết kế: `docs/superpowers/specs/`.

### Sửa và xoá (giao thức)

- `DELETE /api/models/{key}`, `/api/versions/{id}`, `/api/scenarios/{id}`: nếu còn dữ liệu phụ thuộc thì trả `409` kèm `{"impact": {"scenarios": 3, "runs": 12}}`; gọi lại với `?cascade=true` để xoá dây chuyền (một transaction).
- Có lần chạy `QUEUED`/`RUNNING` trong phạm vi thì luôn `409`, kể cả khi `cascade=true`.
- Loại node nào cũng như nhau: 14 loại mẫu (Máy dập, Kho kệ...) chỉ được nạp một lần khi bảng còn trống rồi là dữ liệu của bạn (sửa, xoá, đổi icon tự do; API khởi động lại không nạp đè hay nạp lại). Loại node bị khoá sửa và xoá khi có phiên bản đã Publish dùng; đang được phiên bản nháp dùng thì sửa được nhưng chưa xoá được. Vật tư: mã bất biến, đơn vị và xoá bị khoá khi đang dùng (kể cả tham chiếu bằng chuỗi mã trong tham số node).
- Scenario chỉ sửa được khi chưa có lần chạy; dùng `POST /api/scenarios/{id}/clone` để thử thông số khác.

## Live twin và bản đồ AGV (showcase)

Dữ liệu realtime đi vào workflow theo đường: **feed** (bản tin thô của thiết bị) → `POST /api/ingest` → **mapping** (`data_binding`) → tín hiệu chuẩn → trạng thái live + `signal`/`event_log` (`run_id NULL`) → WebSocket → web. Chưa dùng MQTT: bản tin `{source, ts, desc, payload}` độc lập đường truyền nên thay bằng MQTT chỉ đổi lớp nhận. Thiết kế: `docs/superpowers/specs/2026-09-30-live-twin-agv-map-design.md`.

- **Feed** (`services/feed`): bọc engine sim chạy từng bước theo giờ nhà máy (×1 … ×600). "Thực tế" dùng **tham số ẩn** (chu kỳ máy ×1,10, nhu cầu ×1,08) nên tự lệch khỏi mô hình mà dự báo dùng; đây là dữ liệu giả lập, không phải dữ liệu DENSO. Tên thiết bị khác key node (`STAMP_2` phát ở `plc/prs-02/status`). Điều khiển qua `/api/feed/*` (Go proxy): `POST /start {model, speed}`, `/pause`, `/resume`, `/speed`, `/stop`, `/reset`, `POST /incidents` (`machine_down`, `lane_block`, `stock_drain`).
- **Kết nối dữ liệu** (`/models/{key}/connect`): ghép tín hiệu chuẩn của node/edge (`state`, `level:RAW-01`, `moved`, `trip_s`, `fleet`…) với một trường của một nguồn (đường dẫn `cnt.ok`, `items[sku=RAW-01].qty`; nhân/cộng; bảng đổi `RUN→RUNNING`), có xem trước giá trị; **Gợi ý ghép tự động** so tên mô tả của nguồn với tên node (chỉ tốt khi thiết bị tự mô tả rõ, thiết bị thật thì ghép tay). Mapping thuộc về mô hình, không thuộc version.
- **Trực tiếp** (`/models/{key}/live`): workflow đổi màu/số theo dữ liệu thật (mất tín hiệu quá 15 giây thì xám, không giả vờ còn sống), hạt chảy theo lưu lượng thật; bảng demo bơm sự cố; **Dự báo từ trạng thái live** (30 phút đến 1 tuần; tồn kho thật thành `overrides`, máy hỏng thành `planned_stop` của scenario `NOWCAST`; hàng đang chờ trong máy giả định rỗng); đồ thị thực tế chồng dải P10–P90; **cảnh báo lệch dự báo** khi tồn kho thật ra ngoài dải 3 lần kiểm liên tiếp (cách nhau ≥ 5 phút giờ nhà máy), dự báo mới tự đóng cảnh báo cũ.
- **Bản đồ AGV** (`/models/{key}/map`): đồ thị điểm/làn có hướng và sức chứa; trạm gắn với node; xe chạy theo bản đồ, làn tô vàng (đầy chỗ) hoặc đỏ (có xe chờ); chặn làn thì xe đi đường vòng, hết đường thì chờ; sửa bản đồ (kéo điểm, thêm ngã tư/trạm, nối làn). **Hiệu chỉnh thời gian chuyến**: so `travel` của mô hình với thời gian chuyến đo được (≥ 8 chuyến), áp dụng thành hai scenario cùng seed (nền và hiệu chỉnh) để so sánh; không sửa version đã Publish. Giới hạn: bản đồ tự vẽ có thể tự kẹt cứng (bản đồ mẫu là mạng vòng một chiều nên không), xe kẹt quá 10 phút giờ nhà máy sẽ "chen" qua.
- Dự báo dài dùng lấy mẫu thưa (≤ 400 điểm), không ghi sự kiện/cảm biến thô và không chạy đề xuất; 1 tuần × 20 lần lặp mất khoảng 20 giây với `SIM_WORKERS=6` (đặt trong `docker-compose.yml`).

**Demo live (5 phút):** `docker compose up -d --build && python3 scripts/seed_demo.py` → mở `denso-plant` → tab Kết nối dữ liệu: **Bắt đầu phát dữ liệu giả lập** (×60), **Gợi ý ghép tự động** → Áp dụng → tab Trực tiếp: workflow sống theo dữ liệu → **Dự báo từ bây giờ** (1 ngày) → bơm sự cố "Máy hỏng" hoặc "Rút kho" và xem cảnh báo lệch → tab Bản đồ AGV: xe chạy, bấm một làn rồi **Chặn làn này**, xem xe dồn lại → cuộn xuống **Hiệu chỉnh thời gian chuyến** → Áp dụng và mở so sánh.

## Kịch bản demo (3 phút)

Làm sạch dữ liệu trước buổi demo: `docker compose down -v && docker compose up -d --build && python3 scripts/seed_demo.py`.
Nếu sim-service vừa khởi động lại, hãy chạy lại run trước khi tải CSV (CSV lấy từ bộ nhớ sim-service).

1. **Workflow** — mở mô hình `denso-mini`: kho NVL → 3 máy dập → lắp ráp → AOI → đóng gói → kho FG → xuất; tugger + người móc kéo. Muốn cho thấy cấu trúc phức tạp hơn thì mở `denso-plant`: 2 kho nguyên liệu nuôi 4 máy dập (có máy lấy từ cả hai kho), 2 buffer WIP dùng chung, 2 kho thành phẩm nối chéo 2 cửa xuất; thử "Xếp ngang" / "Xếp dọc". Scenario "Kho B chỉ còn 1 xe kéo" cho thấy xe kéo B là điểm nghẽn.
2. **Predict → Simulate** — scenario "Máy dập 3 hỏng (RUL ≈ 2 giờ)" (lỗi ở phút 120), 20 lần lặp → Chạy.
3. **Control Room** — phát lại: kho FG chuyển Đỏ; cảnh báo "FG có X% khả năng chuyển Đỏ lúc …"; bottleneck; tín hiệu rung của máy dập 3 tăng dần với nhãn lỗi.
4. **Recommend** — top-3 hành động kèm số phút Đỏ giảm; bấm "Áp dụng & chạy lại" → So sánh với gốc.
5. **Dữ liệu tổng hợp** — tải CSV có nhãn `label_fault`/`rul_s` để huấn luyện AI bảo trì dự đoán.
6. **Báo cáo** — In/Lưu PDF.

Tham số thiết bị hiện là **giả định** (đánh dấu `assumed`), sẽ hiệu chỉnh khi có dữ liệu DENSO.
