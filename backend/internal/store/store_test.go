package store

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"
)

// An account database made before Google sign-in must open, keep its users and accept Google accounts.
func TestMigrateAddsGoogleSub(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	old, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
		INSERT INTO users(email,password_hash,created_at) VALUES('old@example.com','h',1),('old2@example.com','h',1)`); err != nil {
		t.Fatal(err)
	}
	old.Close()

	for i := 0; i < 2; i++ { // the second open proves the migration is repeatable
		st, err := Open(path)
		if err != nil {
			t.Fatal(err)
		}
		u, err := st.UserByEmail("old@example.com")
		// Linking to Google (below, on the first pass) drops the password, so the second pass finds none.
		if err != nil || (i == 0 && (u.PassHash != "h" || u.GoogleSub != "")) || (i == 1 && (u.PassHash != "" || u.GoogleSub != "other")) {
			t.Fatalf("old user: %+v %v", u, err)
		}
		if i == 0 {
			if _, err := st.CreateGoogleUser("g@gmail.com", "sub", time.Now()); err != nil {
				t.Fatal(err)
			}
			if err := st.LinkGoogle(u.ID, "sub", time.Now()); err != ErrSubTaken {
				t.Fatalf("duplicate sub: %v", err)
			}
			if err := st.LinkGoogle(u.ID, "other", time.Now()); err != nil {
				t.Fatal(err)
			}
		}
		st.Close()
	}
}
