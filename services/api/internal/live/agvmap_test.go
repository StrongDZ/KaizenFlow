package live

import "testing"

const okMap = `{"unit_m":1,"speed_mps":1.4,
 "points":[{"id":"A","x":0,"y":0,"kind":"station","node_key":"KHO"},{"id":"B","x":10,"y":0,"kind":"junction"}],
 "lanes":[{"id":"L1","from":"A","to":"B","capacity":2},{"id":"L2","from":"B","to":"A","capacity":1}]}`

func TestParseAndValidateMap(t *testing.T) {
	m, err := ParseMap([]byte(okMap))
	if err != nil {
		t.Fatal(err)
	}
	if issues := m.Validate(map[string]bool{"KHO": true}); len(issues) != 0 {
		t.Errorf("issues = %+v", issues)
	}
	if issues := m.Validate(nil); len(issues) != 0 {
		t.Errorf("nil node set means 'do not check node links': %+v", issues)
	}
}

func TestValidateMapFindsProblems(t *testing.T) {
	cases := map[string]string{
		"duplicate point": `{"speed_mps":1,"points":[{"id":"A","x":0,"y":0,"kind":"junction"},{"id":"A","x":1,"y":0,"kind":"junction"}],"lanes":[]}`,
		"bad kind":        `{"speed_mps":1,"points":[{"id":"A","x":0,"y":0,"kind":"garage"}],"lanes":[]}`,
		"lane to nowhere": `{"speed_mps":1,"points":[{"id":"A","x":0,"y":0,"kind":"junction"}],"lanes":[{"id":"L","from":"A","to":"Z","capacity":1}]}`,
		"self lane":       `{"speed_mps":1,"points":[{"id":"A","x":0,"y":0,"kind":"junction"}],"lanes":[{"id":"L","from":"A","to":"A","capacity":1}]}`,
		"zero capacity":   `{"speed_mps":1,"points":[{"id":"A","x":0,"y":0,"kind":"junction"},{"id":"B","x":1,"y":0,"kind":"junction"}],"lanes":[{"id":"L","from":"A","to":"B","capacity":0}]}`,
		"duplicate lane":  `{"speed_mps":1,"points":[{"id":"A","x":0,"y":0,"kind":"junction"},{"id":"B","x":1,"y":0,"kind":"junction"}],"lanes":[{"id":"L","from":"A","to":"B","capacity":1},{"id":"L","from":"B","to":"A","capacity":1}]}`,
		"no speed":        `{"points":[],"lanes":[]}`,
		"unknown node":    `{"speed_mps":1,"points":[{"id":"A","x":0,"y":0,"kind":"station","node_key":"NOPE"}],"lanes":[]}`,
	}
	for name, raw := range cases {
		m, err := ParseMap([]byte(raw))
		if err != nil {
			t.Errorf("%s: parse error %v", name, err)
			continue
		}
		if issues := m.Validate(map[string]bool{"KHO": true}); len(issues) == 0 {
			t.Errorf("%s: expected an issue", name)
		}
	}
	if _, err := ParseMap([]byte(`{not json`)); err == nil {
		t.Error("bad json must fail to parse")
	}
}
