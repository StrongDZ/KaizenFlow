# KaizenFlow - Warehouse Contract · 7-Day Sim · Forecast Benchmark

## Overview
- **Summary**: Nâng cấp KaizenFlow ở 4 mảng liên thông theo luồng nghiệp vụ FMCG: (1) Thiết lập kho và máy móc theo data contract chuẩn hóa Input/Output + Capacity Matrix theo SKU, (2) Tương tác click trực tiếp vào đối tượng kho trên canvas để xem chi tiết sức chứa và tồn kho realtime, (3) Runner mô phỏng liên tục 7 ngày (step giờ/ca) ghi time-series log tồn kho từng SKU, (4) Benchmark inference: đưa dữ liệu 7 ngày qua thuật toán dự báo tùy chỉnh, đo latency và throughput/Continuity.
- **Purpose**: Để mô phỏng “vận hành kho thực tế”, cung cấp dữ liệu thời gian thực đáng tin cậy phục vụ demo Hội đồng, đồng thời đưa ra chứng cứ hiệu năng của thuật toán dự báo custom của bạn trên dataset sinh ra từ mô phỏng.
- **Target Users**: Người dựng mô hình (người tạo kho), người vận hành (theo dõi tồn kho realtime), người đánh giá hiệu quả dự báo (Hội đồng).

## Goals
- G-1: Khi tạo mô hình/kho mới, hệ thống luôn sinh ra data contract rõ ràng cho Input/Output của máy móc và Capacity Matrix theo SKU cho kho.
- G-2: Click trực tiếp vào đối tượng kho trên canvas Editor hoặc Live → hiện Popup chi tiết Capacity/Stock theo SKU.
- G-3: Runner mô phỏng 7 ngày chạy ổn định, xuất time-series log tồn kho theo từng kho/SKU (định dạng thống nhất, dễ feed vào forecast).
- G-4: Benchmark inference: dùng dữ liệu 7 ngày chạy qua thuật toán dự báo, trả ra số liệu latency, throughput, continuity, đúng chuẩn enterprise demo.

## Non-Goals
- NG-1: Không thay đổi core SimPy engine (phương trình vật lý xe/transport) ngoài những thay đổi contract cần thiết.
- NG-2: Không build lại toàn bộ Forecast UI; tận dụng ForecastDock & OperationsDashboardPage đã có để hiển thị benchmark result.
- NG-3: Không refactor toàn bộ catalog schema; chỉ bổ sung field chuẩn và validators.
- NG-4: Không implement 3D kho hoặc điều phối AGV nâng cao.
- NG-5: Không triển khai multi-user concurrent hay auth.

## Background & Context
- Hệ thống KaizenFlow hiện có 4 khối: `web` (React19/Vite7/Tailwind4/ReactFlow/Recharts), `services/api` (Go1.26/Chi/TimescaleDB), `services/sim` (Python3.12/SimPy/FastAPI), `services/feed` (Python twin realtime).
- Hiện tại:
  - Archetype `STORAGE` có `capacity` (scalar) + `stock[].max` per-material, nhưng chưa có field chuẩn `capacity_matrix` như yêu cầu: [schemas.go](file:///Users/nguyenthithuy/Desktop/MKHQ/KaizenFlow/services/api/internal/catalog/schemas.go#L20-L29)
  - `Storage` node trong sim đã thực sự per-SKU max (dùng `stock[i].max` rồi box Container per material): [storage.py](file:///Users/nguyenthithuy/Desktop/MKHQ/KaizenFlow/services/sim/sim_service/nodes/storage.py#L15-L37)
  - `PROCESS` đã có recipes `inputs[]/outputs[]` trong schema: [schemas.go](file:///Users/nguyenthithuy/Desktop/MKHQ/KaizenFlow/services/api/internal/catalog/schemas.go#L30-L44) → nhưng chưa có contract tổng hợp tự động (summary input/output per process theo material) khi publish.
  - Editor canvas có `selNode` (selected 1 node) rồi mở Inspector bên phải, nhưng **chưa có Popup/Tooltip inline khi click**: [EditorPage.tsx](file:///Users/nguyenthithuy/Desktop/MKHQ/KaizenFlow/web/src/pages/EditorPage.tsx#L80-L86)
  - `Recorder` đang ghi `series[(subject, metric)]` sample từng level:{m} rồi: [recorder.py](file:///Users/nguyenthithuy/Desktop/MKHQ/KaizenFlow/services/sim/sim_service/recorder.py#L13-L37), [storage.py](file:///Users/nguyenthithuy/Desktop/MKHQ/KaizenFlow/services/sim/sim_service/nodes/storage.py#L77-L87)
  - Forecast provider layer mới được cắm (hybrid_runtime và project_m): [provider.go](file:///Users/nguyenthithuy/Desktop/MKHQ/KaizenFlow/services/api/internal/fmcg/provider.go), [project_m_provider.go](file:///Users/nguyenthithuy/Desktop/MKHQ/KaizenFlow/services/api/internal/fmcg/project_m_provider.go)
- Hạn chế hiện tại (để spec này giải quyết):
  - Không có field chuẩn `capacity_matrix` để downstream (UI, benchmark) đọc một cách nhất quán.
  - Không có tổng hợp `io_contract` (inputs/outputs tổng hợp) per-node khi publish version → khó “làm kho kỹ” theo recipe của máy.
  - Không có modal inline khi click kho trên canvas phải mở Inspector thì khó demo trực quan.
  - Không có runner chuẩn 7-day “bấm 1 phát là ra time-series tồn kho” cho benchmark forecast; mọi người phải tự set horizon_s.
  - Không có benchmark workflow auto: run sim → collect series → feed forecast → đo latency/throughput.

## Functional Requirements
- **FR-1 (Setup & Contract)**: Khi tạo hoặc update graph version, hệ thống tự đảm bảo:
  1. Mỗi node STORAGE có `capacity_matrix: {SKU_CODE: max_cap_number}`. Nếu user nhập `stock[i].max` cũ mà thiếu `capacity_matrix`, backend tự synthesize (fill) từ `stock[].max` + `capacity` scalar, validate lại.
  2. Mỗi node PROCESS publish version phải có summary `io_contract` chứa danh sách inputs/outputs tổng hợp theo material (duyệt hết recipes).
  3. Dữ liệu contract phải được đính kèm trong `version.meta` (fields: `warehouse_capacities`, `process_io_contracts`) và trả ra qua API GET /versions/{id}.
- **FR-2 (UI click popup)**: Trên mọi canvas hiển thị nodes (Editor, Live) có node STORAGE:
  1. Khi click vào node kho, hiện popup/tooltip gần node (inline), không bắt buộc mở Inspector full panel.
  2. Nội dung popup: Tên kho, danh sách SKU, “Sức chứa tối đa (Capacity)”, “Tồn kho hiện tại (Realtime)”.
  3. Nếu ở trang Live, tồn kho phải lấy từ `live_snapshot.levels` mới nhất. Nếu Editor thì lấy `initial`.
  4. Click bên ngoài hoặc nút đóng thì đóng popup.
- **FR-3 (7-Day Sim Runner)**: Cung cấp cách chạy mô phỏng 7 ngày (604.800s) đơn giản (API endpoint hoặc function call) với tham số:
  1. `step_s` (mặc định 3600, có thể set ca-shift là 28800)
  2. `warmup_s` (mặc định 0 cho gọn demo)
  3. `replications` (mặc định 1 cho benchmark deterministic)
  4. Sau khi chạy xong, return `warehouse_series_log`: một cấu trúc chuẩn với mảng `[{ts_s, sku, node_key, level, capacity, coverage_h, color}]`, aggregate đủ cho benchmark.
  5. Log này cũng lưu vào `run.meta` khi người dùng create scenario run với flag `benchmark_ready=true` (tương thích `ComparePage`).
- **FR-4 (Forecast Benchmark)**: Thêm workflow benchmark inference:
  1. Input: một `warehouse_series_log` từ FR-3 (hoặc run_meta).
  2. Workflow: extract dataframe phù hợp → gọi forecast provider (dùng `project_m` ưu tiên nếu có, fallback `hybrid_runtime`).
  3. Metric đo và lưu: (a) `latency_ms` tổng inference call, (b) `records_per_s` (throughput), (c) `non_blocking_p95_ms` (measure khi gọi loop inference liên tục 10 lần trên 10 kho slice).
  4. Trả ra `benchmark_report` và hiển thị trên OperationsDashboardPage (hoặc new Dock) ở 2 KPI lớn + giải thích (Explainer).
  5. Có option “Chạy benchmark nhanh” trên UI: bấm 1 nút, auto FR-3 7-day → FR-4 measure luôn.

## Non-Functional Requirements
- **NFR-1 (Deterministic)**: Benchmark trên cùng 1 input + seed 42 → trả kết quả latency/throughput ổn định giữa các lần (không drift > 20%).
- **NFR-2 (Performance - Sim)**: Runner 7-day 1 replication của model ~50 nodes phải hoàn thành trong < 45 giây native Python trên M1/2.
- **NFR-3 (Performance - Inference)**: Thuật toán inference trên 168 giờ × 20 SKU phải hoàn thành < 3 giây (enterprise “gần real-time demo-ready”).
- **NFR-4 (Contract Compatibility)**: Backward compatible với tất cả graph cũ (nếu thiếu field, tự synthesize chứ không lỗi validate).
- **NFR-5 (Code Style)**: Tuân thủ code style hiện tại (Go + React/Vitest + Python/pytest). Viết tests cho contract fill/synthesize, runner 7-day, benchmark measure.
- **NFR-6 (Data Consistency)**: Data log 7-day của node ở sim và data log hiển thị trên Live phải aligned cùng node_key, material code.
- **NFR-7 (Enterprise UI/UX)**: Popup kho và benchmark panel phải có KPI lớn, explainer, rating nhanh TỐT/CẦN CẢI THIỆN/RỦI RO CAO theo quy ước project_memory.

## Constraints
- **Technical**:
  - Frontend: React19, ReactFlow 12, Tailwind4, Radix Dialog/Popover, Recharts 3.
  - Backend: Go1.26 Chi + TimescaleDB PG16; sim Python3.12/SimPy.
  - Không được remove/make breaking changes cho schema cũ (phải synthesize backward).
  - Benchmark forecast phải tận dụng existing FMCG provider layer (chỉ thêm benchmark orchestrator), không viết engine mới duplicate.
- **Business**:
  - Demo-ready cho Hội đồng chấm: bấm 1 nút là có full pipeline (contract đảm bảo → 7-day sim → forecast → benchmark).
  - Output benchmark phải nói rõ thuật toán nào đang chạy (provider name).
- **Dependencies**:
  - Dùng `scripts/project_m_bridge.py` + `project_m_provider.go` đã có cho inference benchmark.
  - Dùng `Recorder` hiện tại để collect time series, không viết duplicated logger (đảm bảo SSoT).

## Assumptions
- A-1: “Kho” trong yêu cầu tương ứng với archetype `STORAGE` (warehouse/rack storage) của KaizenFlow.
- A-2: “Máy móc input bao nhiêu loại / output bao nhiêu loại” tương ứng với recipes inputs/outputs của archetype `PROCESS`.
- A-3: Step 7-day mặc định là theo giờ (3600s), đủ nhu cầu “dễ hiểu dễ xài” của demo.
- A-4: Khi benchmark non-blocking, đo gọi inference 10 lần lần lượt để không làm nghẽn runtime (sim không cần chạy song song) là đủ chứng minh continuity của inference.
- A-5: Nếu môi trường user không có project M, fallback hybrid_runtime vẫn phải benchmark được (để mọi nơi đều demo được).
- A-6: Contract tự synthesize dựa trên stock[i].max hiện có được chấp nhận là “đủ chuẩn” cho các version graph cũ.

## Acceptance Criteria

### AC-1: Capacity Matrix được synthesize và lưu vào version meta
- **Type**: `rule`
- **Given**: Một graph version có STORAGE node với `params.stock[].max` theo cũ và **không** có `capacity_matrix` field.
- **When**: PUT graph version và gọi GET /versions/{id}.
- **Then**: Response version.meta phải có `warehouse_capacities[node_key] = {sku: max_cap_number}`.
- **Pass Condition**: `warehouse_capacities` có ít nhất 1 entry per STORAGE node và max_cap khớp với `stock[i].max` (hoặc capacity scalar nếu không có max).
- **Evidence**: Test backend ở catalog/writes; curl/GET version.meta trả đúng.

### AC-2: PROCESS có io_contract tổng hợp Input/Output
- **Type**: `rule`
- **Given**: Một graph PROCESS có 2 recipes với inputs/outputs khác nhau; ví dụ recipe1 [IN(A,2),OUT(B,1)], recipe2 [IN(A,3), OUT(C,2)].
- **When**: Publish version → GET /versions/{id}.
- **Then**: version.meta `process_io_contracts[node_key]` trả `inputs: {A: sum=5}`, `outputs: {B:1, C:2}`.
- **Pass Condition**: Tổng hợp đúng.
- **Evidence**: Test catalog schema; HTTP response.

### AC-3: Popup kho khi click STORAGE node inline
- **Type**: `rule`
- **Given**: Đã mở EditorPage có node STORAGE 2 SKU A/B với max A=1000, B=500, initial A=200, B=300.
- **When**: Click trực tiếp vào node đó trên canvas.
- **Then**: Popover hiển thị gần node, 2 dòng SKU A và B: Capacity đúng, Tồn kho = initial.
- **Pass Condition**: DOM có div trong popover chứa text “Sức chứa tối đa” và số đúng.
- **Evidence**: Vitest + testing-library click node; kiểm tra nội dung popover.

### AC-4: Popup Live dùng realtime levels snapshot
- **Type**: `rule`
- **Given**: LiveSubjectsPage có 1 node kho STORAGE nhận live ingest cho `level:SKU_A = 878`.
- **When**: Click node kho.
- **Then**: Popover hiển thị tồn kho cho SKU_A = 878 (không phải initial).
- **Pass Condition**: So sánh bằng live snapshot.
- **Evidence**: Vitest mock live snapshot; ReactFlow click.

### AC-5: Runner 7-day sim trả warehouse_series_log chuẩn
- **Type**: `rule`
- **Given**: Model bimbo-fmcg có 2 kho 3 SKU; seed=42.
- **When**: Gọi runner `horizon_s = 604800, step_s=3600, replications=1`.
- **Then**: Return `warehouse_series_log` có entries = 2 kho × 3 sku × 168 giờ = 1008 records (mỗi record có ts_s, sku, node_key, level, capacity).
- **Pass Condition**: Số record đúng; ts_s cuối = 604800-step hoặc 604800 tùy sample cuối.
- **Evidence**: pytest runner; count records.

### AC-6: warehouse_series_log lưu vào run.meta để ComparePage đọc được
- **Type**: `rule`
- **Given**: benchmark_ready=true.
- **When**: Tạo scenario run xong.
- **Then**: `sc.run.meta.benchmark.warehouse_series_log_summary` hoặc pointer có thể đọc từ run detail.
- **Pass Condition**: Run detail trả có benchmark_ready flag và data summary.
- **Evidence**: HTTP test.

### AC-7: Benchmark inference báo latency, throughput, non_blocking_p95
- **Type**: `rule`
- **Given**: Input log 168 giờ × 5 SKU.
- **When**: Chạy benchmark orchestrator.
- **Then**: `benchmark_report` trả 3 trường bắt buộc: `latency_ms` (số > 0), `records_per_s` (số > 0), `non_blocking_p95_ms` (số > 0).
- **Pass Condition**: 3 trường có giá trị hợp lý và cùng provider name.
- **Evidence**: pytest benchmark module mock provider.

### AC-8: OperationsDashboardPage hiển thị benchmark report với explainer + rating
- **Type**: `rubric`
- **Dimension**: Enterprise demo-ready của benchmark panel
- **Scale**: 1-5
- **Anchors**: 1 = chỉ có số thô, không giải thích; 3 = đủ 3 KPI, chưa có explainer/rating; 5 = có 3 KPI lớn, Explainer nói rõ thuật toán provider nào, logic tính latency, throughput, continuity, Đánh giá nhanh TỐT/CẦN CẢI THIỆN/RỦI RO CAO.
- **Pass Threshold**: >= 4
- **Evidence**: Visual snapshot + DOM test cho có 3 KPI + Explainer + Rating badge.

### AC-9: Nút bấm “Chạy benchmark nhanh” end-to-end
- **Type**: `rule`
- **Given**: Model publish, API/sim on.
- **When**: Bấm “Chạy benchmark nhanh”.
- **Then**: (a) Chạy 7-day runner, (b) Gọi benchmark orchestrator, (c) Hiện benchmark report 3 KPI.
- **Pass Condition**: UI hiển thị đủ 3 KPI.
- **Evidence**: E2E flow (với mock sim/bench cho test).

### AC-10: Backward compat không break graph cũ
- **Type**: `rule`
- **Given**: Graph version cũ chỉ có scalar capacity, stock không có max.
- **When**: POST /api/models + PUT graph cũ.
- **Then**: Validate success. version.meta trả synthesized capacities đúng.
- **Pass Condition**: Không 4xx/5xx.
- **Evidence**: Test catalog.

### AC-11: Throughput & Continuity không bị nghẽn khi chạy 10 batch
- **Type**: `rubric`
- **Dimension**: Continuity của forecast batch inference
- **Scale**: 1-5
- **Anchors**: 1 = > 50% lần gọi bị timeout/hang; 3 = chạy được 10 lần nhưng lần 9-10 tăng gấp đôi thời gian; 5 = chạy 10 lần inference liên tục, p95 non_blocking không lệch > 20% so với trung bình.
- **Pass Threshold**: >= 4
- **Evidence**: pytest benchmark measure (mock project M hoặc hybrid).

## Open Questions
- [x] OQ-1: “Máy móc” = PROCESS archetype, “Kho” = STORAGE archetype? (Đã trả: YES per A-1/A-2)
- [x] OQ-2: Step 7 ngày mặc định là giờ (3600s) hay ca (28.800s)? (Trả: Giờ mặc định, có option step_s parameter tùy chỉnh)
- [x] OQ-3: Benchmark report có hiện trên OperationsDashboardPage (đã demo-ready) hay tạo page mới? (Trả: Trên OperationsDashboard hoặc new Dock, tích hợp với dashboard đang có)
- [ ] OQ-4: Có cần export `warehouse_series_log` ra CSV để bạn mang đi xử lý bằng notebook ngoài không? (Mặc định KHÔNG; thêm option nếu user cần sau)
