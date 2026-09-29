package store

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// deleteRuns xoá các run và mọi dòng gắn với chúng. signal, event_log và forecast_band không có khoá ngoại
// tới run nên phải xoá tay; forecast_band còn chứa dự báo của Predict (producer khác) nên bắt buộc lọc producer = 'SIM'.
func deleteRuns(ctx context.Context, tx pgx.Tx, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	for _, q := range []string{
		`DELETE FROM insight WHERE sim_run_id = ANY($1)`,
		`DELETE FROM signal WHERE run_id = ANY($1)`,
		`DELETE FROM event_log WHERE run_id = ANY($1)`,
		`DELETE FROM forecast_band WHERE producer = 'SIM' AND ref_id = ANY($1)`,
		`DELETE FROM sim_run WHERE id = ANY($1)`,
	} {
		if _, err := tx.Exec(ctx, q, ids); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) DeleteRun(ctx context.Context, id int64) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		var status string
		if err := tx.QueryRow(ctx, `SELECT status FROM sim_run WHERE id = $1 FOR UPDATE`, id).Scan(&status); err != nil {
			return notFound(err)
		}
		if status == "QUEUED" || status == "RUNNING" {
			return ErrBusy
		}
		return deleteRuns(ctx, tx, []int64{id})
	})
}

// scope là cây scenario (kể cả con qua parent_id) và mọi run của chúng.
type scope struct{ scenarios, runs []int64 }

// collectScope trả phạm vi của các scenario gốc và số run đang QUEUED/RUNNING trong đó.
func collectScope(ctx context.Context, tx pgx.Tx, roots []int64) (scope, int, error) {
	if roots == nil {
		roots = []int64{}
	}
	rows, err := tx.Query(ctx, `WITH RECURSIVE tree AS (
			SELECT id FROM scenario WHERE id = ANY($1)
			UNION
			SELECT s.id FROM scenario s JOIN tree t ON s.parent_id = t.id
		) SELECT id FROM tree`, roots)
	if err != nil {
		return scope{}, 0, err
	}
	sc := scope{}
	if sc.scenarios, err = pgx.CollectRows(rows, pgx.RowTo[int64]); err != nil {
		return scope{}, 0, err
	}
	rows, err = tx.Query(ctx, `SELECT id, status FROM sim_run WHERE scenario_id = ANY($1)`, sc.scenarios)
	if err != nil {
		return scope{}, 0, err
	}
	busy := 0
	for rows.Next() {
		var id int64
		var status string
		if err := rows.Scan(&id, &status); err != nil {
			return scope{}, 0, err
		}
		sc.runs = append(sc.runs, id)
		if status == "QUEUED" || status == "RUNNING" {
			busy++
		}
	}
	rows.Close()
	return sc, busy, rows.Err()
}

// removeScope xoá run trước, rồi toàn bộ scenario trong một câu lệnh (khoá ngoại parent_id được kiểm sau câu lệnh).
func removeScope(ctx context.Context, tx pgx.Tx, sc scope) error {
	if err := deleteRuns(ctx, tx, sc.runs); err != nil {
		return err
	}
	if len(sc.scenarios) == 0 {
		return nil
	}
	_, err := tx.Exec(ctx, `DELETE FROM scenario WHERE id = ANY($1)`, sc.scenarios)
	return err
}

func dropZero(m map[string]int) map[string]int {
	for k, v := range m {
		if v <= 0 {
			delete(m, k)
		}
	}
	return m
}

func (s *Store) DeleteScenario(ctx context.Context, id int64, cascade bool) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		var versionID int64
		if err := tx.QueryRow(ctx, `SELECT model_version_id FROM scenario WHERE id = $1`, id).Scan(&versionID); err != nil {
			return notFound(err)
		}
		if _, err := tx.Exec(ctx, `SELECT 1 FROM model_version WHERE id = $1 FOR UPDATE`, versionID); err != nil {
			return err
		}
		sc, busy, err := collectScope(ctx, tx, []int64{id})
		if err != nil {
			return err
		}
		if busy > 0 {
			return ErrBusy
		}
		impact := dropZero(map[string]int{"scenarios": len(sc.scenarios) - 1, "runs": len(sc.runs)})
		if len(impact) > 0 && !cascade {
			return &ImpactError{Impact: impact}
		}
		return removeScope(ctx, tx, sc)
	})
}

// deleteVersions xoá các version và mọi thứ dưới chúng. model bật khi gọi từ DeleteModel (đếm thêm "versions").
func deleteVersions(ctx context.Context, tx pgx.Tx, ids []int64, cascade, model bool) error {
	rows, err := tx.Query(ctx, `SELECT id FROM scenario WHERE model_version_id = ANY($1)`, ids)
	if err != nil {
		return err
	}
	roots, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return err
	}
	sc, busy, err := collectScope(ctx, tx, roots)
	if err != nil {
		return err
	}
	if busy > 0 {
		return ErrBusy
	}
	impact := map[string]int{"scenarios": len(sc.scenarios), "runs": len(sc.runs)}
	if model && len(ids) > 1 {
		impact["versions"] = len(ids)
	}
	if impact = dropZero(impact); len(impact) > 0 && !cascade {
		return &ImpactError{Impact: impact}
	}
	if err := removeScope(ctx, tx, sc); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `DELETE FROM model_version WHERE id = ANY($1)`, ids)
	return err
}

func (s *Store) DeleteVersion(ctx context.Context, id int64, cascade bool) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		var locked int64
		if err := tx.QueryRow(ctx, `SELECT id FROM model_version WHERE id = $1 FOR UPDATE`, id).Scan(&locked); err != nil {
			return notFound(err)
		}
		return deleteVersions(ctx, tx, []int64{id}, cascade, false)
	})
}

func (s *Store) DeleteModel(ctx context.Context, key string, cascade bool) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT id FROM model_version WHERE model_key = $1 ORDER BY id FOR UPDATE`, key)
		if err != nil {
			return err
		}
		ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
		if err != nil {
			return err
		}
		if len(ids) == 0 {
			return ErrNotFound
		}
		return deleteVersions(ctx, tx, ids, cascade, true)
	})
}
