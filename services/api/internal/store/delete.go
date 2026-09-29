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
