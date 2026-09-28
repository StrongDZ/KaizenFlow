package db_test

import (
	"context"
	"testing"

	"github.com/kaizenflow/api/internal/db"
	"github.com/kaizenflow/api/internal/testdb"
)

func TestMigrateCreatesSchemaAndIsIdempotent(t *testing.T) {
	pool := testdb.New(t, "db")
	ctx := context.Background()
	tables := []string{"material", "node_type", "model_version", "node", "edge", "data_binding",
		"scenario", "sim_run", "insight", "signal", "event_log", "forecast_band"}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables
		WHERE table_schema='public' AND table_name = ANY($1)`, tables).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != len(tables) {
		t.Fatalf("tables = %d, want %d", n, len(tables))
	}
	var h int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM timescaledb_information.hypertables
		WHERE hypertable_name IN ('signal','event_log','forecast_band')`).Scan(&h); err != nil {
		t.Fatal(err)
	}
	if h != 3 {
		t.Fatalf("hypertables = %d, want 3", h)
	}
	if err := db.Migrate(pool); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
}
