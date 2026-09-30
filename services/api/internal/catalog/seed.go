package catalog

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Seed nạp bộ mẫu ban đầu (node type và vật tư mặc định) vào bảng còn trống. Từ đó chúng là dữ liệu của người dùng: sửa,
// xoá tuỳ ý (theo luật khoá chung), không bao giờ bị nạp đè khi API khởi động lại, và loại nào đã xoá thì không tự sống lại.
// Cột is_builtin chỉ ghi nhận "nạp từ bộ mẫu", không còn khoá gì. Idempotent.
func Seed(ctx context.Context, pool *pgxpool.Pool) error {
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM node_type`).Scan(&n); err != nil {
		return fmt.Errorf("count node_type: %w", err)
	}
	if n == 0 {
		for _, b := range Builtins {
			schema, ok := SchemaFor(b.Archetype)
			if !ok {
				return fmt.Errorf("%s: unknown archetype %s", b.Code, b.Archetype)
			}
			_, err := pool.Exec(ctx, `INSERT INTO node_type
				(code, name, archetype, param_schema, default_params, signals, failure_modes, ui, is_builtin)
				VALUES ($1, $2, $3::archetype, $4, $5, $6, $7, $8, true)
				ON CONFLICT (code) DO NOTHING`,
				b.Code, b.Name, b.Archetype, schema, json.RawMessage(b.Defaults), json.RawMessage(b.Signals),
				json.RawMessage(b.FailureModes), json.RawMessage(b.UI))
			if err != nil {
				return fmt.Errorf("seed %s: %w", b.Code, err)
			}
		}
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM material`).Scan(&n); err != nil {
		return fmt.Errorf("count material: %w", err)
	}
	if n == 0 {
		for _, m := range Materials {
			if _, err := pool.Exec(ctx, `INSERT INTO material (code, name) VALUES ($1, $1) ON CONFLICT (code) DO NOTHING`, m); err != nil {
				return fmt.Errorf("seed material %s: %w", m, err)
			}
		}
	}
	return nil
}
