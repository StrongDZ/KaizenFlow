package live

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Message là một bản tin thô. TS là giờ ảo của nhà máy (feed có hệ số tốc độ).
type Message struct {
	Source  string    `json:"source"`
	TS      time.Time `json:"ts"`
	Desc    string    `json:"desc,omitempty"`
	Payload any       `json:"payload"`
}

// Transform biến đổi giá trị đã trích: số thì `v*scale+offset`; trạng thái thì đổi theo bảng `enum`;
// đội xe (`signal=fleet`) thì `fields` đổi tên trường của bản tin vị trí và `frame` đổi hệ toạ độ.
type Transform struct {
	Scale  *float64          `json:"scale,omitempty"`
	Offset *float64          `json:"offset,omitempty"`
	Enum   map[string]string `json:"enum,omitempty"`
	Fields map[string]string `json:"fields,omitempty"`
	// Frame (chỉ cho đội xe): đổi toạ độ hãng xe báo sang toạ độ bản đồ. Nil là đồng nhất.
	Frame *Frame `json:"frame,omitempty"`
}

// Binding gắn một tín hiệu chuẩn của node/edge với một trường của một nguồn.
type Binding struct {
	ID        int64     `json:"id"`
	ModelKey  string    `json:"model_key"`
	Subject   string    `json:"subject"`
	Signal    string    `json:"signal"`
	Source    string    `json:"source"`
	JSONPath  string    `json:"json_path"`
	Transform Transform `json:"transform"`
	Enabled   bool      `json:"enabled"`
	// Mode: ModeSource (mặc định, lấy từ trường của nguồn) hoặc ModeDerived (tự tính bằng Derive, không có nguồn).
	Mode   string  `json:"mode"`
	Derive *Derive `json:"derive,omitempty"`
	// Shared: đây là ghép nối của một THIẾT BỊ, lưu một lần và áp cho mọi mô hình có thiết bị đó.
	// Đọc trong phạm vi một mô hình thì ModelKey đã được ghi thành mô hình đó, nên cần cờ này để
	// giao diện biết sửa hay xoá nó sẽ ảnh hưởng cả các mô hình khác.
	Shared bool `json:"shared,omitempty"`
}

// Vehicle là vị trí một xe trên bản đồ.
type Vehicle struct {
	ID string `json:"id"`
	// X, Y là toạ độ bản đồ (mét, sau khi đổi khung); RawX, RawY là toạ độ hãng xe báo, để căn chỉnh khung.
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	RawX float64 `json:"raw_x"`
	RawY float64 `json:"raw_y"`
	// Heading là hướng (độ, atan2(dy, dx) trong hệ bản đồ); nil nếu bản tin không có.
	Heading *float64 `json:"heading,omitempty"`
	State   string   `json:"state"`
	// Lane là làn xe tự báo hoặc làn do khớp vị trí tìm ra; S là mét dọc làn; Off là xe không nằm trên làn nào (khi đã có bản đồ).
	Lane string  `json:"lane"`
	S    float64 `json:"s"`
	Off  bool    `json:"off_map"`
	Load float64 `json:"load"`
	// Tuỳ chọn, chỉ có khi thiết bị báo (AMR theo trả lời của BTC: tốc độ, trạng thái pin, đích và tuyến đang thực hiện).
	Speed   *float64  `json:"speed,omitempty"`   // m/s
	Battery *float64  `json:"battery,omitempty"` // %
	Dest    string    `json:"dest,omitempty"`
	Route   []string  `json:"route,omitempty"` // các điểm còn phải qua tới đích
	TS      time.Time `json:"ts"`
	AgeMS   int64     `json:"age_ms"`
	seen    time.Time
}

// Reading là một giá trị đã chuẩn hoá của (subject, signal).
type Reading struct {
	Model   string
	Subject string
	Signal  string
	TS      time.Time
	Num     float64
	Text    string
	IsText  bool
	Fleet   *Vehicle
}

// IsTextSignal: tín hiệu dạng chữ (đi vào STATE), còn lại là số.
func IsTextSignal(signal string) bool { return signal == "state" }

// SignalFleet là tín hiệu đặc biệt: bản tin vị trí xe của một đội.
const SignalFleet = "fleet"

func toFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case float32:
		return float64(x), true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		return f, err == nil
	}
	return 0, false
}

var fleetDefaults = map[string]string{"id": "id", "x": "x", "y": "y", "heading": "th", "state": "st", "lane": "seg", "load": "load",
	"speed": "v", "battery": "batt", "dest": "dst", "route": "route"}

func fleetField(t Transform, name string) string {
	if p, ok := t.Fields[name]; ok && p != "" {
		return p
	}
	return fleetDefaults[name]
}

func normalizeFleet(b Binding, msg Message) (Reading, error) {
	get := func(name string) (any, bool) { return Extract(msg.Payload, fleetField(b.Transform, name)) }
	idv, ok := get("id")
	if !ok {
		return Reading{}, fmt.Errorf("%s/%s: bản tin xe thiếu trường id", b.Subject, b.Signal)
	}
	x, okx := get("x")
	y, oky := get("y")
	fx, okfx := toFloat(x)
	fy, okfy := toFloat(y)
	if !okx || !oky || !okfx || !okfy {
		return Reading{}, fmt.Errorf("%s/%s: bản tin xe thiếu toạ độ x, y", b.Subject, b.Signal)
	}
	v := Vehicle{ID: fmt.Sprint(idv), RawX: fx, RawY: fy, TS: msg.TS}
	v.X, v.Y = b.Transform.Frame.Apply(fx, fy)
	if h, ok := get("heading"); ok {
		if fh, ok := toFloat(h); ok {
			hh := b.Transform.Frame.Heading(fh)
			v.Heading = &hh
		}
	}
	if s, ok := get("state"); ok {
		v.State = strings.ToUpper(fmt.Sprint(s))
		if mapped, ok := b.Transform.Enum[v.State]; ok {
			v.State = mapped
		}
	}
	if s, ok := get("lane"); ok {
		v.Lane = fmt.Sprint(s)
	}
	if l, ok := get("load"); ok {
		v.Load, _ = toFloat(l)
	}
	if sp, ok := get("speed"); ok {
		if f, ok := toFloat(sp); ok {
			v.Speed = &f
		}
	}
	if bt, ok := get("battery"); ok {
		if f, ok := toFloat(bt); ok {
			v.Battery = &f
		}
	}
	if d, ok := get("dest"); ok {
		v.Dest = fmt.Sprint(d)
	}
	if r, ok := get("route"); ok {
		if list, ok := r.([]any); ok {
			for _, p := range list {
				v.Route = append(v.Route, fmt.Sprint(p))
			}
		}
	}
	return Reading{Subject: b.Subject, Signal: SignalFleet, TS: msg.TS, Fleet: &v}, nil
}

// Normalize áp mọi binding đang bật khớp nguồn của bản tin. Binding hỏng chỉ sinh lỗi, không làm mất binding khác.
func Normalize(model string, bindings []Binding, msg Message) ([]Reading, []error) {
	var rs []Reading
	var errs []error
	for _, b := range bindings {
		if !b.Enabled || b.Mode == ModeDerived || !MatchSource(b.Source, msg.Source) {
			continue
		}
		var r Reading
		var err error
		switch {
		case b.Signal == SignalFleet:
			r, err = normalizeFleet(b, msg)
		default:
			r, err = normalizeOne(b, msg)
		}
		if err != nil {
			errs = append(errs, err)
			continue
		}
		r.Model = model
		rs = append(rs, r)
	}
	return rs, errs
}

func normalizeOne(b Binding, msg Message) (Reading, error) {
	raw, ok := Extract(msg.Payload, b.JSONPath)
	if !ok {
		return Reading{}, fmt.Errorf("%s/%s: không thấy trường '%s' trong bản tin %s", b.Subject, b.Signal, b.JSONPath, msg.Source)
	}
	r := Reading{Subject: b.Subject, Signal: b.Signal, TS: msg.TS}
	if IsTextSignal(b.Signal) {
		text := strings.ToUpper(fmt.Sprint(raw))
		if len(b.Transform.Enum) > 0 {
			mapped, ok := b.Transform.Enum[fmt.Sprint(raw)]
			if !ok {
				mapped, ok = b.Transform.Enum[text]
			}
			if !ok {
				return Reading{}, fmt.Errorf("%s/%s: giá trị '%v' chưa có trong bảng đổi trạng thái", b.Subject, b.Signal, raw)
			}
			text = mapped
		}
		r.IsText, r.Text = true, text
		return r, nil
	}
	v, ok := toFloat(raw)
	if !ok {
		return Reading{}, fmt.Errorf("%s/%s: giá trị '%v' không phải số", b.Subject, b.Signal, raw)
	}
	if b.Transform.Scale != nil {
		v *= *b.Transform.Scale
	}
	if b.Transform.Offset != nil {
		v += *b.Transform.Offset
	}
	r.Num = v
	return r, nil
}
