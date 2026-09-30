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
// đội xe (`signal=fleet`) thì `fields` đổi tên trường của bản tin vị trí.
type Transform struct {
	Scale  *float64          `json:"scale,omitempty"`
	Offset *float64          `json:"offset,omitempty"`
	Enum   map[string]string `json:"enum,omitempty"`
	Fields map[string]string `json:"fields,omitempty"`
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
}

// Vehicle là vị trí một xe trên bản đồ.
type Vehicle struct {
	ID    string    `json:"id"`
	X     float64   `json:"x"`
	Y     float64   `json:"y"`
	State string    `json:"state"`
	Lane  string    `json:"lane"`
	Load  float64   `json:"load"`
	TS    time.Time `json:"ts"`
	AgeMS int64     `json:"age_ms"`
	seen  time.Time
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

var fleetDefaults = map[string]string{"id": "id", "x": "x", "y": "y", "state": "st", "lane": "seg", "load": "load"}

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
	v := Vehicle{ID: fmt.Sprint(idv), X: fx, Y: fy, TS: msg.TS}
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
	return Reading{Subject: b.Subject, Signal: SignalFleet, TS: msg.TS, Fleet: &v}, nil
}

// Normalize áp mọi binding đang bật khớp nguồn của bản tin. Binding hỏng chỉ sinh lỗi, không làm mất binding khác.
func Normalize(model string, bindings []Binding, msg Message) ([]Reading, []error) {
	var rs []Reading
	var errs []error
	for _, b := range bindings {
		if !b.Enabled || !MatchSource(b.Source, msg.Source) {
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
