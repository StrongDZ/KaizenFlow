package live

import (
	"math"
	"testing"
)

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func TestFrameApply(t *testing.T) {
	cases := []struct {
		name   string
		f      *Frame
		x, y   float64
		wx, wy float64
	}{
		{"nil là đồng nhất", nil, 3, 4, 3, 4},
		{"rỗng là đồng nhất (scale 0 = 1)", &Frame{}, 3, 4, 3, 4},
		{"mm sang mét", &Frame{Scale: 0.001}, 2000, 500, 2, 0.5},
		{"xoay 90°", &Frame{RotDeg: 90}, 1, 0, 0, 1},
		{"dịch", &Frame{DX: 10, DY: -5}, 1, 2, 11, -3},
		{"lật Y rồi dịch", &Frame{FlipY: true, DY: 100}, 5, 20, 5, 80},
		{"scale rồi xoay rồi dịch", &Frame{Scale: 2, RotDeg: 90, DX: 1, DY: 1}, 1, 0, 1, 3},
	}
	for _, c := range cases {
		gx, gy := c.f.Apply(c.x, c.y)
		if !near(gx, c.wx) || !near(gy, c.wy) {
			t.Errorf("%s: (%v,%v), muốn (%v,%v)", c.name, gx, gy, c.wx, c.wy)
		}
	}
}

func TestFrameHeading(t *testing.T) {
	if got := (*Frame)(nil).Heading(30); got != 30 {
		t.Errorf("nil: %v", got)
	}
	if got := (&Frame{RotDeg: 90}).Heading(10); !near(got, 100) {
		t.Errorf("xoay: %v", got)
	}
	if got := (&Frame{FlipY: true}).Heading(30); !near(got, 330) {
		t.Errorf("lật Y đảo dấu góc: %v", got)
	}
	if got := (&Frame{RotDeg: 90}).Heading(350); !near(got, 80) {
		t.Errorf("chuẩn hoá về [0,360): %v", got)
	}
}
