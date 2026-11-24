// Package store keeps accounts, sessions, sign-in codes, app tokens, usage, the waitlist and the community catalog
// in SQLite (local development) or Postgres (production).
// Secrets (session ids, codes, tokens) are stored only as SHA-256 hashes the caller computes.
package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

type User struct {
	ID        int64
	Email     string
	PassHash  string // empty for an account that signed up with Google and has no password
	GoogleSub string // empty when the account is not linked to Google
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

func ts(t time.Time) int64 { return t.Unix() }

func (s *Store) CreateUser(email, passHash string, now time.Time) (User, error) {
	var id int64
	err := s.queryRow("INSERT INTO users(email,password_hash,created_at) VALUES(?,?,?) RETURNING id", email, passHash, ts(now)).Scan(&id)
	if err != nil {
		if _, dup := uniqueViolation(err); dup {
			return User{}, ErrEmailTaken
		}
		return User{}, fmt.Errorf("store: creating user: %w", err)
	}
	return User{ID: id, Email: email, PassHash: passHash, CreatedAt: time.Unix(ts(now), 0)}, nil
}

// CreateGoogleUser makes an account that has no password, linked to a Google subject.
func (s *Store) CreateGoogleUser(email, sub string, now time.Time) (User, error) {
	var id int64
	err := s.queryRow("INSERT INTO users(email,password_hash,google_sub,created_at) VALUES(?,?,?,?) RETURNING id", email, "", sub, ts(now)).Scan(&id)
	if err != nil {
		if c, dup := uniqueViolation(err); dup {
			if strings.Contains(c, "google_sub") {
				return User{}, ErrSubTaken
			}
			return User{}, ErrEmailTaken
		}
		return User{}, fmt.Errorf("store: creating google user: %w", err)
	}
	return User{ID: id, Email: email, GoogleSub: sub, CreatedAt: time.Unix(ts(now), 0)}, nil
}

// LinkGoogle ties an existing account to a Google subject.
func (s *Store) LinkGoogle(userID int64, sub string) error {
	_, err := s.exec("UPDATE users SET google_sub=? WHERE id=?", sub, userID)
	if _, dup := uniqueViolation(err); dup {
		return ErrSubTaken
	}
	return err
}

func (s *Store) UserByGoogleSub(sub string) (User, error) {
	return scanUser(s.queryRow("SELECT id,email,password_hash,created_at,COALESCE(google_sub,'') FROM users WHERE google_sub=?", sub))
}

func scanUser(row *sql.Row) (User, error) {
	var u User
	var created int64
	err := row.Scan(&u.ID, &u.Email, &u.PassHash, &created, &u.GoogleSub)
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
	return scanUser(s.queryRow("SELECT id,email,password_hash,created_at,COALESCE(google_sub,'') FROM users WHERE email=?", email))
}

func (s *Store) UserByID(id int64) (User, error) {
	return scanUser(s.queryRow("SELECT id,email,password_hash,created_at,COALESCE(google_sub,'') FROM users WHERE id=?", id))
}

func (s *Store) CreateSession(hash string, userID int64, expires time.Time) error {
	_, err := s.exec("INSERT INTO sessions(hash,user_id,expires_at) VALUES(?,?,?)", hash, userID, ts(expires))
	return err
}

func (s *Store) SessionUser(hash string, now time.Time) (User, error) {
	return scanUser(s.queryRow(`SELECT u.id,u.email,u.password_hash,u.created_at,COALESCE(u.google_sub,'') FROM sessions s
		JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires_at>?`, hash, ts(now)))
}

func (s *Store) DeleteSession(hash string) error {
	_, err := s.exec("DELETE FROM sessions WHERE hash=?", hash)
	return err
}

func (s *Store) CreateCode(hash string, c Code) error {
	_, err := s.exec("INSERT INTO auth_codes(hash,user_id,client_id,redirect_uri,code_challenge,expires_at) VALUES(?,?,?,?,?,?)",
		hash, c.UserID, c.ClientID, c.RedirectURI, c.CodeChallenge, ts(c.ExpiresAt))
	return err
}

// ConsumeCode deletes the code and returns it, so a code works once even when the caller then rejects it.
func (s *Store) ConsumeCode(hash string) (Code, error) {
	var c Code
	var exp int64
	err := s.queryRow("DELETE FROM auth_codes WHERE hash=? RETURNING user_id,client_id,redirect_uri,code_challenge,expires_at", hash).
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
	_, err := s.exec("INSERT INTO tokens(hash,user_id,name,created_at) VALUES(?,?,?,?)", hash, userID, name, ts(now))
	return err
}

// TokenUser finds the owner of a live token and stamps its last use.
func (s *Store) TokenUser(hash string, now time.Time) (User, int64, error) {
	var id int64
	if err := s.queryRow("SELECT id FROM tokens WHERE hash=? AND revoked_at IS NULL", hash).Scan(&id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return User{}, 0, ErrNotFound
		}
		return User{}, 0, fmt.Errorf("store: reading token: %w", err)
	}
	u, err := scanUser(s.queryRow(`SELECT u.id,u.email,u.password_hash,u.created_at,COALESCE(u.google_sub,'') FROM tokens t
		JOIN users u ON u.id=t.user_id WHERE t.id=?`, id))
	if err != nil {
		return User{}, 0, err
	}
	s.exec("UPDATE tokens SET last_used_at=? WHERE id=?", ts(now), id)
	return u, id, nil
}

func (s *Store) RevokeTokenByHash(hash string, now time.Time) error {
	_, err := s.exec("UPDATE tokens SET revoked_at=? WHERE hash=? AND revoked_at IS NULL", ts(now), hash)
	return err
}

// RevokeToken revokes one of the user's own tokens; another user's id is ErrNotFound.
func (s *Store) RevokeToken(userID, tokenID int64, now time.Time) error {
	res, err := s.exec("UPDATE tokens SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL", ts(now), tokenID, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) ListTokens(userID int64) ([]Token, error) {
	rows, err := s.query("SELECT id,name,created_at,last_used_at FROM tokens WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at DESC,id DESC", userID)
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
	_, err := s.exec("INSERT INTO usage(user_id,token_id,model,input_tokens,output_tokens,created_at) VALUES(?,?,?,?,?,?)",
		userID, tokenID, model, in, out, ts(now))
	return err
}

func (s *Store) UsageSince(userID int64, since time.Time) (Usage, error) {
	var u Usage
	err := s.queryRow("SELECT CAST(COALESCE(SUM(input_tokens),0) AS BIGINT),CAST(COALESCE(SUM(output_tokens),0) AS BIGINT) FROM usage WHERE user_id=? AND created_at>=?",
		userID, ts(since)).Scan(&u.Input, &u.Output)
	return u, err
}

// Purge drops expired sessions and codes.
func (s *Store) Purge(now time.Time) error {
	if _, err := s.exec("DELETE FROM sessions WHERE expires_at<=?", ts(now)); err != nil {
		return err
	}
	_, err := s.exec("DELETE FROM auth_codes WHERE expires_at<=?", ts(now))
	return err
}
