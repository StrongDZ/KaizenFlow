# Lag Kafka tăng

## Triệu chứng

- Alert `IngestLagHigh` (lag theo ingest, > 5.000 bản tin trong 2 phút) hoặc `IngestLagHighBrokerView` (cùng ngưỡng, tính từ metric của Redpanda; vẫn kêu khi ingest chết hẳn).
- Dashboard: số mới vào chậm, `ingest_end_to_end_seconds` p99 tăng.
- Dữ liệu **không mất** khi lag tăng: Kafka giữ 7 ngày và ingest chỉ commit offset sau khi đã ghi DB.

## Kiểm tra

1. Lag thật theo broker:
   ```bash
   docker exec gauge-twin-redpanda-1 rpk group describe ingest -X brokers=redpanda:9092
   # profile cluster: gauge-twin-redpanda-0-1 và brokers=redpanda-0:9092
   ```
   Luôn thêm `-X brokers=...`: mặc định rpk đi theo địa chỉ quảng bá ra host và báo lỗi khi coordinator nằm ở broker khác.
2. Ingest có chạy không: `docker ps | grep ingest`, `/healthz` báo `degraded` nghĩa là đang retry lỗi hạ tầng.
3. Nguyên nhân thường gặp, theo thứ tự:
   - **DB chậm** (kịch bản 6 của GD6): `ingest_batch_latency_seconds` tăng, `ingest_infra_errors_total` có thể vẫn 0. Kiểm tra `docker stats gauge-twin-timescaledb-1`, IO đĩa, truy vấn nặng (`SELECT * FROM pg_stat_activity WHERE state <> 'idle'`), job nén/aggregate đang chạy.
   - **Redis hoặc config-api lỗi**: `ingest_infra_errors_total` tăng, log ingest `retrying`.
   - **Tải tăng** (thêm máy): lag tăng đều, batch latency bình thường → thiếu replica.
   - **Rebalance liên tục**: `rpk group describe` đổi `MEMBERS` liên tục, log ingest nhiều `rebalance`.
4. DLQ: `ingest_messages_total{result="dlq"}` tăng nghĩa là có bản tin dữ liệu lỗi bị tách ra, không phải lag.

## Xử lý

- DB chậm: giải phóng nguyên nhân (dừng truy vấn nặng, chờ job nén xong, thêm IO). Ingest tự đuổi kịp, không cần restart: trong GD6, sau khi bỏ nghẽn DB 2 phút, 23.000 bản tin được xử lý xong trong 60 s.
- Thiếu replica: thêm replica ingest (tối đa bằng số partition `gauge.telemetry` = 24).
- Ingest chết/treo: `docker restart gauge-twin-server-ingest-1-1`. An toàn: batch chưa commit sẽ đọc lại, ghi DB là idempotent.
- **Không** reset offset của group `ingest` để "xóa lag": bản tin bị bỏ qua sẽ mất khỏi DB.

## Xác nhận đã hết

- `TOTAL-LAG` về 0 hoặc dao động dưới vài trăm.
- `ingest_end_to_end_seconds` p99 về dưới 2 s.
- `IngestLagHigh` và `IngestLagHighBrokerView` hết kêu.
