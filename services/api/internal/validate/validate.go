// Package validate kiểm tra đồ thị model trước khi publish (JSON Schema + luật spec §6).
package validate

import (
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/kaizenflow/api/internal/resolve"
	"github.com/kaizenflow/api/internal/store"
)

type Issue struct {
	Key     string `json:"key"`
	Message string `json:"message"`
}

type Validator struct {
	mu    sync.Mutex
	cache map[string]*jsonschema.Schema
}

func New() *Validator { return &Validator{cache: map[string]*jsonschema.Schema{}} }

func (v *Validator) schema(t store.NodeType) (*jsonschema.Schema, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	cacheKey := t.Code + "|" + string(t.ParamSchema)
	if s, ok := v.cache[cacheKey]; ok {
		return s, nil
	}
	doc, err := jsonschema.UnmarshalJSON(strings.NewReader(string(t.ParamSchema)))
	if err != nil {
		return nil, err
	}
	c := jsonschema.NewCompiler()
	url := "mem://" + t.Code + ".json"
	if err := c.AddResource(url, doc); err != nil {
		return nil, err
	}
	s, err := c.Compile(url)
	if err != nil {
		return nil, err
	}
	v.cache[cacheKey] = s
	return s, nil
}

func firstLine(err error) string {
	lines := strings.Split(err.Error(), "\n")
	if len(lines) > 1 {
		return strings.TrimSpace(strings.Join(lines[1:], " "))
	}
	return lines[0]
}

func (v *Validator) Graph(g *store.Graph, types map[string]store.NodeType) []Issue {
	var out []Issue
	add := func(key, format string, a ...any) { out = append(out, Issue{key, fmt.Sprintf(format, a...)}) }
	arche := map[string]string{}
	merged := map[string]map[string]any{}
	sources, sinks := 0, 0
	for _, n := range g.Nodes {
		t, ok := types[n.NodeType]
		if !ok {
			add(n.Key, "unknown node type '%s'", n.NodeType)
			continue
		}
		arche[n.Key] = t.Archetype
		p, err := resolve.MergeNodeParams(t, n)
		if err != nil {
			add(n.Key, "params: %v", err)
			continue
		}
		merged[n.Key] = p
		if s, err := v.schema(t); err != nil {
			add(n.Key, "schema: %v", err)
		} else if err := s.Validate(p); err != nil {
			add(n.Key, "params: %s", firstLine(err))
		}
		switch t.Archetype {
		case "SOURCE":
			sources++
		case "SINK":
			sinks++
		}
	}
	if sources == 0 {
		add("model", "needs at least one SOURCE")
	}
	if sinks == 0 {
		add("model", "needs at least one SINK")
	}
	supplied := map[string]bool{}
	adj := map[string][]string{}
	for _, e := range g.Edges {
		if arche[e.Src] == "RESOURCE_POOL" || arche[e.Dst] == "RESOURCE_POOL" {
			add(e.Key, "edges cannot connect a RESOURCE_POOL")
			continue
		}
		if e.Material == "" {
			add(e.Key, "edge needs a material")
		}
		supplied[e.Dst+"|"+e.Material] = true
		if mode, _ := e.Params["mode"].(string); mode == "POOL" {
			if pk, _ := e.Params["pool"].(string); arche[pk] != "RESOURCE_POOL" {
				add(e.Key, "pool '%v' is not a RESOURCE_POOL node", e.Params["pool"])
			}
		}
		if hk, ok := e.Params["hook_pool"].(string); ok && hk != "" {
			if arche[hk] != "RESOURCE_POOL" || merged[hk]["kind"] != "OPERATOR" {
				add(e.Key, "hook_pool '%s' must be an OPERATOR pool", hk)
			}
		}
		if arche[e.Src] != "STORAGE" && arche[e.Dst] != "STORAGE" {
			adj[e.Src] = append(adj[e.Src], e.Dst)
		}
	}
	for _, n := range g.Nodes {
		if arche[n.Key] != "PROCESS" {
			continue
		}
		recipes, _ := merged[n.Key]["recipes"].([]any)
		if len(recipes) == 0 {
			continue
		}
		r0, _ := recipes[0].(map[string]any)
		inputs, _ := r0["inputs"].([]any)
		for _, raw := range inputs {
			in, _ := raw.(map[string]any)
			m, _ := in["material"].(string)
			if !supplied[n.Key+"|"+m] {
				add(n.Key, "input '%s' has no supplying edge", m)
			}
		}
	}
	if k := findCycle(g.Nodes, adj); k != "" {
		add(k, "cycle without a STORAGE node")
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out
}

// findCycle trả key một node nằm trên chu trình (bỏ qua cạnh chạm STORAGE), hoặc "".
func findCycle(nodes []store.GraphNode, adj map[string][]string) string {
	const (
		white = iota
		grey
		black
	)
	color := map[string]int{}
	var found string
	var visit func(string) bool
	visit = func(u string) bool {
		color[u] = grey
		for _, w := range adj[u] {
			if color[w] == grey {
				found = w
				return true
			}
			if color[w] == white && visit(w) {
				return true
			}
		}
		color[u] = black
		return false
	}
	for _, n := range nodes {
		if color[n.Key] == white && visit(n.Key) {
			return found
		}
	}
	return ""
}
