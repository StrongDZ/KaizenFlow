-- +goose Up
-- Bổ sung failure mode mẫu cho các PROCESS built-in đã tồn tại. Chỉ nối mode còn thiếu;
-- không thay đổi signals, không ghi đè failure mode người dùng đã chỉnh.
WITH additions(code, modes) AS (VALUES
  ('IQC',
   '[{"code":"calibration_drift","label":"Trôi hiệu chuẩn thiết bị đo","description":"Sai lệch phép đo tăng dần; cần hiệu chuẩn lại trước khi tiếp tục kiểm tra.","onset":{"dist":"weibull","shape":2,"scale_s":1209600},"p_to_f":{"dist":"tri","min_s":1800,"mode_s":3600,"max_s":7200},"effects":[],"on_fail":{"state":"DOWN","mttr":{"dist":"lognorm","mean_s":1800,"cv":0.25}}}]'::jsonb),
  ('STAMP_PRESS',
   '[{"code":"die_jam","label":"Kẹt khuôn / kẹt phôi","description":"Kẹt vật liệu tại khuôn gây rung đột biến và buộc máy dập dừng xử lý.","onset":{"dist":"weibull","shape":2,"scale_s":259200},"p_to_f":{"dist":"tri","min_s":300,"mode_s":600,"max_s":1200},"effects":[{"signal":"vibration","kind":"spike","mag_sd":6}],"on_fail":{"state":"DOWN","mttr":{"dist":"lognorm","mean_s":1200,"cv":0.35}}},{"code":"hydraulic_pressure_loss","label":"Mất áp suất thủy lực","description":"Áp suất hệ thủy lực giảm dần tới mức máy không thể tiếp tục chu kỳ dập.","onset":{"dist":"weibull","shape":2,"scale_s":432000},"p_to_f":{"dist":"tri","min_s":900,"mode_s":1800,"max_s":3600},"effects":[],"on_fail":{"state":"DOWN","mttr":{"dist":"lognorm","mean_s":2700,"cv":0.3}}},{"code":"motor_overheat","label":"Động cơ quá nhiệt","description":"Nhiệt độ động cơ tăng nhanh và máy dừng để làm nguội, kiểm tra tải hoặc hệ thống tản nhiệt.","onset":{"dist":"weibull","shape":2,"scale_s":604800},"p_to_f":{"dist":"tri","min_s":1200,"mode_s":2400,"max_s":4800},"effects":[],"on_fail":{"state":"DOWN","mttr":{"dist":"lognorm","mean_s":2400,"cv":0.3}}}]'::jsonb),
  ('ASSEMBLY_CELL',
   '[{"code":"tool_wear","label":"Mòn dụng cụ lắp ráp","description":"Mô-men siết lệch dần do dụng cụ mòn; cần thay dụng cụ và xác nhận lại chất lượng.","onset":{"dist":"weibull","shape":2,"scale_s":604800},"p_to_f":{"dist":"tri","min_s":1800,"mode_s":3600,"max_s":7200},"effects":[],"on_fail":{"state":"DOWN","mttr":{"dist":"lognorm","mean_s":1800,"cv":0.25}}},{"code":"actuator_jam","label":"Kẹt cơ cấu chấp hành","description":"Cơ cấu cấp hoặc gá chi tiết bị kẹt và cell phải dừng để xử lý.","onset":{"dist":"weibull","shape":2,"scale_s":345600},"p_to_f":{"dist":"tri","min_s":300,"mode_s":900,"max_s":1800},"effects":[],"on_fail":{"state":"DOWN","mttr":{"dist":"lognorm","mean_s":1200,"cv":0.3}}},{"code":"torque_sensor_fault","label":"Lỗi cảm biến lực siết","description":"Tín hiệu mô-men không còn đáng tin cậy; cell dừng để kiểm tra cảm biến và truy xuất chất lượng.","onset":{"dist":"weibull","shape":2,"scale_s":518400},"p_to_f":{"dist":"tri","min_s":600,"mode_s":1200,"max_s":2400},"effects":[],"on_fail":{"state":"DOWN","mttr":{"dist":"lognorm","mean_s":900,"cv":0.25}}}]'::jsonb),
  ('AOI',
   '[{"code":"camera_degradation","label":"Suy giảm camera AOI","description":"Chất lượng ảnh giảm dần do bẩn hoặc lệch quang học, cần vệ sinh và căn chỉnh camera.","onset":{"dist":"weibull","shape":2,"scale_s":604800},"p_to_f":{"dist":"tri","min_s":1800,"mode_s":3600,"max_s":7200},"effects":[],"on_fail":{"state":"DOWN","mttr":{"dist":"lognorm","mean_s":1800,"cv":0.25}}},{"code":"illumination_failure","label":"Mất đèn chiếu sáng AOI","description":"Nguồn sáng kiểm tra mất hoặc suy hỏng khiến AOI không thể đánh giá sản phẩm.","onset":{"dist":"weibull","shape":2,"scale_s":432000},"p_to_f":{"dist":"tri","min_s":300,"mode_s":600,"max_s":1200},"effects":[],"on_fail":{"state":"DOWN","mttr":{"dist":"lognorm","mean_s":900,"cv":0.25}}}]'::jsonb),
  ('PACKING',
   '[{"code":"conveyor_jam","label":"Kẹt băng tải đóng gói","description":"Bao bì hoặc sản phẩm kẹt trên băng tải và trạm phải dừng gỡ kẹt.","onset":{"dist":"weibull","shape":2,"scale_s":345600},"p_to_f":{"dist":"tri","min_s":300,"mode_s":600,"max_s":1200},"effects":[],"on_fail":{"state":"DOWN","mttr":{"dist":"lognorm","mean_s":1200,"cv":0.3}}},{"code":"sealer_overheat","label":"Bộ ép nhiệt quá nóng","description":"Nhiệt độ bộ hàn miệng bao tăng cao; trạm dừng để tránh lỗi bao bì và nguy cơ an toàn.","onset":{"dist":"weibull","shape":2,"scale_s":518400},"p_to_f":{"dist":"tri","min_s":900,"mode_s":1800,"max_s":3600},"effects":[],"on_fail":{"state":"DOWN","mttr":{"dist":"lognorm","mean_s":1800,"cv":0.25}}}]'::jsonb)
)
UPDATE node_type AS n
SET failure_modes = n.failure_modes || COALESCE((
  SELECT jsonb_agg(candidate.value || '{"injection_only":true}'::jsonb)
  FROM jsonb_array_elements(additions.modes) AS candidate(value)
  WHERE NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(n.failure_modes) AS current(value)
    WHERE current.value->>'code' = candidate.value->>'code'
  )
), '[]'::jsonb)
FROM additions
WHERE n.code = additions.code AND n.is_builtin;

-- Gắn metadata còn thiếu cho bearing_wear cũ, giữ nguyên giá trị người dùng đã đặt.
UPDATE node_type
SET failure_modes = (
  SELECT jsonb_agg(CASE WHEN mode->>'code' = 'bearing_wear' THEN
    mode
    || CASE WHEN mode ? 'label' THEN '{}'::jsonb ELSE '{"label":"Mòn vòng bi"}'::jsonb END
    || CASE WHEN mode ? 'description' THEN '{}'::jsonb ELSE '{"description":"Rung động tăng dần trước khi máy dừng để thay hoặc sửa vòng bi."}'::jsonb END
    ELSE mode END)
  FROM jsonb_array_elements(failure_modes) AS mode
)
WHERE code = 'STAMP_PRESS' AND is_builtin
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(failure_modes) AS mode WHERE mode->>'code' = 'bearing_wear');

-- +goose Down
-- Không tự xoá khi rollback vì người dùng có thể đã chỉnh các mode cùng mã sau migration;
-- database không còn cách phân biệt dữ liệu mẫu với dữ liệu đã được xác nhận.
SELECT 1;
