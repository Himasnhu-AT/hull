// Package store keeps accounts, sessions, sign-in codes, app tokens and usage in SQLite.
// Secrets (session ids, codes, tokens) are stored only as SHA-256 hashes the caller computes.
package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite" // pure-Go driver, keeps the binary a single static file
)

var (
	ErrNotFound   = errors.New("not found")
	ErrEmailTaken = errors.New("email already registered")
)

type Store struct{ db *sql.DB }

type User struct {
	ID        int64
	Email     string
	PassHash  string
	CreatedAt time.Time
}

type Token struct {
	ID         int64
	Name       string
	CreatedAt  time.Time
	LastUsedAt time.Time // zero when never used
}

type Code struct {
	UserID        int64
	ClientID      string
	RedirectURI   string
	CodeChallenge string
	ExpiresAt     time.Time
}

type Usage struct{ Input, Output int64 }

const schema = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS auth_codes(
  hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tokens(
  id INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS usage(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_id INTEGER,
  model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS usage_user_time ON usage(user_id, created_at);
`

// Open opens (and migrates) the database at path; ":memory:" gives a throwaway one for tests.
func Open(path string) (*Store, error) {
	dsn := "file:" + path + "?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)"
	if path == ":memory:" {
		dsn = "file::memory:?_pragma=foreign_keys(1)"
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("store: opening %s: %w", path, err)
	}
	// One connection keeps writes serial and makes :memory: a single database. Traffic here is small.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("store: migrating %s: %w", path, err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func ts(t time.Time) int64 { return t.Unix() }

func (s *Store) CreateUser(email, passHash string, now time.Time) (User, error) {
	res, err := s.db.Exec("INSERT INTO users(email,password_hash,created_at) VALUES(?,?,?)", email, passHash, ts(now))
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return User{}, ErrEmailTaken
		}
		return User{}, fmt.Errorf("store: creating user: %w", err)
	}
	id, _ := res.LastInsertId()
	return User{ID: id, Email: email, PassHash: passHash, CreatedAt: time.Unix(ts(now), 0)}, nil
}

func scanUser(row *sql.Row) (User, error) {
	var u User
	var created int64
	err := row.Scan(&u.ID, &u.Email, &u.PassHash, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("store: reading user: %w", err)
	}
	u.CreatedAt = time.Unix(created, 0).UTC()
	return u, nil
}

func (s *Store) UserByEmail(email string) (User, error) {
	return scanUser(s.db.QueryRow("SELECT id,email,password_hash,created_at FROM users WHERE email=?", email))
}

func (s *Store) UserByID(id int64) (User, error) {
	return scanUser(s.db.QueryRow("SELECT id,email,password_hash,created_at FROM users WHERE id=?", id))
}

func (s *Store) CreateSession(hash string, userID int64, expires time.Time) error {
	_, err := s.db.Exec("INSERT INTO sessions(hash,user_id,expires_at) VALUES(?,?,?)", hash, userID, ts(expires))
	return err
}

func (s *Store) SessionUser(hash string, now time.Time) (User, error) {
	return scanUser(s.db.QueryRow(`SELECT u.id,u.email,u.password_hash,u.created_at FROM sessions s
		JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires_at>?`, hash, ts(now)))
}

func (s *Store) DeleteSession(hash string) error {
	_, err := s.db.Exec("DELETE FROM sessions WHERE hash=?", hash)
	return err
}

func (s *Store) CreateCode(hash string, c Code) error {
	_, err := s.db.Exec("INSERT INTO auth_codes(hash,user_id,client_id,redirect_uri,code_challenge,expires_at) VALUES(?,?,?,?,?,?)",
		hash, c.UserID, c.ClientID, c.RedirectURI, c.CodeChallenge, ts(c.ExpiresAt))
	return err
}

// ConsumeCode deletes the code and returns it, so a code works once even when the caller then rejects it.
func (s *Store) ConsumeCode(hash string) (Code, error) {
	var c Code
	var exp int64
	err := s.db.QueryRow("DELETE FROM auth_codes WHERE hash=? RETURNING user_id,client_id,redirect_uri,code_challenge,expires_at", hash).
		Scan(&c.UserID, &c.ClientID, &c.RedirectURI, &c.CodeChallenge, &exp)
	if errors.Is(err, sql.ErrNoRows) {
		return Code{}, ErrNotFound
	}
	if err != nil {
		return Code{}, fmt.Errorf("store: consuming code: %w", err)
	}
	c.ExpiresAt = time.Unix(exp, 0)
	return c, nil
}

func (s *Store) CreateToken(hash string, userID int64, name string, now time.Time) error {
	_, err := s.db.Exec("INSERT INTO tokens(hash,user_id,name,created_at) VALUES(?,?,?,?)", hash, userID, name, ts(now))
	return err
}

// TokenUser finds the owner of a live token and stamps its last use.
func (s *Store) TokenUser(hash string, now time.Time) (User, int64, error) {
	var id int64
	if err := s.db.QueryRow("SELECT id FROM tokens WHERE hash=? AND revoked_at IS NULL", hash).Scan(&id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return User{}, 0, ErrNotFound
		}
		return User{}, 0, fmt.Errorf("store: reading token: %w", err)
	}
	u, err := scanUser(s.db.QueryRow(`SELECT u.id,u.email,u.password_hash,u.created_at FROM tokens t
		JOIN users u ON u.id=t.user_id WHERE t.id=?`, id))
	if err != nil {
		return User{}, 0, err
	}
	s.db.Exec("UPDATE tokens SET last_used_at=? WHERE id=?", ts(now), id)
	return u, id, nil
}

func (s *Store) RevokeTokenByHash(hash string, now time.Time) error {
	_, err := s.db.Exec("UPDATE tokens SET revoked_at=? WHERE hash=? AND revoked_at IS NULL", ts(now), hash)
	return err
}

// RevokeToken revokes one of the user's own tokens; another user's id is ErrNotFound.
func (s *Store) RevokeToken(userID, tokenID int64, now time.Time) error {
	res, err := s.db.Exec("UPDATE tokens SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL", ts(now), tokenID, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) ListTokens(userID int64) ([]Token, error) {
	rows, err := s.db.Query("SELECT id,name,created_at,last_used_at FROM tokens WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at DESC,id DESC", userID)
	if err != nil {
		return nil, fmt.Errorf("store: listing tokens: %w", err)
	}
	defer rows.Close()
	var out []Token
	for rows.Next() {
		var t Token
		var created int64
		var last sql.NullInt64
		if err := rows.Scan(&t.ID, &t.Name, &created, &last); err != nil {
			return nil, err
		}
		t.CreatedAt = time.Unix(created, 0).UTC()
		if last.Valid {
			t.LastUsedAt = time.Unix(last.Int64, 0).UTC()
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) AddUsage(userID, tokenID int64, model string, in, out int64, now time.Time) error {
	_, err := s.db.Exec("INSERT INTO usage(user_id,token_id,model,input_tokens,output_tokens,created_at) VALUES(?,?,?,?,?,?)",
		userID, tokenID, model, in, out, ts(now))
	return err
}

func (s *Store) UsageSince(userID int64, since time.Time) (Usage, error) {
	var u Usage
	err := s.db.QueryRow("SELECT COALESCE(SUM(input_tokens),0),COALESCE(SUM(output_tokens),0) FROM usage WHERE user_id=? AND created_at>=?",
		userID, ts(since)).Scan(&u.Input, &u.Output)
	return u, err
}

// Purge drops expired sessions and codes.
func (s *Store) Purge(now time.Time) error {
	if _, err := s.db.Exec("DELETE FROM sessions WHERE expires_at<=?", ts(now)); err != nil {
		return err
	}
	_, err := s.db.Exec("DELETE FROM auth_codes WHERE expires_at<=?", ts(now))
	return err
}
