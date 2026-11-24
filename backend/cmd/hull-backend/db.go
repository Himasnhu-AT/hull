package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/marlstudio/hull/backend/internal/config"
	"github.com/marlstudio/hull/backend/internal/store"
)

// openStore opens Postgres when DATABASE_URL is set and SQLite at DATA_DIR/hull.db when it is not. Both apply the
// schema as they open.
func openStore(ctx context.Context, cfg config.Config) (*store.Store, error) {
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil { // community game files live here in both cases
		return nil, err
	}
	if cfg.DatabaseURL != "" {
		return store.OpenPostgres(ctx, cfg.DatabaseURL, cfg.DatabaseSchema)
	}
	return store.Open(filepath.Join(cfg.DataDir, "hull.db"))
}

// runMigrate opens the database, which applies the schema, and says what it found and did. The deploy runs it
// before the server starts, so a bad DATABASE_URL or a missing grant stops the deploy there.
func runMigrate(getenv func(string) string, out io.Writer) error {
	cfg, err := config.Load(getenv)
	if err != nil {
		return err
	}
	st, err := openStore(context.Background(), cfg)
	if err != nil {
		return err
	}
	defer st.Close()
	v, err := st.SchemaVersion()
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "database: %s (%s)\n", st.Kind(), st.Where())
	if c := st.CreatedTables(); len(c) > 0 {
		fmt.Fprintf(out, "created %d tables: %v\n", len(c), c)
	} else {
		fmt.Fprintln(out, "no tables to create: the schema was already in place")
	}
	fmt.Fprintf(out, "schema version: %d (this binary writes %d)\n", v, store.SchemaVersion)
	return nil
}
