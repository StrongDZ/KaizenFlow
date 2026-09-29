// Package store là lớp truy cập Postgres (pgx) cho API.
package store

import (
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrNotFound = errors.New("not found")
	ErrNotDraft = errors.New("model version is not DRAFT")
)

// RefError là lỗi tham chiếu/tham số gắn với key của node/edge/model.
type RefError struct{ Key, Msg string }

func (e *RefError) Error() string { return e.Key + ": " + e.Msg }

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
