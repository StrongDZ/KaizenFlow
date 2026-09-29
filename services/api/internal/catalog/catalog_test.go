package catalog_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/kaizenflow/api/internal/catalog"
	"github.com/kaizenflow/api/internal/testdb"
)

func compile(t *testing.T, raw json.RawMessage) *jsonschema.Schema {
	t.Helper()
	doc, err := jsonschema.UnmarshalJSON(strings.NewReader(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	c := jsonschema.NewCompiler()
	if err := c.AddResource("mem://s.json", doc); err != nil {
		t.Fatal(err)
	}
	s, err := c.Compile("mem://s.json")
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestSchemasCompileAndAcceptNonRecipeDefaults(t *testing.T) {
	for _, b := range catalog.Builtins {
		raw, ok := catalog.SchemaFor(b.Archetype)
		if !ok {
			t.Fatalf("%s: no schema for %s", b.Code, b.Archetype)
		}
		s := compile(t, raw)
		var v any
		if err := json.Unmarshal([]byte(b.Defaults), &v); err != nil {
			t.Fatalf("%s defaults: %v", b.Code, err)
		}
		m := v.(map[string]any)
		if b.Archetype == "PROCESS" { // recipe do người dùng đặt ở node
			m["recipes"] = []any{map[string]any{"inputs": []any{}, "outputs": []any{map[string]any{"material": "X", "qty": 1.0}}}}
		}
		if b.Archetype == "SOURCE" {
			m["lots"] = []any{map[string]any{"material": "X", "qty": 1.0}}
		}
		if err := s.Validate(m); err != nil {
			t.Fatalf("%s defaults invalid: %v", b.Code, err)
		}
	}
}

func TestPoolSchemaRejectsBadCount(t *testing.T) {
	raw, _ := catalog.SchemaFor("RESOURCE_POOL")
	if err := compile(t, raw).Validate(map[string]any{"kind": "TUGGER", "count": 0.0}); err == nil {
		t.Fatal("count 0 accepted")
	}
}

func TestSeedIsIdempotent(t *testing.T) {
	pool := testdb.New(t, "catalog")
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		if err := catalog.Seed(ctx, pool); err != nil {
			t.Fatal(err)
		}
	}
	var types, mats int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM node_type WHERE is_builtin`).Scan(&types)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM material`).Scan(&mats)
	if types != len(catalog.Builtins) || mats != len(catalog.Materials) {
		t.Fatalf("types=%d mats=%d", types, mats)
	}
}

func TestDistOptionsHaveTitlesForForms(t *testing.T) {
	raw, _ := catalog.SchemaFor("PROCESS")
	var s struct {
		Defs map[string]struct {
			OneOf []map[string]any `json:"oneOf"`
		} `json:"$defs"`
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatal(err)
	}
	for _, opt := range s.Defs["dist"].OneOf {
		if opt["title"] == nil {
			t.Fatalf("dist option without title (form shows 'Option N'): %v", opt)
		}
	}
}
