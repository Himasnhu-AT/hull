// Package server is Hull's backend: account pages, app sign-in (OAuth with PKCE) and the AI proxy.
package server

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/marlstudio/hull/backend/internal/config"
	"github.com/marlstudio/hull/backend/internal/passwords"
	"github.com/marlstudio/hull/backend/internal/ratelimit"
	"github.com/marlstudio/hull/backend/internal/store"
)

const (
	sessionCookie = "hull_session"
	csrfCookie    = "hull_csrf"
	sessionTTL    = 30 * 24 * time.Hour
	codeTTL       = 5 * time.Minute
	formLimit     = 64 << 10
	apiLimit      = 20 << 20
)

type Server struct {
	cfg    config.Config
	st     *store.Store
	log    *slog.Logger
	now    func() time.Time
	params passwords.Params
	limit  *ratelimit.Limiter // login and signup, per IP
	client *http.Client       // to Anthropic; no overall timeout because replies stream
	google *http.Client       // to Google's token endpoint; a short timeout because a person is waiting

	communityLimit *ratelimit.Limiter // public catalog reads, per IP

	dummyOnce sync.Once
	dummyHash string
}

func New(cfg config.Config, st *store.Store, log *slog.Logger) *Server {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	// Models can think a long time before the first byte, but a dead upstream should not hold a request forever.
	tr.ResponseHeaderTimeout = 10 * time.Minute
	return &Server{cfg: cfg, st: st, log: log, now: time.Now, params: passwords.Default,
		limit: ratelimit.New(10), client: &http.Client{Transport: tr},
		google: &http.Client{Timeout: 10 * time.Second}, communityLimit: ratelimit.New(communityRate)}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write([]byte("ok"))
	})
	mux.HandleFunc("GET /signup", s.signupPage)
	mux.HandleFunc("POST /signup", s.signupSubmit)
	mux.HandleFunc("GET /login", s.loginPage)
	mux.HandleFunc("POST /login", s.loginSubmit)
	mux.HandleFunc("POST /logout", s.logout)
	mux.HandleFunc("GET /auth/google/start", s.googleStart)
	mux.HandleFunc("GET "+googleCallbackPath, s.googleCallback)
	mux.HandleFunc("GET /{$}", s.accountPage)
	mux.HandleFunc("POST /tokens/{id}/revoke", s.revokeToken)

	mux.HandleFunc("GET /oauth/authorize", s.authorizePage)
	mux.HandleFunc("POST /oauth/authorize", s.authorizeSubmit)
	mux.HandleFunc("POST /oauth/token", s.oauthToken)
	mux.HandleFunc("GET /api/me", s.apiMe)
	mux.HandleFunc("POST /api/logout", s.apiLogout)

	mux.HandleFunc("GET /api/community", s.communityLimited(s.communityList))
	mux.HandleFunc("GET /api/community/{id}/cover", s.communityLimited(s.communityLatestCover))
	mux.HandleFunc("GET /api/community/{id}/{version}/cover", s.communityLimited(s.communityVersionCover))
	mux.HandleFunc("GET /api/community/{id}/{version}/game.tar.gz", s.communityLimited(s.communityArchive))

	mux.HandleFunc("POST /v1/messages", s.handleMessages)
	mux.HandleFunc("POST /v1/messages/count_tokens", s.handleCountTokens)
	mux.HandleFunc("GET /v1/models", s.handleModels)
	mux.HandleFunc("POST /v1/chat/completions", s.handleChat)
	return s.middleware(mux)
}

// ---- middleware ----

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(c int) { w.status = c; w.ResponseWriter.WriteHeader(c) }
func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// middleware logs one line per request (method, path, status, time; never the query, headers or body, which
// can hold codes, tokens and passwords) and keeps a panic from taking the process down.
func (s *Server) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: 200}
		defer func() {
			if v := recover(); v != nil {
				s.log.Error("handler panic", "path", r.URL.Path, "panic", v)
				if sw.status == 200 {
					http.Error(sw, "internal error", http.StatusInternalServerError)
				}
			}
			s.log.Info("request", "method", r.Method, "path", r.URL.Path, "status", sw.status,
				"ms", time.Since(start).Milliseconds(), "ip", clientIP(r))
		}()
		next.ServeHTTP(sw, r)
	})
}

func clientIP(r *http.Request) string {
	h, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return h
}

// ---- small helpers ----

func randomString(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("server: no randomness available: " + err.Error())
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// hashSecret is what we store for session ids, codes and tokens.
func hashSecret(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func (s *Server) hash(pw string) (string, error) { return passwords.Hash(pw, s.params) }

// fakeHash lets a login for an unknown email cost the same as a real one, so timing does not reveal accounts.
func (s *Server) fakeHash() string {
	s.dummyOnce.Do(func() { s.dummyHash, _ = s.hash(randomString(16)) })
	return s.dummyHash
}

func (s *Server) setCookie(w http.ResponseWriter, name, value string, expires time.Time) {
	c := &http.Cookie{Name: name, Value: value, Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: s.cfg.Secure()}
	if !expires.IsZero() {
		c.Expires = expires
		if expires.Before(s.now()) {
			c.MaxAge = -1
		}
	}
	http.SetCookie(w, c)
}

// csrf returns the visitor's CSRF token, creating the cookie on first sight. Forms echo it back and
// checkCSRF compares the two; a cross-site page can do neither.
func (s *Server) csrf(w http.ResponseWriter, r *http.Request) string {
	if c, err := r.Cookie(csrfCookie); err == nil && len(c.Value) >= 32 {
		return c.Value
	}
	v := randomString(32)
	s.setCookie(w, csrfCookie, v, time.Time{})
	return v
}

func (s *Server) checkCSRF(r *http.Request) bool {
	c, err := r.Cookie(csrfCookie)
	if err != nil || len(c.Value) < 32 {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(c.Value), []byte(r.PostFormValue("csrf"))) == 1
}

func (s *Server) sessionUser(r *http.Request) (store.User, bool) {
	c, err := r.Cookie(sessionCookie)
	if err != nil || c.Value == "" {
		return store.User{}, false
	}
	u, err := s.st.SessionUser(hashSecret(c.Value), s.now())
	return u, err == nil
}

func (s *Server) startSession(w http.ResponseWriter, u store.User) error {
	id := randomString(32)
	exp := s.now().Add(sessionTTL)
	if err := s.st.CreateSession(hashSecret(id), u.ID, exp); err != nil {
		return err
	}
	s.setCookie(w, sessionCookie, id, exp)
	return nil
}

// safeNext allows only a same-origin relative path, so a login link cannot bounce people to another site.
func safeNext(next string) string {
	if next == "" || next[0] != '/' || strings.HasPrefix(next, "//") || strings.HasPrefix(next, "/\\") {
		return "/"
	}
	for _, c := range next {
		if c < 0x20 || c == 0x7f || c == '\\' {
			return "/"
		}
	}
	if u, err := url.Parse(next); err != nil || u.Host != "" || u.Scheme != "" {
		return "/"
	}
	return next
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func normEmail(e string) string { return strings.ToLower(strings.TrimSpace(e)) }

func bearer(r *http.Request) string {
	if h := r.Header.Get("Authorization"); len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}
