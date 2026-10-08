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

func TestPoolSchemaAcceptsEveryVehicleKind(t *testing.T) {
	raw, _ := catalog.SchemaFor("RESOURCE_POOL")
	sc := compile(t, raw)
	for _, kind := range []string{"AGV", "AMR", "TUGGER", "FORKLIFT", "OPERATOR"} {
		if err := sc.Validate(map[string]any{"kind": kind, "count": 2.0}); err != nil {
			t.Errorf("kind %s rejected: %v", kind, err)
		}
	}
	if err := sc.Validate(map[string]any{"kind": "DRONE", "count": 2.0}); err == nil {
		t.Error("unknown kind accepted")
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

// Bộ mẫu chỉ được nạp lúc bảng còn trống. Sau đó là dữ liệu của người dùng: không bị nạp đè khi API khởi động lại,
// và loại nào đã xoá thì không tự sống lại.
func TestSeedNeverOverwritesOrRestoresUserData(t *testing.T) {
	pool := testdb.New(t, "catalog_user_data")
	ctx := context.Background()
	if err := catalog.Seed(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE node_type SET name = 'Tên của tôi', default_params = '{"mine":true}' WHERE code = 'STAMP_PRESS'`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM node_type WHERE code = 'SCRAP'`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM material WHERE code = 'BOX'`); err != nil {
		t.Fatal(err)
	}
	if err := catalog.Seed(ctx, pool); err != nil { // API khởi động lại
		t.Fatal(err)
	}
	var name, defaults string
	if err := pool.QueryRow(ctx, `SELECT name, default_params::text FROM node_type WHERE code = 'STAMP_PRESS'`).Scan(&name, &defaults); err != nil {
		t.Fatal(err)
	}
	if name != "Tên của tôi" || !strings.Contains(defaults, "mine") {
		t.Fatalf("edit overwritten: name=%q defaults=%s", name, defaults)
	}
	var scrap, box int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM node_type WHERE code = 'SCRAP'`).Scan(&scrap)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM material WHERE code = 'BOX'`).Scan(&box)
	if scrap != 0 || box != 0 {
		t.Fatalf("deleted rows came back: node_type SCRAP=%d material BOX=%d", scrap, box)
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
