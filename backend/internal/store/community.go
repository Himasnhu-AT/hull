package store

import (
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// ErrVersionExists is returned when a game already has that version.
var ErrVersionExists = errors.New("version already exists")

// CommunityVersion is one published version of a community game. CoverMime is empty when it has no cover.
type CommunityVersion struct {
	GameID      string
	Version     string
	Title       string
	Note        string
	Size        int64
	SHA256      string
	CoverMime   string
	PublishedAt time.Time
}

const communityCols = "game_id,version,title,note,size,sha256,cover_mime,published_at"

func scanVersion(sc interface{ Scan(...any) error }) (CommunityVersion, error) {
	var v CommunityVersion
	var at int64
	if err := sc.Scan(&v.GameID, &v.Version, &v.Title, &v.Note, &v.Size, &v.SHA256, &v.CoverMime, &at); err != nil {
		return CommunityVersion{}, err
	}
	v.PublishedAt = time.Unix(at, 0).UTC()
	return v, nil
}

// AddCommunityVersion records a version; the same game and version twice is ErrVersionExists.
func (s *Store) AddCommunityVersion(v CommunityVersion) error {
	_, err := s.exec("INSERT INTO community_versions("+communityCols+") VALUES(?,?,?,?,?,?,?,?)",
		v.GameID, v.Version, v.Title, v.Note, v.Size, v.SHA256, v.CoverMime, ts(v.PublishedAt))
	if err != nil {
		if _, dup := uniqueViolation(err); dup {
			return ErrVersionExists
		}
		return fmt.Errorf("store: adding community version: %w", err)
	}
	return nil
}

// CommunityVersion reads one version; an unknown one is ErrNotFound.
func (s *Store) CommunityVersion(gameID, version string) (CommunityVersion, error) {
	v, err := scanVersion(s.queryRow("SELECT "+communityCols+" FROM community_versions WHERE game_id=? AND version=?", gameID, version))
	if errors.Is(err, sql.ErrNoRows) {
		return CommunityVersion{}, ErrNotFound
	}
	if err != nil {
		return CommunityVersion{}, fmt.Errorf("store: reading community version: %w", err)
	}
	return v, nil
}

// CommunityVersions lists every version of one game, in no particular order (semver order is the caller's job).
func (s *Store) CommunityVersions(gameID string) ([]CommunityVersion, error) {
	return s.queryVersions("SELECT "+communityCols+" FROM community_versions WHERE game_id=?", gameID)
}

// AllCommunityVersions lists every version of every game, in no particular order.
func (s *Store) AllCommunityVersions() ([]CommunityVersion, error) {
	return s.queryVersions("SELECT " + communityCols + " FROM community_versions")
}

func (s *Store) queryVersions(q string, args ...any) ([]CommunityVersion, error) {
	rows, err := s.query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("store: listing community versions: %w", err)
	}
	defer rows.Close()
	var out []CommunityVersion
	for rows.Next() {
		v, err := scanVersion(rows)
		if err != nil {
			return nil, fmt.Errorf("store: listing community versions: %w", err)
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// RemoveCommunityVersion deletes a row; an unknown one is ErrNotFound.
func (s *Store) RemoveCommunityVersion(gameID, version string) error {
	res, err := s.exec("DELETE FROM community_versions WHERE game_id=? AND version=?", gameID, version)
	if err != nil {
		return fmt.Errorf("store: removing community version: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
