// Package testdb tạo một database Postgres mới, đã migrate, cho mỗi test.
package testdb

import (
	"context"
	"net/url"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kaizenflow/api/internal/db"
)

func New(t *testing.T, name string) *pgxpool.Pool {
	t.Helper()
	admin := os.Getenv("KF_TEST_DB")
	if admin == "" {
		admin = "postgres://postgres:kaizen@localhost:5433/postgres?sslmode=disable"
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, admin)
	if err != nil {
		t.Fatalf("test db unreachable (chạy `docker compose up -d db`): %v", err)
	}
	dbname := "kf_test_" + name
	for _, q := range []string{"DROP DATABASE IF EXISTS " + dbname + " WITH (FORCE)", "CREATE DATABASE " + dbname} {
		if _, err := conn.Exec(ctx, q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	_ = conn.Close(ctx)
	u, err := url.Parse(admin)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + dbname
	pool, err := db.Connect(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := db.Migrate(pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return pool
}
