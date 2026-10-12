// Package db mở kết nối Postgres và chạy migration.
package db

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/kaizenflow/api/migrations"
)

func Connect(ctx context.Context, url string) (*pgxpool.Pool, error) {
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return pool, nil
}

func Migrate(pool *pgxpool.Pool) error {
	return withGoose(pool, func(sqlDB *sql.DB) error { return goose.Up(sqlDB, ".") })
}

// MigrateDown lùi n migration. Chỉ dùng để kiểm tra các khối Down còn chạy được (không có đường nào
// trong app gọi nó): một khối Down hỏng chỉ lộ ra đúng lúc cần lùi, nên phải có test giữ.
func MigrateDown(pool *pgxpool.Pool, n int) error {
	return withGoose(pool, func(sqlDB *sql.DB) error {
		for i := 0; i < n; i++ {
			if err := goose.Down(sqlDB, "."); err != nil {
				return err
			}
		}
		return nil
	})
}

func withGoose(pool *pgxpool.Pool, fn func(*sql.DB) error) error {
	sqlDB := stdlib.OpenDBFromPool(pool)
	defer sqlDB.Close()
	goose.SetBaseFS(migrations.FS)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	return fn(sqlDB)
}
