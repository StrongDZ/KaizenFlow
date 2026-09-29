package catalog

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Seed chèn/cập nhật node type built-in và material mặc định. Idempotent.
func Seed(ctx context.Context, pool *pgxpool.Pool) error {
	for _, b := range Builtins {
		schema, ok := SchemaFor(b.Archetype)
		if !ok {
			return fmt.Errorf("%s: unknown archetype %s", b.Code, b.Archetype)
		}
		_, err := pool.Exec(ctx, `INSERT INTO node_type
			(code, name, archetype, param_schema, default_params, signals, failure_modes, ui, is_builtin)
			VALUES ($1, $2, $3::archetype, $4, $5, $6, $7, $8, true)
			ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, archetype = EXCLUDED.archetype,
			  param_schema = EXCLUDED.param_schema, default_params = EXCLUDED.default_params,
			  signals = EXCLUDED.signals, failure_modes = EXCLUDED.failure_modes, ui = EXCLUDED.ui
			WHERE node_type.is_builtin`,
			b.Code, b.Name, b.Archetype, schema, json.RawMessage(b.Defaults), json.RawMessage(b.Signals),
			json.RawMessage(b.FailureModes), json.RawMessage(b.UI))
		if err != nil {
			return fmt.Errorf("seed %s: %w", b.Code, err)
		}
	}
	for _, m := range Materials {
		if _, err := pool.Exec(ctx, `INSERT INTO material (code, name) VALUES ($1, $1) ON CONFLICT (code) DO NOTHING`, m); err != nil {
			return fmt.Errorf("seed material %s: %w", m, err)
		}
	}
	return nil
}
