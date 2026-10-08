# Đổi thời hạn giữ lịch sử số liệu

**Khi nào dùng**: cần giữ số liệu lâu hơn hoặc ngắn hơn mặc định (reading 30 ngày, số gộp theo phút 2 năm), hoặc ổ đĩa của TimescaleDB sắp đầy.

## Kiểm tra

Thời hạn đang áp dụng và lần chạy gần nhất của từng policy:

```sql
SELECT j.hypertable_name, j.config ->> 'drop_after' AS giu, s.last_run_started_at, s.last_run_status
FROM timescaledb_information.jobs j
JOIN timescaledb_information.job_stats s USING (job_id)
WHERE j.proc_name = 'policy_retention';
```

Dòng `gauge_reading` là reading; dòng `_materialized_hypertable_N` là `gauge_1m`.

Dung lượng theo bảng:

```sql
SELECT hypertable_name, pg_size_pretty(hypertable_size(format('%I.%I', hypertable_schema, hypertable_name)::regclass))
FROM timescaledb_information.hypertables;
```

## Xử lý

Gỡ policy cũ rồi thêm policy mới. Rút ngắn thời hạn sẽ xóa dữ liệu cũ hơn mốc mới ở lần chạy kế tiếp và không lấy lại được.

```sql
SELECT remove_retention_policy('gauge_reading');
SELECT add_retention_policy('gauge_reading', INTERVAL '90 days');

SELECT remove_retention_policy('gauge_1m');
SELECT add_retention_policy('gauge_1m', INTERVAL '5 years');
```

Giữ reading ít nhất 7 ngày: màn lịch sử đọc các khoảng tới 7 ngày từ reading. Giữ reading lâu hơn 2 giờ là điều kiện để `gauge_1m` tính đúng (aggregate tính lại 2 giờ gần nhất).

## Xác nhận

Chạy lại câu kiểm tra đầu tiên: `giu` phải là giá trị mới. Trên UI, mở lịch sử của một máy với khoảng 30 ngày và xem điểm cũ nhất còn hiện.
