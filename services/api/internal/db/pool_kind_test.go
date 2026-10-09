package db_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/kaizenflow/api/internal/testdb"
	"github.com/kaizenflow/api/migrations"
)

// DB đã có từ trước lưu schema tham số của loại node: migration phải thêm AMR vào danh sách `kind` của pool mà không đụng loại node khác.
func TestPoolKindMigrationAddsAMRToStoredNodeTypeSchemas(t *testing.T) {
	pool := testdb.New(t, "db_poolkind")
	ctx := context.Background()
	const oldPool = `{"type":"object","properties":{"kind":{"enum":["AGV","TUGGER","FORKLIFT","OPERATOR"]},"count":{"type":"integer"}}}`
	const other = `{"type":"object","properties":{"kind":{"enum":["A","B"]}}}`
	for _, r := range [][3]string{{"POOL_OLD", "RESOURCE_POOL", oldPool}, {"POOL_NO_KIND", "RESOURCE_POOL", `{"type":"object"}`}, {"STORE_X", "STORAGE", other}} {
		if _, err := pool.Exec(ctx, `INSERT INTO node_type (code, name, archetype, param_schema) VALUES ($1, $1, $2::archetype, $3::jsonb)`, r[0], r[1], r[2]); err != nil {
			t.Fatal(err)
		}
	}
	sqlDB := stdlib.OpenDBFromPool(pool)
	defer sqlDB.Close()
	goose.SetBaseFS(migrations.FS)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(sqlDB, ".", 5); err != nil { // lùi đúng migration AMR, không phụ thuộc migration nào được thêm sau này
		t.Fatal(err)
	}
	if err := goose.UpTo(sqlDB, ".", 6); err != nil {
		t.Fatal(err)
	}
	enum := func(code string) []string {
		var raw []byte
		if err := pool.QueryRow(ctx, `SELECT param_schema #> '{properties,kind,enum}' FROM node_type WHERE code = $1`, code).Scan(&raw); err != nil {
			t.Fatal(err)
		}
		var out []string
		_ = json.Unmarshal(raw, &out)
		return out
	}
	if got := enum("POOL_OLD"); len(got) != 5 || got[1] != "AMR" {
		t.Errorf("pool kinds = %v", got)
	}
	if got := enum("POOL_NO_KIND"); got != nil {
		t.Errorf("a pool schema without kind must stay without kind: %v", got)
	}
	if got := enum("STORE_X"); len(got) != 2 || got[0] != "A" {
		t.Errorf("other archetypes must be untouched: %v", got)
	}
}
