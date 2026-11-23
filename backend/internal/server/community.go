package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/marlstudio/hull/backend/internal/community"
	"github.com/marlstudio/hull/backend/internal/store"
)

// The community catalog is public and read-only. Every route validates its path segments against the same
// rules the publisher uses before they touch a file path, so a request cannot name anything outside
// DATA_DIR/community/<id>/<version>/.

const (
	communityRate    = 120 // per IP per minute: generous for an app that lists once and downloads a few games
	coverCache       = "public, max-age=3600"
	archiveCache     = "public, max-age=31536000, immutable"
	listCache        = "public, max-age=60"
	downloadDeadline = 15 * time.Minute // the server-wide write timeout is too short for a large game on a slow line
)

type communityGame struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Note        string   `json:"note"`
	Version     string   `json:"version"`
	PublishedAt string   `json:"published_at"`
	Size        int64    `json:"size"`
	SHA256      string   `json:"sha256"`
	CoverURL    *string  `json:"cover_url"`
	DownloadURL string   `json:"download_url"`
	Versions    []string `json:"versions"`
}

// communityLimited wraps a handler with the per-IP limit.
func (s *Server) communityLimited(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.communityLimit.Allow(s.clientIP(r)) {
			w.Header().Set("Retry-After", "30")
			http.Error(w, "too many requests", http.StatusTooManyRequests)
			return
		}
		h(w, r)
	}
}

func (s *Server) communityBase() string { return s.cfg.PublicURL + "/api/community/" }

func (s *Server) communityList(w http.ResponseWriter, r *http.Request) {
	rows, err := s.st.AllCommunityVersions()
	if err != nil {
		s.log.Error("community list", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	byGame := map[string][]store.CommunityVersion{}
	for _, v := range rows {
		byGame[v.GameID] = append(byGame[v.GameID], v)
	}
	games := make([]communityGame, 0, len(byGame))
	for id, vs := range byGame {
		community.SortNewestFirst(vs)
		latest := vs[0]
		g := communityGame{ID: id, Title: latest.Title, Note: latest.Note, Version: latest.Version,
			PublishedAt: latest.PublishedAt.Format(time.RFC3339), Size: latest.Size, SHA256: latest.SHA256,
			DownloadURL: s.communityBase() + id + "/" + latest.Version + "/game.tar.gz",
			Versions:    make([]string, 0, len(vs))}
		if latest.CoverMime != "" {
			u := s.communityBase() + id + "/" + latest.Version + "/cover"
			g.CoverURL = &u
		}
		for _, v := range vs {
			g.Versions = append(g.Versions, v.Version)
		}
		games = append(games, g)
	}
	sort.Slice(games, func(i, j int) bool {
		a, b := strings.ToLower(games[i].Title), strings.ToLower(games[j].Title)
		if a != b {
			return a < b
		}
		return games[i].ID < games[j].ID
	})
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", listCache)
	json.NewEncoder(w).Encode(map[string]any{"games": games})
}

// communityVersion finds the stored row for a request's id and version, or writes the 404 itself.
func (s *Server) communityVersion(w http.ResponseWriter, id, version string) (store.CommunityVersion, bool) {
	v, err := community.ParseVersion(version)
	if !community.ValidID(id) || err != nil {
		http.NotFound(w, nil)
		return store.CommunityVersion{}, false
	}
	row, err := s.st.CommunityVersion(id, v.String())
	if errors.Is(err, store.ErrNotFound) || (err == nil && v.String() != version) {
		http.NotFound(w, nil)
		return store.CommunityVersion{}, false
	}
	if err != nil {
		s.log.Error("community version", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return store.CommunityVersion{}, false
	}
	return row, true
}

func (s *Server) communityLatestCover(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !community.ValidID(id) {
		http.NotFound(w, r)
		return
	}
	vs, err := s.st.CommunityVersions(id)
	if err != nil {
		s.log.Error("community latest cover", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if len(vs) == 0 {
		http.NotFound(w, r)
		return
	}
	community.SortNewestFirst(vs)
	s.serveCover(w, r, vs[0])
}

func (s *Server) communityVersionCover(w http.ResponseWriter, r *http.Request) {
	row, ok := s.communityVersion(w, r.PathValue("id"), r.PathValue("version"))
	if !ok {
		return
	}
	s.serveCover(w, r, row)
}

func (s *Server) serveCover(w http.ResponseWriter, r *http.Request, row store.CommunityVersion) {
	path := community.CoverPath(s.cfg.DataDir, row.GameID, row.Version, row.CoverMime)
	if path == "" {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", row.CoverMime)
	w.Header().Set("Cache-Control", coverCache)
	http.ServeContent(w, r, "", fi.ModTime(), f)
}

func (s *Server) communityArchive(w http.ResponseWriter, r *http.Request) {
	row, ok := s.communityVersion(w, r.PathValue("id"), r.PathValue("version"))
	if !ok {
		return
	}
	f, err := os.Open(community.ArchivePath(s.cfg.DataDir, row.GameID, row.Version))
	if err != nil {
		s.log.Error("community archive missing", "id", row.GameID, "version", row.Version, "err", err)
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	http.NewResponseController(w).SetWriteDeadline(time.Now().Add(downloadDeadline))
	h := w.Header()
	h.Set("Content-Type", "application/gzip")
	h.Set("Cache-Control", archiveCache)
	h.Set("ETag", `"`+row.SHA256+`"`)
	h.Set("X-Hull-Sha256", row.SHA256)
	// ServeContent sets Content-Length, answers If-None-Match with 304 and supports resuming a download with Range.
	http.ServeContent(w, r, "", fi.ModTime(), f)
}
