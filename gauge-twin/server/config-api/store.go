package main

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotFound is returned for an unknown machine.
var ErrNotFound = errors.New("station not found")

// Stored is a station config as kept in the database.
type Stored struct {
	MachineID        string
	ConfigVersion    uint32
	PublishedVersion uint32
	Config           []byte // JSON, with config_version set
	UpdatedAt        time.Time
}

// Store persists station configs.
type Store interface {
	// Put stores the config and assigns the next version; the stored JSON
	// carries that version.
	Put(ctx context.Context, machineID, plant, line string, config []byte) (Stored, error)
	Get(ctx context.Context, machineID string) (Stored, error)
	List(ctx context.Context) ([]Stored, error)
	Delete(ctx context.Context, machineID string) error
	// Unpublished lists configs whose current version is not confirmed on MQTT.
	Unpublished(ctx context.Context) ([]Stored, error)
	// MarkPublished records a published version; it never moves backwards.
	MarkPublished(ctx context.Context, machineID string, version uint32) error
	Ping(ctx context.Context) error
}

// PgStore is the PostgreSQL implementation.
type PgStore struct{ pool *pgxpool.Pool }

func NewPgStore(pool *pgxpool.Pool) *PgStore { return &PgStore{pool: pool} }

const columns = `machine_id, config_version, published_version, config::text, updated_at`

func scan(row pgx.Row) (Stored, error) {
	var s Stored
	var config string
	err := row.Scan(&s.MachineID, &s.ConfigVersion, &s.PublishedVersion, &config, &s.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Stored{}, ErrNotFound
	}
	s.Config = []byte(config)
	return s, err
}

func (p *PgStore) Put(ctx context.Context, machineID, plant, line string, config []byte) (Stored, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return Stored{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
		INSERT INTO machine (machine_id, plant, line) VALUES ($1, $2, $3)
		ON CONFLICT (machine_id) DO UPDATE SET plant = EXCLUDED.plant, line = EXCLUDED.line, updated_at = now()`,
		machineID, plant, line); err != nil {
		return Stored{}, err
	}
	// The version is incremented by the database in one statement, so two
	// replicas updating the same station cannot hand out the same version.
	stored, err := scan(tx.QueryRow(ctx, `
		INSERT INTO station_config AS sc (machine_id, config_version, config)
		VALUES ($1, 1, jsonb_set($2::jsonb, '{config_version}', '1'))
		ON CONFLICT (machine_id) DO UPDATE SET
		  config_version = sc.config_version + 1,
		  config = jsonb_set($2::jsonb, '{config_version}', to_jsonb(sc.config_version + 1)),
		  updated_at = now()
		RETURNING `+columns, machineID, string(config)))
	if err != nil {
		return Stored{}, err
	}
	return stored, tx.Commit(ctx)
}

func (p *PgStore) Get(ctx context.Context, machineID string) (Stored, error) {
	return scan(p.pool.QueryRow(ctx, `SELECT `+columns+` FROM station_config WHERE machine_id = $1`, machineID))
}

func (p *PgStore) list(ctx context.Context, where string) ([]Stored, error) {
	rows, err := p.pool.Query(ctx, `SELECT `+columns+` FROM station_config `+where+` ORDER BY machine_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Stored
	for rows.Next() {
		s, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (p *PgStore) List(ctx context.Context) ([]Stored, error) { return p.list(ctx, "") }

func (p *PgStore) Unpublished(ctx context.Context) ([]Stored, error) {
	return p.list(ctx, "WHERE published_version < config_version")
}

func (p *PgStore) Delete(ctx context.Context, machineID string) error {
	tag, err := p.pool.Exec(ctx, `DELETE FROM station_config WHERE machine_id = $1`, machineID)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

func (p *PgStore) MarkPublished(ctx context.Context, machineID string, version uint32) error {
	_, err := p.pool.Exec(ctx, `
		UPDATE station_config SET published_version = $2
		WHERE machine_id = $1 AND published_version < $2 AND config_version >= $2`, machineID, version)
	return err
}

func (p *PgStore) Ping(ctx context.Context) error { return p.pool.Ping(ctx) }
