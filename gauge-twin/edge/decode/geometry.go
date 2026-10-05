// Package decode turns raw model output (FrameResult) into gauge readings and
// aggregates them per window, following SPEC section 4.2. It is pure logic:
// no I/O, no clocks.
package decode

import (
	"errors"
	"math"
)

// Point is a 2D position in pixels.
type Point struct{ X, Y float64 }

// Homography is a 3x3 projective transform in row-major order.
type Homography [9]float64

// Apply maps a point through the homography.
func (h Homography) Apply(p Point) Point {
	w := h[6]*p.X + h[7]*p.Y + h[8]
	return Point{(h[0]*p.X + h[1]*p.Y + h[2]) / w, (h[3]*p.X + h[4]*p.Y + h[5]) / w}
}

// QuadToSquare returns the homography mapping a quad (TL, TR, BR, BL) onto
// the square [0, size] x [0, size], in which calib is expressed.
func QuadToSquare(quad [4]Point, size float64) (Homography, error) {
	dst := [4]Point{{0, 0}, {size, 0}, {size, size}, {0, size}}
	// Solve the 8 unknowns of h (h[8] = 1) from the 4 point pairs.
	var a [8][9]float64
	for i := 0; i < 4; i++ {
		s, d := quad[i], dst[i]
		a[2*i] = [9]float64{s.X, s.Y, 1, 0, 0, 0, -d.X * s.X, -d.X * s.Y, d.X}
		a[2*i+1] = [9]float64{0, 0, 0, s.X, s.Y, 1, -d.Y * s.X, -d.Y * s.Y, d.Y}
	}
	for col := 0; col < 8; col++ {
		pivot := col
		for row := col + 1; row < 8; row++ {
			if math.Abs(a[row][col]) > math.Abs(a[pivot][col]) {
				pivot = row
			}
		}
		if math.Abs(a[pivot][col]) < 1e-12 {
			return Homography{}, errors.New("degenerate quad")
		}
		a[col], a[pivot] = a[pivot], a[col]
		for row := 0; row < 8; row++ {
			if row == col {
				continue
			}
			factor := a[row][col] / a[col][col]
			for k := col; k < 9; k++ {
				a[row][k] -= factor * a[col][k]
			}
		}
	}
	var h Homography
	for i := 0; i < 8; i++ {
		h[i] = a[i][8] / a[i][i]
	}
	h[8] = 1
	return h, nil
}

func angleDeg(center, p Point) float64 {
	return math.Atan2(p.Y-center.Y, p.X-center.X) * 180 / math.Pi
}

func mod360(v float64) float64 {
	v = math.Mod(v, 360)
	if v < 0 {
		v += 360
	}
	return v
}

// DialCalib is the calibration of an analog dial in the rectified square.
type DialCalib struct {
	Center, MinPt, MaxPt Point
	MinVal, MaxVal       float64
	Clockwise            bool
}

// Value converts the needle direction (pivot to tip, both in the rectified
// square) into a reading by interpolating between MinPt and MaxPt. A needle
// in the dead zone reads beyond the nearer end of the scale (below MinVal or
// above MaxVal): real gauges rest a little under zero and can be driven past
// full scale, and a reading pinned to the end would hide both.
func (c DialCalib) Value(center, tip Point) float64 {
	aMin, aMax := angleDeg(c.Center, c.MinPt), angleDeg(c.Center, c.MaxPt)
	angle := angleDeg(center, tip)
	var span, travelled float64
	if c.Clockwise {
		span, travelled = mod360(aMax-aMin), mod360(angle-aMin)
	} else {
		span, travelled = mod360(aMin-aMax), mod360(aMin-angle)
	}
	if span == 0 {
		span = 360
	}
	// The dead zone is split in the middle: its first half continues the
	// scale past Max, its second half is the approach to Min from below.
	if travelled-span >= (360-span)/2 {
		travelled -= 360
	}
	return c.MinVal + (c.MaxVal-c.MinVal)*travelled/span
}

// Overtravel is how far a value lies outside the scale, as a share of the
// range; 0 for a value on the scale.
func (c DialCalib) Overtravel(value float64) float64 {
	lo, hi := math.Min(c.MinVal, c.MaxVal), math.Max(c.MinVal, c.MaxVal)
	switch {
	case value < lo:
		return (lo - value) / (hi - lo)
	case value > hi:
		return (value - hi) / (hi - lo)
	}
	return 0
}
