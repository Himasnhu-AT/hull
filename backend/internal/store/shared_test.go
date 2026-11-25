package store_test

import (
	"context"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/marlstudio/hull/backend/internal/store"
	"github.com/marlstudio/hull/backend/internal/store/storetest"
)

// Runs on SQLite, or on Postgres when TEST_DATABASE_URL is set: duplicates must read the same on both.
func TestDuplicatesAndWaitlist(t *testing.T) {
	st := storetest.Open(t)
	now := time.Unix(1_700_000_000, 0)
	u, err := st.CreateUser("a@example.com", "h", now)
	if err != nil || u.ID == 0 {
		t.Fatalf("create: %+v %v", u, err)
	}
	if _, err := st.CreateUser("a@example.com", "h", now); err != store.ErrEmailTaken {
		t.Fatalf("dup email: %v", err)
	}
	g, err := st.CreateGoogleUser("g@example.com", "sub1", now)
	if err != nil || g.ID == u.ID {
		t.Fatalf("google: %+v %v", g, err)
	}
	if _, err := st.CreateGoogleUser("h@example.com", "sub1", now); err != store.ErrSubTaken {
		t.Fatalf("dup sub: %v", err)
	}
	if _, err := st.CreateGoogleUser("g@example.com", "sub2", now); err != store.ErrEmailTaken {
		t.Fatalf("dup google email: %v", err)
	}
	if err := st.LinkGoogle(u.ID, "sub1", time.Now()); err != store.ErrSubTaken {
		t.Fatalf("link taken sub: %v", err)
	}
	if err := st.LinkGoogle(u.ID, "sub3", time.Now()); err != nil {
		t.Fatal(err)
	}
	if got, err := st.UserByGoogleSub("sub3"); err != nil || got.ID != u.ID {
		t.Fatalf("by sub: %+v %v", got, err)
	}
	v := store.CommunityVersion{GameID: "g", Version: "1.0.0", Title: "T", PublishedAt: now}
	if err := st.AddCommunityVersion(v); err != nil {
		t.Fatal(err)
	}
	if err := st.AddCommunityVersion(v); err != store.ErrVersionExists {
		t.Fatalf("dup version: %v", err)
	}
	if err := st.CreateToken("th", u.ID, "app", now); err != nil {
		t.Fatal(err)
	}
	if err := st.AddUsage(u.ID, 1, "m", 5, 7, now); err != nil {
		t.Fatal(err)
	}
	if use, err := st.UsageSince(u.ID, now.Add(-time.Hour)); err != nil || use.Input != 5 || use.Output != 7 {
		t.Fatalf("usage: %+v %v", use, err)
	}
	if use, err := st.UsageSince(u.ID, now.Add(time.Hour)); err != nil || use.Input != 0 {
		t.Fatalf("empty usage: %+v %v", use, err)
	}
	if added, err := st.AddWaitlist("w@example.com", "home", now); err != nil || !added {
		t.Fatalf("waitlist add: %v %v", added, err)
	}
	if added, err := st.AddWaitlist("w@example.com", "other", now); err != nil || added {
		t.Fatalf("waitlist dup: %v %v", added, err)
	}
	var seen []string
	st.EachWaitlist(func(e store.WaitlistEntry) error { seen = append(seen, e.Email+"/"+e.Source); return nil })
	if len(seen) != 1 || seen[0] != "w@example.com/home" {
		t.Fatalf("waitlist: %v", seen)
	}
	if v, err := st.SchemaVersion(); err != nil || v != store.SchemaVersion {
		t.Fatalf("schema version %d %v", v, err)
	}
}

// Two processes starting together must not race on the schema, and a second start must change nothing.
func TestPostgresSchemaConcurrentAndRepeatable(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	env := storetest.Env(t, nil) // registers the cleanup that drops the schema
	schema := env("DATABASE_SCHEMA")
	var wg sync.WaitGroup
	errs := make(chan error, 6)
	stores := make(chan *store.Store, 6)
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			st, err := store.OpenPostgres(context.Background(), url, schema)
			errs <- err
			stores <- st
		}()
	}
	wg.Wait()
	close(errs)
	close(stores)
	created := 0
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	for st := range stores {
		if st != nil {
			if len(st.CreatedTables()) > 0 {
				created++
			}
			st.Close()
		}
	}
	if created != 1 {
		t.Errorf("%d of 6 starters created the tables, want exactly 1", created)
	}
}

func TestPostgresErrorsNameTheSettingNotThePassword(t *testing.T) {
	_, err := store.OpenPostgres(context.Background(), "postgres://u:hunter2secret@127.0.0.1:1/db?sslmode=disable&connect_timeout=2", "public")
	if err == nil || !strings.Contains(err.Error(), "DATABASE_URL") || strings.Contains(err.Error(), "hunter2secret") {
		t.Fatalf("unreachable: %v", err)
	}
	_, err = store.OpenPostgres(context.Background(), "postgres://u:hunter2secret@h/db?sslmode=bogus", "public")
	if err == nil || strings.Contains(err.Error(), "hunter2secret") {
		t.Fatalf("bad sslmode: %v", err)
	}
	if _, err := store.OpenPostgres(context.Background(), "postgres://u@h/db", "bad;schema"); err == nil {
		t.Fatal("bad schema accepted")
	}
}
