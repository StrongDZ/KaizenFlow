package catalog

import "encoding/json"

// Builtin là một node type có sẵn. Defaults/Signals/FailureModes/UI là JSON.
// Mọi tham số mặc định là GIẢ ĐỊNH (chưa có dữ liệu DENSO) — đánh dấu "assumed": true.
type Builtin struct {
	Code, Name, Archetype           string
	Defaults, Signals, FailureModes string
	UI                              string
}

var Materials = []string{"RAW-01", "PART", "SUB", "SUB_OK", "SUB_NG", "BOX"}

const iqcSignals = `[]`
const iqcFailures = `[
  {"code":"calibration_drift","label":"Trôi hiệu chuẩn thiết bị đo","description":"Sai lệch phép đo tăng dần; cần hiệu chuẩn lại trước khi tiếp tục kiểm tra.","onset":{"dist":"weibull","shape":2,"scale_s":1209600},"p_to_f":{"dist":"tri","min_s":1800,"mode_s":3600,"max_s":7200},"effects":[],"on_fail":{"state":"DOWN","mttr":{"dist":"lognorm","mean_s":1800,"cv":0.25}}}
]`

const stampSignals = `[{"name":"vibration","unit":"mm/s","base":{"dist":"normal","mean":0.42,"sd":0.08},"hz":0.2}]`
const stampFailures = `[
  {"code":"bearing_wear","label":"Mòn vòng bi","description":"Rung động tăng dần trước khi máy dừng để thay hoặc sửa vòng bi.","onset":{"dist":"weibull","shape":2,"scale_s":604800},"p_to_f":{"dist":"tri","min_s":3600,"mode_s":5400,"max_s":7200},"effects":[{"signal":"vibration","kind":"exp","mag_sd":3}],"on_fail":{"state":"DOWN","mttr":{"dist":"lognorm","mean_s":3600,"cv":0.3}}},
  {"code":"die_jam","label":"Kẹt khuôn / kẹt phôi","description":"Kẹt vật liệu tại khuôn gây rung đột biến và buộc máy dập dừng xử lý.","onset":{"dist":"weibull","shape":2,"scale_s":259200},"p_to_f":{"dist":"tri","min_s":300,"mode_s":600,"max_s":1200},"effects":[{"signal":"vibration","kind":"spike","mag_sd":6}],"on_fail":{"state":"DOWN","mttr":{"dist":"lognorm","mean_s":1200,"cv":0.35}}},
  {"code":"hydraulic_pressure_loss","label":"Mất áp suất thủy lực","description":"Áp suất hệ thủy lực giảm dần tới mức máy không thể tiếp tục chu kỳ dập.","onset":{"dist":"weibull","shape":2,"scale_s":432000},"p_to_f":{"dist":"tri","min_s":900,"mode_s":1800,"max_s":3600},"effects":[],"on_fail":{"state":"DOWN","mttr":{"dist":"lognorm","mean_s":2700,"cv":0.3}}},
  {"code":"motor_overheat","label":"Động cơ quá nhiệt","description":"Nhiệt độ động cơ tăng nhanh và máy dừng để làm nguội, kiểm tra tải hoặc hệ thống tản nhiệt.","onset":{"dist":"weibull","shape":2,"scale_s":604800},"p_to_f":{"dist":"tri","min_s":1200,"mode_s":2400,"max_s":4800},"effects":[],"on_fail":{"state":"DOWN","mttr":{"dist":"lognorm","mean_s":2400,"cv":0.3}}}
]`

const assemblySignals = `[]`
const assemblyFailures = `[
  {"code":"tool_wear","label":"Mòn dụng cụ lắp ráp","description":"Mô-men siết lệch dần do dụng cụ mòn; cần thay dụng cụ và xác nhận lại chất lượng.","onset":{"dist":"weibull","shape":2,"scale_s":604800},"p_to_f":{"dist":"tri","min_s":1800,"mode_s":3600,"max_s":7200},"effects":[],"on_fail":{"state":"DOWN","mttr":{"dist":"lognorm","mean_s":1800,"cv":0.25}}},
  {"code":"actuator_jam","label":"Kẹt cơ cấu chấp hành","description":"Cơ cấu cấp hoặc gá chi tiết bị kẹt và cell phải dừng để xử lý.","onset":{"dist":"weibull","shape":2,"scale_s":345600},"p_to_f":{"dist":"tri","min_s":300,"mode_s":900,"max_s":1800},"effects":[],"on_fail":{"state":"DOWN","mttr":{"dist":"lognorm","mean_s":1200,"cv":0.3}}},
  {"code":"torque_sensor_fault","label":"Lỗi cảm biến lực siết","description":"Tín hiệu mô-men không còn đáng tin cậy; cell dừng để kiểm tra cảm biến và truy xuất chất lượng.","onset":{"dist":"weibull","shape":2,"scale_s":518400},"p_to_f":{"dist":"tri","min_s":600,"mode_s":1200,"max_s":2400},"effects":[],"on_fail":{"state":"DOWN","mttr":{"dist":"lognorm","mean_s":900,"cv":0.25}}}
]`

const aoiSignals = `[]`
const aoiFailures = `[
  {"code":"camera_degradation","label":"Suy giảm camera AOI","description":"Chất lượng ảnh giảm dần do bẩn hoặc lệch quang học, cần vệ sinh và căn chỉnh camera.","onset":{"dist":"weibull","shape":2,"scale_s":604800},"p_to_f":{"dist":"tri","min_s":1800,"mode_s":3600,"max_s":7200},"effects":[],"on_fail":{"state":"DOWN","mttr":{"dist":"lognorm","mean_s":1800,"cv":0.25}}},
  {"code":"illumination_failure","label":"Mất đèn chiếu sáng AOI","description":"Nguồn sáng kiểm tra mất hoặc suy hỏng khiến AOI không thể đánh giá sản phẩm.","onset":{"dist":"weibull","shape":2,"scale_s":432000},"p_to_f":{"dist":"tri","min_s":300,"mode_s":600,"max_s":1200},"effects":[],"on_fail":{"state":"DOWN","mttr":{"dist":"lognorm","mean_s":900,"cv":0.25}}}
]`

const packingSignals = `[]`
const packingFailures = `[
  {"code":"conveyor_jam","label":"Kẹt băng tải đóng gói","description":"Bao bì hoặc sản phẩm kẹt trên băng tải và trạm phải dừng gỡ kẹt.","onset":{"dist":"weibull","shape":2,"scale_s":345600},"p_to_f":{"dist":"tri","min_s":300,"mode_s":600,"max_s":1200},"effects":[],"on_fail":{"state":"DOWN","mttr":{"dist":"lognorm","mean_s":1200,"cv":0.3}}},
  {"code":"sealer_overheat","label":"Bộ ép nhiệt quá nóng","description":"Nhiệt độ bộ hàn miệng bao tăng cao; trạm dừng để tránh lỗi bao bì và nguy cơ an toàn.","onset":{"dist":"weibull","shape":2,"scale_s":518400},"p_to_f":{"dist":"tri","min_s":900,"mode_s":1800,"max_s":3600},"effects":[],"on_fail":{"state":"DOWN","mttr":{"dist":"lognorm","mean_s":1800,"cv":0.25}}}
]`

// failureCatalog đánh dấu các mode mới là chỉ chạy khi operator tiêm trong Scenario.
// bearing_wear là mode cũ duy nhất vẫn được phép phát sinh ngẫu nhiên trong baseline.
func failureCatalog(raw string, spontaneous ...string) string {
	allowed := map[string]bool{}
	for _, code := range spontaneous {
		allowed[code] = true
	}
	var modes []map[string]any
	if err := json.Unmarshal([]byte(raw), &modes); err != nil {
		panic("invalid built-in failure catalog: " + err.Error())
	}
	for _, mode := range modes {
		code, _ := mode["code"].(string)
		if !allowed[code] {
			mode["injection_only"] = true
		}
	}
	out, err := json.Marshal(modes)
	if err != nil {
		panic("encode built-in failure catalog: " + err.Error())
	}
	return string(out)
}

var Builtins = []Builtin{
	{"DOCK_IN", "Cửa nhận hàng", "SOURCE",
		`{"assumed":true,"arrivals":{"interarrival":{"dist":"norm","mean":1800,"sd":120}}}`, `[]`, `[]`,
		`{"icon":"truck","color":"#64748b"}`},
	{"IQC", "Kiểm tra đầu vào", "PROCESS",
		`{"assumed":true,"cycle":{"dist":"tri","min":20,"mode":30,"max":60},"ng_rate":0.01}`, iqcSignals, failureCatalog(iqcFailures),
		`{"icon":"search","color":"#0ea5e9"}`},
	{"RACK_WAREHOUSE", "Kho kệ", "STORAGE",
		`{"assumed":true,"capacity":2000,"coverage_thresholds":{"red_h":1,"yellow_low_h":4,"yellow_high_h":12}}`,
		`[]`, `[]`, `{"icon":"warehouse","color":"#a16207"}`},
	{"SUPERMARKET", "Supermarket", "STORAGE",
		`{"assumed":true,"coverage_thresholds":{"red_h":0.5,"yellow_low_h":1.5,"yellow_high_h":6},"replenish":{"policy":"REORDER_POINT","rop":20,"qty":40}}`,
		`[]`, `[]`, `{"icon":"store","color":"#ca8a04"}`},
	{"WIP_BUFFER", "Buffer WIP", "STORAGE",
		`{"assumed":true,"coverage_thresholds":{"red_h":0,"yellow_low_h":0,"yellow_high_h":99}}`,
		`[]`, `[]`, `{"icon":"inbox","color":"#78716c"}`},
	{"STAMP_PRESS", "Máy dập", "PROCESS",
		`{"assumed":true,"cycle":{"dist":"lognorm","mean":45,"cv":0.15},"in_buffer":40,"out_buffer":20}`,
		stampSignals, failureCatalog(stampFailures, "bearing_wear"),
		`{"icon":"hammer","color":"#dc2626"}`},
	{"ASSEMBLY_CELL", "Cell lắp ráp", "PROCESS",
		`{"assumed":true,"cycle":{"dist":"lognorm","mean":28,"cv":0.1}}`, assemblySignals, failureCatalog(assemblyFailures),
		`{"icon":"puzzle","color":"#7c3aed"}`},
	{"AOI", "Kiểm tra AOI", "PROCESS",
		`{"assumed":true,"cycle":{"dist":"tri","min":15,"mode":20,"max":30},"ng_rate":0.03}`, aoiSignals, failureCatalog(aoiFailures),
		`{"icon":"scan","color":"#0891b2"}`},
	{"PACKING", "Trạm đóng gói", "PROCESS",
		`{"assumed":true,"cycle":{"dist":"norm","mean":60,"sd":8}}`, packingSignals, failureCatalog(packingFailures),
		`{"icon":"package","color":"#16a34a"}`},
	{"SHIP_DOCK", "Cửa xuất hàng", "SINK", `{"assumed":true,"buffer":2}`, `[]`, `[]`,
		`{"icon":"send","color":"#475569"}`},
	{"SCRAP", "Phế phẩm", "SINK", `{"buffer":1000000,"throughput":false}`, `[]`, `[]`,
		`{"icon":"trash","color":"#991b1b"}`},
	{"TUGGER", "Xe kéo (tugger)", "RESOURCE_POOL",
		`{"assumed":true,"kind":"TUGGER","count":2,"service":{"dist":"const","value":30}}`, `[]`, `[]`,
		`{"icon":"tractor","color":"#ea580c"}`},
	{"AGV", "AGV", "RESOURCE_POOL",
		`{"assumed":true,"kind":"AGV","count":3,"service":{"dist":"const","value":20}}`, `[]`, `[]`,
		`{"icon":"bot","color":"#2563eb"}`},
	{"HOOK_OPERATOR", "Người móc kéo", "RESOURCE_POOL",
		`{"assumed":true,"kind":"OPERATOR","count":1,"service":{"dist":"tri","min":60,"mode":150,"max":300}}`,
		`[]`, `[]`, `{"icon":"user","color":"#db2777"}`},
}
