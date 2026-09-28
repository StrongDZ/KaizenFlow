# KaizenFlow — Digital twin logistics (DENSO Factory Hacks 2026 · D2)

Mô phỏng workflow nhà máy → dự báo rủi ro Đỏ → phát hiện điểm nghẽn → đề xuất hành động đã kiểm chứng bằng mô phỏng.

## Chạy

```bash
docker compose up -d --build        # db (TimescaleDB :5433), sim (:8081), api (:8080)
cd web && cp .env.example .env && npm install && npm run dev   # http://localhost:5173
```

Test: `cd services/sim && pytest` · `cd services/api && go test ./...` (cần `docker compose up -d db`) · `cd web && npx vitest run`.

## Kiến trúc

| Thành phần | Công nghệ | Vai trò |
|---|---|---|
| `services/sim` | Python, SimPy, FastAPI | Mô phỏng Monte Carlo, tiêm lỗi P-F + dữ liệu tổng hợp có nhãn, Detect, Recommend |
| `services/api` | Go, Postgres + TimescaleDB | Lưu model/scenario/run, validate, resolve tham số, điều phối, WebSocket |
| `web` | React, React Flow | Editor, Scenario, Control Room, So sánh, Báo cáo |

Contract Go ↔ sim: `contracts/run.schema.json`. Thiết kế: `docs/superpowers/specs/`.

## Kịch bản demo (3 phút)

1. **Workflow** — mở mô hình `denso-mini`: kho NVL → 3 máy dập → lắp ráp → AOI → đóng gói → kho FG → xuất; tugger + người móc kéo.
2. **Predict → Simulate** — scenario "Máy dập 3 hỏng ở phút 60" (RUL từ model PdM), 20 lần lặp → Chạy.
3. **Control Room** — phát lại: kho FG chuyển Đỏ; cảnh báo "FG có X% khả năng chuyển Đỏ lúc …"; bottleneck; tín hiệu rung của máy dập 3 tăng dần với nhãn lỗi.
4. **Recommend** — top-3 hành động kèm số phút Đỏ giảm; bấm "Áp dụng & chạy lại" → So sánh với gốc.
5. **Dữ liệu tổng hợp** — tải CSV có nhãn `label_fault`/`rul_s` để huấn luyện AI bảo trì dự đoán.
6. **Báo cáo** — In/Lưu PDF.

Tham số thiết bị hiện là **giả định** (đánh dấu `assumed`), sẽ hiệu chỉnh khi có dữ liệu DENSO.
