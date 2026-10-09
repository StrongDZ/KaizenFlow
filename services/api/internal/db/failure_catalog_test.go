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

func TestFailureCatalogMigrationExtendsExistingBuiltinsWithoutChangingSignals(t *testing.T) {
	pool := testdb.New(t, "db_failure_catalog")
	ctx := context.Background()
	sqlDB := stdlib.OpenDBFromPool(pool)
	defer sqlDB.Close()
	goose.SetBaseFS(migrations.FS)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(sqlDB, ".", 6); err != nil {
		t.Fatal(err)
	}

	const vibration = `[{"name":"vibration","unit":"mm/s"}]`
	const bearing = `[{"code":"bearing_wear","onset":{"dist":"const","value":100},"p_to_f":{"dist":"const","value":10},"effects":[],"on_fail":{"mttr":{"dist":"const","value":20}}}]`
	for _, row := range []struct{ code, signals, modes string }{
		{"STAMP_PRESS", vibration, bearing},
		{"ASSEMBLY_CELL", `[]`, `[]`},
	} {
		if _, err := pool.Exec(ctx, `INSERT INTO node_type
			(code, name, archetype, param_schema, signals, failure_modes, is_builtin)
			VALUES ($1, $1, 'PROCESS', '{}', $2::jsonb, $3::jsonb, true)`, row.code, row.signals, row.modes); err != nil {
			t.Fatal(err)
		}
	}
	if err := goose.UpTo(sqlDB, ".", 7); err != nil {
		t.Fatal(err)
	}

	var signals, modes []byte
	if err := pool.QueryRow(ctx, `SELECT signals, failure_modes FROM node_type WHERE code = 'STAMP_PRESS'`).Scan(&signals, &modes); err != nil {
		t.Fatal(err)
	}
	var signalRows, modeRows []map[string]any
	if err := json.Unmarshal(signals, &signalRows); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(modes, &modeRows); err != nil {
		t.Fatal(err)
	}
	if len(signalRows) != 1 || signalRows[0]["name"] != "vibration" {
		t.Fatalf("signals changed by failure migration: %s", signals)
	}
	if len(modeRows) != 4 {
		t.Fatalf("STAMP_PRESS modes = %s", modes)
	}
	seen := map[string]map[string]any{}
	for _, mode := range modeRows {
		seen[mode["code"].(string)] = mode
	}
	bearingMode, ok := seen["bearing_wear"]
	if !ok || bearingMode["injection_only"] != nil || bearingMode["label"] != "Mòn vòng bi" {
		t.Fatalf("legacy bearing mode changed incorrectly: %+v", bearingMode)
	}
	for _, code := range []string{"die_jam", "hydraulic_pressure_loss", "motor_overheat"} {
		mode, ok := seen[code]
		if !ok || mode["injection_only"] != true {
			t.Fatalf("%s is not injection-only: %+v", code, mode)
		}
	}

	var assemblyCount int
	if err := pool.QueryRow(ctx, `SELECT jsonb_array_length(failure_modes) FROM node_type WHERE code = 'ASSEMBLY_CELL'`).Scan(&assemblyCount); err != nil {
		t.Fatal(err)
	}
	if assemblyCount != 3 {
		t.Fatalf("ASSEMBLY_CELL modes = %d", assemblyCount)
	}
}
