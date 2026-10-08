package live

import (
	"strings"
	"testing"
)

var square = []Pt{{0, 0}, {10, 0}, {10, 10}, {0, 10}}

func TestPointInPolygonIsStrict(t *testing.T) {
	cases := []struct {
		name string
		p    Pt
		in   bool
	}{
		{"inside", Pt{5, 5}, true},
		{"outside", Pt{15, 5}, false},
		{"on an edge", Pt{0, 5}, false},
		{"on a corner", Pt{10, 10}, false},
	}
	for _, c := range cases {
		if got := pointInPolygon(c.p, square); got != c.in {
			t.Errorf("%s: pointInPolygon(%v) = %v, want %v", c.name, c.p, got, c.in)
		}
	}
	// Đa giác lõm: điểm nằm trong "hõm" thì ở ngoài.
	u := []Pt{{0, 0}, {10, 0}, {10, 10}, {7, 10}, {7, 3}, {3, 3}, {3, 10}, {0, 10}}
	if pointInPolygon(Pt{5, 8}, u) || !pointInPolygon(Pt{1, 8}, u) {
		t.Error("concave polygon handled wrongly")
	}
}

func TestSegmentEntersPolygon(t *testing.T) {
	cases := []struct {
		name string
		a, b Pt
		hit  bool
	}{
		{"passes through", Pt{-5, 5}, Pt{15, 5}, true},
		{"ends inside", Pt{-5, 5}, Pt{5, 5}, true},
		{"entirely inside", Pt{2, 2}, Pt{8, 8}, true},
		{"entirely outside", Pt{-5, -5}, Pt{-1, 10}, false},
		{"runs along an edge", Pt{0, 0}, Pt{10, 0}, false},
		{"grazes a corner", Pt{-5, 5}, Pt{5, -5}, false},
		{"stops on the boundary", Pt{-5, 5}, Pt{0, 5}, false},
		{"cuts across a corner", Pt{-2, 8}, Pt{2, 10.4}, true},
		{"touches only the corner at (0,10)", Pt{-2, 8}, Pt{2, 12}, false},
		{"through two opposite corners", Pt{-1, -1}, Pt{11, 11}, true},
	}
	for _, c := range cases {
		if got := segmentEntersPolygon(c.a, c.b, square); got != c.hit {
			t.Errorf("%s: segmentEntersPolygon(%v, %v) = %v, want %v", c.name, c.a, c.b, got, c.hit)
		}
	}
}

func keepoutMap(extra string) *AgvMap {
	m, err := ParseMap([]byte(`{"v":2,"speed_mps":1,` + extra + `}`))
	if err != nil {
		panic(err)
	}
	return m
}

func TestValidateKeepouts(t *testing.T) {
	const ko = `"keepouts":[{"id":"K1","poly":[{"x":20,"y":-5},{"x":30,"y":-5},{"x":30,"y":5},{"x":20,"y":5}]}],`
	pts := `"points":[{"id":"A","x":0,"y":0,"kind":"junction"},{"id":"B","x":50,"y":0,"kind":"junction"},{"id":"C","x":0,"y":20,"kind":"junction"},{"id":"D","x":50,"y":20,"kind":"junction"}],`
	cases := []struct {
		name string
		raw  string
		key  string // khoá của lỗi mong đợi; rỗng là không có lỗi
		msg  string
	}{
		{"lane around the zone is fine", ko + pts + `"lanes":[{"id":"L1","from":"A","to":"C","capacity":1},{"id":"L2","from":"C","to":"D","capacity":1},{"id":"L3","from":"D","to":"B","capacity":1}]`, "", ""},
		{"lane through the zone", ko + pts + `"lanes":[{"id":"L1","from":"A","to":"B","capacity":1}]`, "L1", "K1"},
		{"bend inside the zone", ko + pts + `"lanes":[{"id":"L1","from":"A","to":"C","capacity":1,"path":[{"x":25,"y":0}]}]`, "L1", "K1"},
		{"point inside the zone", ko + `"points":[{"id":"S","x":25,"y":0,"kind":"station"}],"lanes":[]`, "S", "K1"},
		{"two corners only", `"keepouts":[{"id":"K1","poly":[{"x":0,"y":0},{"x":5,"y":5}]}],"points":[],"lanes":[]`, "K1", "3 đỉnh"},
		{"zero area", `"keepouts":[{"id":"K1","poly":[{"x":0,"y":0},{"x":5,"y":5},{"x":10,"y":10}]}],"points":[],"lanes":[]`, "K1", "diện tích"},
		{"duplicate id", `"keepouts":[{"id":"K1","poly":[{"x":0,"y":0},{"x":5,"y":0},{"x":5,"y":5}]},{"id":"K1","poly":[{"x":20,"y":0},{"x":25,"y":0},{"x":25,"y":5}]}],"points":[],"lanes":[]`, "K1", "trùng"},
		{"missing id", `"keepouts":[{"id":"","poly":[{"x":0,"y":0},{"x":5,"y":0},{"x":5,"y":5}]}],"points":[],"lanes":[]`, "keepout", "id"},
	}
	for _, c := range cases {
		issues := keepoutMap(c.raw).Validate(nil)
		if c.key == "" {
			if len(issues) != 0 {
				t.Errorf("%s: unexpected issues %+v", c.name, issues)
			}
			continue
		}
		if len(issues) != 1 || issues[0].Key != c.key || !strings.Contains(issues[0].Message, c.msg) {
			t.Errorf("%s: issues = %+v, want one on %q mentioning %q", c.name, issues, c.key, c.msg)
		}
	}
}
