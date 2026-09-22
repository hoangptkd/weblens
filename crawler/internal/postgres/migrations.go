package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/weblens-project/weblens-crawler/migrations"
)

func Migrate(ctx context.Context, databaseURL string) error {
	configuration, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		return fmt.Errorf("parse PostgreSQL URL: %w", err)
	}
	configuration.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	connection, err := pgx.ConnectConfig(ctx, configuration)
	if err != nil {
		return fmt.Errorf("connect PostgreSQL for migration: %w", err)
	}
	defer connection.Close(ctx)

	entries, err := fs.Glob(migrations.Files, "postgresql/*.sql")
	if err != nil {
		return fmt.Errorf("list PostgreSQL migrations: %w", err)
	}
	sort.Strings(entries)
	for _, path := range entries {
		if err := applyMigration(ctx, connection, path); err != nil {
			return err
		}
	}
	return nil
}

func applyMigration(ctx context.Context, connection *pgx.Conn, path string) error {
	body, err := migrations.Files.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read migration %s: %w", path, err)
	}
	name := path[strings.LastIndex(path, "/")+1:]
	expected := migrationChecksum(body)

	transaction, err := connection.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin migration %s: %w", name, err)
	}
	defer transaction.Rollback(ctx)
	if _, err := transaction.Exec(ctx, `
        CREATE TABLE IF NOT EXISTS crawler_schema_history (
            version text PRIMARY KEY,
            checksum_sha256 text NOT NULL,
            installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
        )`); err != nil {
		return fmt.Errorf("create crawler schema history: %w", err)
	}
	if _, err := transaction.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", int64(8_381_190_041)); err != nil {
		return fmt.Errorf("lock migration runner: %w", err)
	}

	var existing string
	err = transaction.QueryRow(ctx,
		"SELECT checksum_sha256 FROM crawler_schema_history WHERE version = $1", name,
	).Scan(&existing)
	if err == nil {
		if existing != expected {
			return fmt.Errorf("migration checksum mismatch for %s", name)
		}
		return transaction.Commit(ctx)
	}
	if err != pgx.ErrNoRows {
		return fmt.Errorf("read migration history for %s: %w", name, err)
	}
	if _, err := transaction.Exec(ctx, string(body)); err != nil {
		return fmt.Errorf("apply migration %s: %w", name, err)
	}
	if _, err := transaction.Exec(ctx,
		"INSERT INTO crawler_schema_history(version, checksum_sha256) VALUES ($1, $2)", name, expected,
	); err != nil {
		return fmt.Errorf("record migration %s: %w", name, err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return fmt.Errorf("commit migration %s: %w", name, err)
	}
	return nil
}

func migrationChecksum(body []byte) string {
	normalized := bytes.ReplaceAll(body, []byte("\r\n"), []byte("\n"))
	checksum := sha256.Sum256(normalized)
	return hex.EncodeToString(checksum[:])
}
