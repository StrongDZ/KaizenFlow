package live

import "math"

// Frame đổi toạ độ do hãng xe báo sang toạ độ bản đồ (mét): lật Y nếu cần → nhân scale → xoay RotDeg → dịch (DX, DY).
// Scale 0 nghĩa là 1; Frame nil là phép đồng nhất.
type Frame struct {
	DX     float64 `json:"dx"`
	DY     float64 `json:"dy"`
	RotDeg float64 `json:"rot_deg"`
	Scale  float64 `json:"scale"`
	FlipY  bool    `json:"flip_y"`
}

func (f *Frame) Apply(x, y float64) (float64, float64) {
	if f == nil {
		return x, y
	}
	if f.FlipY {
		y = -y
	}
	s := f.Scale
	if s == 0 {
		s = 1
	}
	x, y = x*s, y*s
	r := f.RotDeg * math.Pi / 180
	c, sn := math.Cos(r), math.Sin(r)
	return f.DX + c*x - sn*y, f.DY + sn*x + c*y
}

// Heading đổi hướng (độ, theo atan2(dy, dx) của hệ hãng xe) sang hướng trong hệ bản đồ, chuẩn hoá về [0, 360).
func (f *Frame) Heading(h float64) float64 {
	if f == nil {
		return h
	}
	if f.FlipY {
		h = -h
	}
	h = math.Mod(h+f.RotDeg, 360)
	if h < 0 {
		h += 360
	}
	return h
}
