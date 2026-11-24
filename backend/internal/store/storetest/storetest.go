// Package storetest opens a throwaway store for tests: SQLite in memory, or, when TEST_DATABASE_URL is set,
// Postgres in a schema of its own that is dropped afterwards. The same suites then run against both.
package storetest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"testing"

	"github.com/marlstudio/hull/backend/internal/store"
)

// Postgres reports whether tests run against Postgres.
func Postgres() bool { return os.Getenv("TEST_DATABASE_URL") != "" }

// Open returns a fresh, empty store that is closed (and its schema dropped) when the test ends.
func Open(t testing.TB) *store.Store {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		st, err := store.Open(":memory:")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { st.Close() })
		return st
	}
	b := make([]byte, 6)
	rand.Read(b)
	schema := "t_" + hex.EncodeToString(b)
	st, err := store.OpenPostgres(context.Background(), url, schema)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := st.DropSchema(schema); err != nil {
			t.Errorf("dropping test schema %s: %v", schema, err)
		}
		st.Close()
	})
	return st
}

// Env returns a getenv for the commands that open the database themselves (DATABASE_URL and DATABASE_SCHEMA set
// to a fresh schema when testing Postgres, nothing otherwise), with extra added on top. The schema is dropped at the end.
func Env(t testing.TB, extra map[string]string) func(string) string {
	t.Helper()
	m := map[string]string{}
	if url := os.Getenv("TEST_DATABASE_URL"); url != "" {
		b := make([]byte, 6)
		rand.Read(b)
		schema := "t_" + hex.EncodeToString(b)
		m["DATABASE_URL"], m["DATABASE_SCHEMA"] = url, schema
		t.Cleanup(func() {
			st, err := store.OpenPostgres(context.Background(), url, schema)
			if err != nil {
				t.Errorf("reopening test schema %s: %v", schema, err)
				return
			}
			defer st.Close()
			if err := st.DropSchema(schema); err != nil {
				t.Errorf("dropping test schema %s: %v", schema, err)
			}
		})
	}
	for k, v := range extra {
		m[k] = v
	}
	return func(k string) string { return m[k] }
}
