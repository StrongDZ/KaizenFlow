# Rollback model

## Khi nào

- Sau rollout, máy chạy model mới có quality tụt, nhiều `OUT_OF_RANGE`/`RATE_LIMIT`, hoặc reading lệch rõ so với máy cùng loại còn chạy model cũ.
- Rollout theo bậc 1 máy (canary) → một line → toàn bộ; rollback càng sớm ở bậc canary càng tốt.

## Kiểm tra

1. Model nào đang chạy ở đâu:
   ```sql
   SELECT model_version, count(DISTINCT machine_id) AS machines, round(avg(quality)::numeric, 2) AS q,
          count(*) FILTER (WHERE 4 = ANY (flags) OR 5 = ANY (flags)) AS range_or_rate
   FROM gauge_reading WHERE ts > now() - interval '2 hours' GROUP BY 1;
   ```
2. So một máy canary với một máy cùng loại chưa đổi: cùng giờ, cùng loại đồng hồ.
3. Báo cáo duyệt của model (accuracy-eval trên tập test cố định + nhãn mới, sinh lúc đăng ký MLflow) để biết model này có điểm yếu đã biết không.

## Xử lý

1. Lấy config hiện tại của từng máy bị ảnh hưởng: `GET /v1/stations/{machine_id}`.
2. Đổi `model_versions` về bản trước (ví dụ `{"dial_pose": "3", "digit_cls": "5"}`) và `PUT /v1/stations/{machine_id}` với toàn bộ config. config-api tăng version và publish retained; edge nạp lại.
3. Edge giữ ONNX/engine của bản trước nên rollback không phải tải lại hay build engine lại.
4. Ghi lại: model, máy, thời điểm, triệu chứng; chặn model đó trong MLflow (stage `Archived`) để không bị rollout lại.

Trạng thái hiện tại: việc edge tự tải ONNX theo `model_versions` thuộc Task B của GD7 và chưa làm. Trước khi có, rollback là đổi file trong thư mục model của edge (`EDGE_MODEL_DIR`) về bản trước rồi `docker restart` pipeline và edge-agent.

## Xác nhận đã hết

- `edge_agent_config_version{machine_id}` bằng version mới của config; `model_version` trong reading mới là bản cũ.
- Quality và tỉ lệ flag trở về mức của các máy không đổi model.
