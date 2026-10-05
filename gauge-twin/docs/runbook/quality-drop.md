# Quality reading tụt

## Triệu chứng

- `reading_quality` (histogram theo loại đồng hồ) dịch về thấp; nhiều reading `value` rỗng.
- `reading_flag_total` tăng ở `FLAG_BLUR`, `FLAG_GLARE`, `FLAG_OCCLUDED`, `FLAG_ROI_DRIFT`, `FLAG_STALE`.
- Ingest hạ quality xuống tối đa 0,3 khi vi phạm ràng buộc (`FLAG_OUT_OF_RANGE`, `FLAG_RATE_LIMIT`, `FLAG_NON_MONOTONIC`, `FLAG_CLOCK_SKEW`).

## Kiểm tra

1. Khoanh vùng: một đồng hồ, một máy, một line hay toàn bộ?
   ```sql
   SELECT machine_id, gauge_id, round(avg(quality)::numeric, 2) AS q,
          count(*) FILTER (WHERE value IS NULL) AS unread,
          array_agg(DISTINCT f) FILTER (WHERE f IS NOT NULL) AS flags
   FROM gauge_reading LEFT JOIN LATERAL unnest(flags) f ON true
   WHERE ts > now() - interval '1 hour'
   GROUP BY 1, 2 ORDER BY q LIMIT 30;
   ```
2. Đọc flag:
   - `BLUR`: camera mất nét, rung, bẩn ống kính.
   - `GLARE`: ánh sáng thay đổi (đèn, nắng theo giờ).
   - `ROI_DRIFT`: camera bị xê dịch so với ảnh tham chiếu lúc commissioning.
   - `STALE`: pipeline không ra frame cho máy đó (RTSP đứt).
   - `OUT_OF_RANGE`, `RATE_LIMIT`, `NON_MONOTONIC`: config sai (dải đo, tốc độ) hoặc model đọc sai.
3. Toàn bộ máy cùng tụt ngay sau một lần rollout → nghi model mới: so `model_version` của các reading trước và sau, xem [model-rollback.md](model-rollback.md).
4. Mới có `FLAG_NO_CONFIG` → máy chưa có config trong config-api (ingest không kiểm tra được dải đo).
5. Xem ảnh: crop của reading quality < 0,5 được gửi lên MinIO (active learning, GD7); khi chưa có thì lấy frame từ camera bằng tool commissioning.

## Xử lý

- Camera/ánh sáng: vệ sinh ống kính, chỉnh lại góc, che sáng. `ROI_DRIFT` kéo dài → commissioning lại ROI và lưu config mới (config-api tăng version, edge nạp lại không cần restart).
- Config sai: sửa qua config-api `PUT /v1/stations/{machine_id}`.
- Model: rollback theo [model-rollback.md](model-rollback.md); đưa các ảnh sai vào vòng active learning.
- Lưu ý: ngưỡng quality hiện chưa hiệu chỉnh trên ảnh thật (GD5). Quality thấp đồng loạt ngay từ đầu triển khai chưa chắc là sự cố.

## Xác nhận đã hết

- Trung bình quality của nhóm bị ảnh hưởng trở về mức trước sự cố (so cùng giờ hôm trước).
- Flag tương ứng ngừng tăng.
