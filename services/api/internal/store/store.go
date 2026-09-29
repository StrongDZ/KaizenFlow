// Package store là lớp truy cập Postgres (pgx) cho API.
package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// RefError là lỗi tham chiếu/tham số gắn với key của node/edge/model.
type RefError struct{ Key, Msg string }

func (e *RefError) Error() string { return e.Key + ": " + e.Msg }

var (
	ErrNotFound = errors.New("not found")
	ErrNotDraft = errors.New("model version is not DRAFT")
	ErrBusy     = errors.New("có lần chạy đang chạy trong phạm vi này, đợi chạy xong rồi thử lại")
	ErrChanged  = errors.New("dữ liệu vừa thay đổi, hãy thử lại")
)

// LockedError: object bị khoá (có sẵn, đã Publish, hoặc đang được dùng). Usage nói ai đang dùng.
type LockedError struct {
	Msg   string
	Usage any
}

func (e *LockedError) Error() string { return e.Msg }

// ImpactError: xoá cần xác nhận vì còn dữ liệu phụ thuộc; Impact là số lượng sẽ mất.
type ImpactError struct{ Impact map[string]int }

func (e *ImpactError) Error() string { return "has dependents" }

func isFK(err error) bool {
	var pe *pgconn.PgError
	return errors.As(err, &pe) && pe.Code == "23503"
}

// inTx chạy fn trong một transaction. Vi phạm khoá ngoại (vd. một run vừa được tạo giữa lúc xoá) → ErrChanged.
func (s *Store) inTx(ctx context.Context, fn func(pgx.Tx) error) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := fn(tx); err != nil {
		if isFK(err) {
			return ErrChanged
		}
		return err
	}
	return tx.Commit(ctx)
}

type Store struct{ Pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Store { return &Store{Pool: pool} }

func notFound(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

func isUnique(err error) bool {
	var pe *pgconn.PgError
	return errors.As(err, &pe) && pe.Code == "23505"
}
