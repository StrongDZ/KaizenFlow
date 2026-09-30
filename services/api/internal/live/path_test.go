package live

import "testing"

func TestExtract(t *testing.T) {
	payload := map[string]any{
		"st":  "RUN",
		"cnt": map[string]any{"ok": 12.0, "ng": 1.0},
		"items": []any{
			map[string]any{"sku": "RAW-01", "qty": 320.0},
			map[string]any{"sku": "RAW-02", "qty": 45.0},
		},
		"pos": []any{1.5, 2.5},
	}
	cases := []struct {
		path string
		want any
		ok   bool
	}{
		{"st", "RUN", true},
		{"cnt.ok", 12.0, true},
		{"items[sku=RAW-02].qty", 45.0, true},
		{"items[0].sku", "RAW-01", true},
		{"pos[1]", 2.5, true},
		{"cnt.zzz", nil, false},
		{"items[sku=NOPE].qty", nil, false},
		{"items[9].qty", nil, false},
		{"st.x", nil, false},
		{"", payload, true},
	}
	for _, c := range cases {
		got, ok := Extract(payload, c.path)
		if ok != c.ok {
			t.Errorf("Extract(%q) ok = %v, want %v", c.path, ok, c.ok)
			continue
		}
		if ok && c.path != "" && got != c.want {
			t.Errorf("Extract(%q) = %v, want %v", c.path, got, c.want)
		}
	}
}

func TestExtractRootArrayAndBadPath(t *testing.T) {
	arr := []any{map[string]any{"id": "a", "v": 1.0}}
	if got, ok := Extract(arr, "[id=a].v"); !ok || got != 1.0 {
		t.Errorf("root array selector = %v, %v", got, ok)
	}
	for _, bad := range []string{"a..b", "a[", "a[x", "[", "a.[0]"} {
		if _, ok := Extract(map[string]any{"a": map[string]any{"b": 1.0}}, bad); ok {
			t.Errorf("Extract(%q) should fail", bad)
		}
	}
}
