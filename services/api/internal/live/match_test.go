package live

import "testing"

func TestMatchSource(t *testing.T) {
	cases := []struct {
		pattern, source string
		want            bool
	}{
		{"plc/prs-02/status", "plc/prs-02/status", true},
		{"plc/prs-02/status", "plc/prs-03/status", false},
		{"plc/+/status", "plc/prs-02/status", true},
		{"plc/+/status", "plc/prs-02/x/status", false},
		{"plc/#", "plc/prs-02/status", true},
		{"plc/#", "plc", true},
		{"#", "anything/at/all", true},
		{"agv/tug-a/+/pos", "agv/tug-a/01/pos", true},
		{"agv/tug-a/+/pos", "agv/tug-b/01/pos", false},
		{"", "x", false},
		{"a/#/b", "a/x/b", false}, // # chỉ hợp lệ ở cuối
	}
	for _, c := range cases {
		if got := MatchSource(c.pattern, c.source); got != c.want {
			t.Errorf("MatchSource(%q, %q) = %v, want %v", c.pattern, c.source, got, c.want)
		}
	}
}
