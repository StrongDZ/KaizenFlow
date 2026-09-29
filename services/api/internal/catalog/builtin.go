package catalog

// Builtin là một node type có sẵn. Defaults/Signals/FailureModes/UI là JSON.
// Mọi tham số mặc định là GIẢ ĐỊNH (chưa có dữ liệu DENSO) — đánh dấu "assumed": true.
type Builtin struct {
	Code, Name, Archetype           string
	Defaults, Signals, FailureModes string
	UI                              string
}

var Materials = []string{"RAW-01", "PART", "SUB", "SUB_OK", "SUB_NG", "BOX"}

var Builtins = []Builtin{
	{"DOCK_IN", "Cửa nhận hàng", "SOURCE",
		`{"assumed":true,"arrivals":{"interarrival":{"dist":"norm","mean":1800,"sd":120}}}`, `[]`, `[]`,
		`{"icon":"truck","color":"#64748b"}`},
	{"IQC", "Kiểm tra đầu vào", "PROCESS",
		`{"assumed":true,"cycle":{"dist":"tri","min":20,"mode":30,"max":60},"ng_rate":0.01}`, `[]`, `[]`,
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
		`[{"name":"vibration","unit":"mm/s","base":{"dist":"normal","mean":0.42,"sd":0.08},"hz":0.2}]`,
		`[{"code":"bearing_wear","onset":{"dist":"weibull","shape":2,"scale_s":604800},"p_to_f":{"dist":"tri","min_s":3600,"mode_s":5400,"max_s":7200},"effects":[{"signal":"vibration","kind":"exp","mag_sd":3}],"on_fail":{"state":"DOWN","mttr":{"dist":"lognorm","mean_s":3600,"cv":0.3}}}]`,
		`{"icon":"hammer","color":"#dc2626"}`},
	{"ASSEMBLY_CELL", "Cell lắp ráp", "PROCESS",
		`{"assumed":true,"cycle":{"dist":"lognorm","mean":28,"cv":0.1}}`, `[]`, `[]`,
		`{"icon":"puzzle","color":"#7c3aed"}`},
	{"AOI", "Kiểm tra AOI", "PROCESS",
		`{"assumed":true,"cycle":{"dist":"tri","min":15,"mode":20,"max":30},"ng_rate":0.03}`, `[]`, `[]`,
		`{"icon":"scan","color":"#0891b2"}`},
	{"PACKING", "Trạm đóng gói", "PROCESS",
		`{"assumed":true,"cycle":{"dist":"norm","mean":60,"sd":8}}`, `[]`, `[]`,
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
