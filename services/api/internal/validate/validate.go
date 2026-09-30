// Package validate kiểm tra đồ thị model trước khi publish (JSON Schema + luật spec §6).
package validate

import (
	"encoding/json"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/kaizenflow/api/internal/store"
)

// Issue là một phát hiện khi kiểm tra. Severity rỗng nghĩa là lỗi (các nơi tạo Issue thủ công không cần điền).
type Issue struct {
	Key      string `json:"key"`
	Message  string `json:"message"`
	Severity string `json:"severity,omitempty"`
	Code     string `json:"code,omitempty"`
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

// defaultsSchema là schema archetype đã bỏ `required` cấp cao nhất: tham số mặc định chỉ là một phần của tham số node
// (node cung cấp phần còn lại lúc ghép), nên các trường bắt buộc như `lots` không được đòi ở mặc định.
func (v *Validator) defaultsSchema(t store.NodeType) (*jsonschema.Schema, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	cacheKey := t.Code + "|defaults|" + string(t.ParamSchema)
	if s, ok := v.cache[cacheKey]; ok {
		return s, nil
	}
	var doc map[string]any
	if err := json.Unmarshal(t.ParamSchema, &doc); err != nil {
		return nil, err
	}
	delete(doc, "required")
	raw, err := json.Marshal(doc)
	if err != nil {
		return nil, err
	}
	parsed, err := jsonschema.UnmarshalJSON(strings.NewReader(string(raw)))
	if err != nil {
		return nil, err
	}
	c := jsonschema.NewCompiler()
	url := "mem://" + t.Code + ".defaults.json"
	if err := c.AddResource(url, parsed); err != nil {
		return nil, err
	}
	s, err := c.Compile(url)
	if err != nil {
		return nil, err
	}
	v.cache[cacheKey] = s
	return s, nil
}

// DefaultParams kiểm tra tham số mặc định của một node type theo schema archetype của nó.
func (v *Validator) DefaultParams(t store.NodeType, params map[string]any) []Issue {
	s, err := v.defaultsSchema(t)
	if err != nil {
		return []Issue{{Key: "default_params", Message: "schema: " + err.Error()}}
	}
	if params == nil {
		params = map[string]any{}
	}
	if err := s.Validate(params); err != nil {
		return []Issue{{Key: "default_params", Message: firstLine(err)}}
	}
	return nil
}

func firstLine(err error) string {
	lines := strings.Split(err.Error(), "\n")
	if len(lines) > 1 {
		return strings.TrimSpace(strings.Join(lines[1:], " "))
	}
	return lines[0]
}

// Graph trả các lỗi (mức error) của đồ thị; dùng khi Publish. Cảnh báo và thông số nội suy nằm ở Check.
func (v *Validator) Graph(g *store.Graph, types map[string]store.NodeType) []Issue {
	var out []Issue
	for _, i := range v.Check(CheckInput{Graph: g, Types: types}).Issues {
		if i.Severity == SevError {
			out = append(out, i)
		}
	}
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
