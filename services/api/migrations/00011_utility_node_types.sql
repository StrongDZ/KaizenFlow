-- +goose Up
-- Hai loại node cho thiết bị phụ trợ của nhà máy. Chúng vẫn quy về đúng 5 archetype có sẵn:
-- thứ CẤP một tiện ích (hơi, khí nén, điện, nước lạnh) là SOURCE; thứ BIẾN ĐỔI là PROCESS.
--
-- Trước đây 14 loại mẫu chỉ phủ dây chuyền lắp ráp, nên 21 máy đang gắn đồng hồ ở khu Đồng hồ
-- (lò hơi, máy nén khí, bơm, máy phát điện, CNC, hàn, cắt plasma…) không có loại nào để khai và
-- vì vậy không vào được danh mục Thiết bị — hai danh mục thành hai thứ rời nhau.
--
-- Loại mẫu chỉ được nạp khi bảng còn trống (để không nạp đè thứ người dùng đã sửa), nên thêm loại
-- mới cho DB đang chạy phải đi bằng migration. ON CONFLICT: ai đã tự tạo mã này rồi thì giữ nguyên.
INSERT INTO node_type (code, name, archetype, param_schema, default_params, signals, failure_modes, ui, is_builtin)
SELECT 'UTILITY_SUPPLY', 'Nguồn tiện ích', 'SOURCE', t.param_schema,
  '{"assumed":true,"arrivals":{"interarrival":{"dist":"norm","mean":60,"sd":5}}}'::jsonb,
  '[{"name":"pressure","unit":"bar","base":{"dist":"normal","mean":6.2,"sd":0.25},"hz":0.2},
    {"name":"temperature","unit":"degC","base":{"dist":"normal","mean":64,"sd":3},"hz":0.2}]'::jsonb,
  '[{"code":"pressure_loss","label":"Mất áp","description":"Áp suất tụt dần: rò rỉ, van hỏng hoặc bơm yếu; dây chuyền dùng tiện ích này sẽ chậm rồi dừng.","injection_only":true,"onset":{"dist":"weibull","shape":2,"scale_s":432000},"p_to_f":{"dist":"tri","min_s":900,"mode_s":1800,"max_s":3600},"effects":[{"signal":"pressure","kind":"ramp","mag_sd":-4}],"on_fail":{"state":"DOWN","mttr":{"dist":"lognorm","mean_s":2700,"cv":0.3}}},
    {"code":"motor_overheat","label":"Động cơ quá nhiệt","description":"Nhiệt độ tăng nhanh, thiết bị dừng để làm nguội và kiểm tra tải.","injection_only":true,"onset":{"dist":"weibull","shape":2,"scale_s":604800},"p_to_f":{"dist":"tri","min_s":1200,"mode_s":2400,"max_s":4800},"effects":[{"signal":"temperature","kind":"exp","mag_sd":3}],"on_fail":{"state":"DOWN","mttr":{"dist":"lognorm","mean_s":2400,"cv":0.3}}}]'::jsonb,
  '{"icon":"zap","color":"#0891b2"}'::jsonb, true
FROM node_type t WHERE t.archetype = 'SOURCE' LIMIT 1
ON CONFLICT (code) DO NOTHING;

INSERT INTO node_type (code, name, archetype, param_schema, default_params, signals, failure_modes, ui, is_builtin)
SELECT 'UTILITY_MACHINE', 'Máy phụ trợ', 'PROCESS', t.param_schema,
  '{"assumed":true,"cycle":{"dist":"lognorm","mean":90,"cv":0.2},"in_buffer":10,"out_buffer":10}'::jsonb,
  '[{"name":"vibration","unit":"mm/s","base":{"dist":"normal","mean":0.5,"sd":0.1},"hz":0.2},
    {"name":"temperature","unit":"degC","base":{"dist":"normal","mean":58,"sd":4},"hz":0.2}]'::jsonb,
  '[{"code":"bearing_wear","label":"Mòn vòng bi","description":"Rung động tăng dần trước khi máy dừng để thay hoặc sửa vòng bi.","onset":{"dist":"weibull","shape":2,"scale_s":604800},"p_to_f":{"dist":"tri","min_s":3600,"mode_s":5400,"max_s":7200},"effects":[{"signal":"vibration","kind":"exp","mag_sd":3}],"on_fail":{"state":"DOWN","mttr":{"dist":"lognorm","mean_s":3600,"cv":0.3}}},
    {"code":"motor_overheat","label":"Động cơ quá nhiệt","description":"Nhiệt độ tăng nhanh, máy dừng để làm nguội và kiểm tra tải.","injection_only":true,"onset":{"dist":"weibull","shape":2,"scale_s":604800},"p_to_f":{"dist":"tri","min_s":1200,"mode_s":2400,"max_s":4800},"effects":[{"signal":"temperature","kind":"exp","mag_sd":3}],"on_fail":{"state":"DOWN","mttr":{"dist":"lognorm","mean_s":2400,"cv":0.3}}}]'::jsonb,
  '{"icon":"cog","color":"#7c3aed"}'::jsonb, true
FROM node_type t WHERE t.archetype = 'PROCESS' LIMIT 1
ON CONFLICT (code) DO NOTHING;

-- +goose Down
DELETE FROM node_type WHERE code IN ('UTILITY_SUPPLY', 'UTILITY_MACHINE')
  AND NOT EXISTS (SELECT 1 FROM asset a WHERE a.node_type_id = node_type.id)
  AND NOT EXISTS (SELECT 1 FROM node n JOIN asset a ON a.key = n.key WHERE a.node_type_id = node_type.id);
