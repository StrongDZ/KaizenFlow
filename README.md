# KaizenFlow — Digital twin logistics (DENSO Factory Hacks 2026 · D2)

Mô phỏng workflow nhà máy → dự báo rủi ro Đỏ → phát hiện điểm nghẽn → đề xuất hành động đã kiểm chứng bằng mô phỏng.

## Chạy

```bash
docker compose up -d --build        # db (TimescaleDB :5433), sim (:8081), api (:8080)
python3 scripts/seed_demo.py        # dựng 2 mô hình demo: `denso-mini` (dây chuyền thẳng) và `denso-plant` (nhiều kho nối nhiều máy); idempotent
cd web && cp .env.example .env && npm install && npm run dev   # http://localhost:5173
```

Test: `cd services/sim && pytest` · `cd services/api && go test ./...` (cần `docker compose up -d db`) · `cd web && npx vitest run`.

### Giao diện web (dev)

- `cd web && npm install && npm run dev` (mặc định `http://localhost:5173`, API ở `VITE_API_URL`).
- Theme tối là mặc định; nút mặt trời/mặt trăng ở góc phải header đổi sang sáng và nhớ lựa chọn (`localStorage`, khoá `kf-theme`). Trang Báo cáo và bản in luôn dùng theme sáng.
- Editor: "Xếp ngang" / "Xếp dọc" tự sắp xếp sơ đồ (chỉ bản DRAFT), "Hoàn tác" trả lại một bước. Hướng sơ đồ suy ra từ vị trí node, không lưu riêng.
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
| `web` | React, React Flow | Editor, Scenario, Control Room, So sánh, Báo cáo |

Contract Go ↔ sim: `contracts/run.schema.json`. Thiết kế: `docs/superpowers/specs/`.

### Sửa và xoá (giao thức)

- `DELETE /api/models/{key}`, `/api/versions/{id}`, `/api/scenarios/{id}`: nếu còn dữ liệu phụ thuộc thì trả `409` kèm `{"impact": {"scenarios": 3, "runs": 12}}`; gọi lại với `?cascade=true` để xoá dây chuyền (một transaction).
- Có lần chạy `QUEUED`/`RUNNING` trong phạm vi thì luôn `409`, kể cả khi `cascade=true`.
- Node type có sẵn luôn chỉ đọc; node type tự tạo bị khoá sửa khi có version đã Publish dùng. Vật tư: mã bất biến, đơn vị và xoá bị khoá khi đang dùng (kể cả tham chiếu bằng chuỗi mã trong tham số node).
- Scenario chỉ sửa được khi chưa có lần chạy; dùng `POST /api/scenarios/{id}/clone` để thử thông số khác.

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
