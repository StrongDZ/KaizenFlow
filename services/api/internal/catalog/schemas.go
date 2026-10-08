// Package catalog chứa JSON Schema theo archetype và các node type built-in.
package catalog

import (
	"encoding/json"
	"strings"
)

var Archetypes = []string{"SOURCE", "STORAGE", "PROCESS", "SINK", "RESOURCE_POOL"}

const dist = `{"oneOf":[{"title":"Giá trị cố định","type":"number","minimum":0},{"title":"Phân phối xác suất","type":"object","required":["dist"],"properties":{"dist":{"title":"Loại phân phối","enum":["const","exp","norm","normal","lognorm","tri","uniform","weibull"]},"value":{"type":"number","title":"value (const)"},"mean":{"type":"number","title":"mean / mean_s"},"sd":{"type":"number","title":"sd"},"cv":{"type":"number","title":"cv"},"min":{"type":"number","title":"min"},"mode":{"type":"number","title":"mode"},"max":{"type":"number","title":"max"}}}]}`

var schemas = map[string]string{
	"SOURCE": `{"type":"object","required":["lots"],"properties":{
	  "arrivals":{"type":"object","properties":{"interarrival":{"$ref":"#/$defs/dist"},
	    "schedule_s":{"type":"array","items":{"type":"number","minimum":0}}}},
	  "lots":{"type":"array","minItems":1,"items":{"type":"object","required":["material","qty"],
	    "properties":{"material":{"type":"string","minLength":1},"qty":{"$ref":"#/$defs/dist"}}}}},
	  "$defs":{"dist":__DIST__}}`,
	"STORAGE": `{"type":"object","properties":{
	  "capacity":{"type":"number","exclusiveMinimum":0},
	  "stock":{"type":"array","items":{"type":"object","required":["material"],"properties":{
	    "material":{"type":"string","minLength":1},"initial":{"type":"number","minimum":0},
	    "max":{"type":"number","exclusiveMinimum":0}}}},
	  "coverage_thresholds":{"type":"object","properties":{"red_h":{"type":"number","minimum":0},
	    "yellow_low_h":{"type":"number","minimum":0},"yellow_high_h":{"type":"number","minimum":0}}},
	  "replenish":{"type":"object","properties":{"policy":{"enum":["NONE","REORDER_POINT"]},
	    "rop":{"type":"number","minimum":0},"qty":{"type":"integer","minimum":1}}},
	  "coverage_window_s":{"type":"number","exclusiveMinimum":0}}}`,
	"PROCESS": `{"type":"object","required":["recipes"],"properties":{
	  "recipes":{"type":"array","minItems":1,"items":{"type":"object","required":["inputs","outputs"],"properties":{
	    "inputs":{"type":"array","items":{"$ref":"#/$defs/line"}},
	    "outputs":{"type":"array","minItems":1,"items":{"allOf":[{"$ref":"#/$defs/line"},
	      {"properties":{"port":{"enum":["OK","NG"]}}}]}}}}},
	  "cycle":{"$ref":"#/$defs/dist"},"slots":{"type":"integer","minimum":1},
	  "ng_rate":{"type":"number","minimum":0,"maximum":1},
	  "in_buffer":{"type":"number","exclusiveMinimum":0},"out_buffer":{"type":"number","exclusiveMinimum":0},
	  "mtbf":{"$ref":"#/$defs/dist"},"mttr":{"$ref":"#/$defs/dist"},
	  "signals":{"type":"array","items":{"type":"object","required":["name","base"],
	    "properties":{"name":{"type":"string","minLength":1},"hz":{"type":"number","exclusiveMinimum":0}}}},
	  "failure_modes":{"type":"array","items":{"type":"object","required":["code"],
	    "properties":{"code":{"type":"string","minLength":1}}}}},
	  "$defs":{"dist":__DIST__,"line":{"type":"object","required":["material","qty"],"properties":{
	    "material":{"type":"string","minLength":1},"qty":{"type":"number","exclusiveMinimum":0}}}}}`,
	"SINK": `{"type":"object","properties":{
	  "buffer":{"type":"number","exclusiveMinimum":0},"throughput":{"type":"boolean"},
	  "demand":{"type":"array","items":{"type":"object","required":["kind","material"],"properties":{
	    "kind":{"enum":["TAKT","FORECAST"]},"material":{"type":"string","minLength":1},
	    "takt":{"$ref":"#/$defs/dist"},"qty":{"type":"number","exclusiveMinimum":0},
	    "hourly_rate":{"type":"array","items":{"type":"number","minimum":0}},
	    "forecast_ref":{"type":"object","required":["producer"],"properties":{"producer":{"type":"string"}}}}}}},
	  "$defs":{"dist":__DIST__}}`,
	"RESOURCE_POOL": `{"type":"object","required":["kind","count"],"properties":{
	  "kind":{"enum":["AGV","AMR","TUGGER","FORKLIFT","OPERATOR"]},"count":{"type":"integer","minimum":1},
	  "service":{"$ref":"#/$defs/dist"}},"$defs":{"dist":__DIST__}}`,
}

// SchemaFor trả JSON Schema của một archetype.
func SchemaFor(archetype string) (json.RawMessage, bool) {
	s, ok := schemas[archetype]
	if !ok {
		return nil, false
	}
	return json.RawMessage(strings.ReplaceAll(s, "__DIST__", dist)), true
}
