package server

import (
	"net/http"
	"net/mail"
	"net/url"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/marlstudio/hull/backend/internal/passwords"
	"github.com/marlstudio/hull/backend/internal/store"
)

const minPassword = 10

func (s *Server) authData(w http.ResponseWriter, r *http.Request, signup bool) pageData {
	return s.authDataNext(w, r, signup, safeNext(r.FormValue("next")))
}

// authDataNext is authData with next already decided, for the Google callback where it comes from the cookie.
func (s *Server) authDataNext(w http.ResponseWriter, r *http.Request, signup bool, next string) pageData {
	d := pageData{CSRF: s.csrf(w, r), Next: next, MinLen: minPassword}
	q := ""
	if d.Next != "/" {
		q = "?next=" + url.QueryEscape(d.Next)
	}
	if signup {
		d.Title, d.Action, d.Signup, d.AutoComplete = "Sign up", "/signup", true, "new-password"
		d.Alt, d.AltHref, d.AltLabel = "Already have an account?", "/login"+q, "Log in"
	} else {
		d.Title, d.Action, d.AutoComplete = "Log in", "/login", "current-password"
		d.Alt, d.AltHref, d.AltLabel = "New here?", "/signup"+q, "Sign up"
		d.MinLen = 0
	}
	d.Action += q
	if s.cfg.GoogleEnabled() {
		d.Google, d.GoogleHref = true, "/auth/google/start"+q
	}
	return d
}

func (s *Server) signupPage(w http.ResponseWriter, r *http.Request) {
	d := s.authData(w, r, true)
	if !s.cfg.AllowSignup {
		d.Closed = true
		s.render(w, http.StatusForbidden, "auth", d)
		return
	}
	s.render(w, 200, "auth", d)
}

// tooMany applies the per-IP limit shared by login and signup.
func (s *Server) tooMany(w http.ResponseWriter, r *http.Request) bool {
	if s.limit.Allow(clientIP(r)) {
		return false
	}
	w.Header().Set("Retry-After", "60")
	s.message(w, http.StatusTooManyRequests, "Slow down", "Too many attempts from your address. Try again in a minute.")
	return true
}

func (s *Server) readForm(w http.ResponseWriter, r *http.Request) bool {
	r.Body = http.MaxBytesReader(w, r.Body, formLimit)
	if err := r.ParseForm(); err != nil {
		s.message(w, http.StatusBadRequest, "Bad request", "The form could not be read.")
		return false
	}
	if !s.checkCSRF(r) {
		s.message(w, http.StatusForbidden, "Page expired", "This page is out of date. Go back, reload it and try again.")
		return false
	}
	return true
}

func (s *Server) signupSubmit(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.AllowSignup {
		d := s.authData(w, r, true)
		d.Closed = true
		s.render(w, http.StatusForbidden, "auth", d)
		return
	}
	if s.tooMany(w, r) || !s.readForm(w, r) {
		return
	}
	d := s.authData(w, r, true)
	email := normEmail(r.PostFormValue("email"))
	d.Email = email
	pw, confirm := r.PostFormValue("password"), r.PostFormValue("confirm")
	fail := func(status int, msg string) { d.Error = msg; s.render(w, status, "auth", d) }
	if a, err := mail.ParseAddress(email); err != nil || a.Address != email || len(email) > 254 {
		fail(400, "Enter a valid email address.")
		return
	}
	if utf8.RuneCountInString(pw) < minPassword {
		fail(400, "The password must be at least 10 characters.")
		return
	}
	if len(pw) > 512 {
		fail(400, "The password is too long.")
		return
	}
	if pw != confirm {
		fail(400, "The two passwords do not match.")
		return
	}
	hash, err := s.hash(pw)
	if err != nil {
		s.log.Error("hashing password", "err", err)
		fail(500, "Something went wrong. Try again.")
		return
	}
	u, err := s.st.CreateUser(email, hash, s.now())
	if err == store.ErrEmailTaken {
		fail(409, "An account with this email already exists. Log in instead.")
		return
	}
	if err != nil {
		s.log.Error("creating user", "err", err)
		fail(500, "Something went wrong. Try again.")
		return
	}
	if err := s.startSession(w, u); err != nil {
		s.log.Error("starting session", "err", err)
		fail(500, "Something went wrong. Try again.")
		return
	}
	http.Redirect(w, r, d.Next, http.StatusSeeOther)
}

func (s *Server) loginPage(w http.ResponseWriter, r *http.Request) {
	d := s.authData(w, r, false)
	if _, ok := s.sessionUser(r); ok {
		http.Redirect(w, r, d.Next, http.StatusSeeOther)
		return
	}
	s.render(w, 200, "auth", d)
}

func (s *Server) loginSubmit(w http.ResponseWriter, r *http.Request) {
	if s.tooMany(w, r) || !s.readForm(w, r) {
		return
	}
	d := s.authData(w, r, false)
	email := normEmail(r.PostFormValue("email"))
	d.Email = email
	pw := r.PostFormValue("password")
	u, err := s.st.UserByEmail(email)
	hash := u.PassHash
	// An account with no password (Google only) takes the same slow path and the same answer as an unknown email.
	noPass := err != nil || hash == ""
	if noPass || len(pw) > 512 {
		hash = s.fakeHash()
	}
	ok := passwords.Verify(pw, hash) && !noPass && len(pw) <= 512
	if !ok {
		d.Error = "The email or password is wrong."
		s.render(w, http.StatusUnauthorized, "auth", d)
		return
	}
	if err := s.startSession(w, u); err != nil {
		s.log.Error("starting session", "err", err)
		d.Error = "Something went wrong. Try again."
		s.render(w, 500, "auth", d)
		return
	}
	http.Redirect(w, r, d.Next, http.StatusSeeOther)
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if !s.readForm(w, r) {
		return
	}
	if c, err := r.Cookie(sessionCookie); err == nil {
		s.st.DeleteSession(hashSecret(c.Value))
	}
	s.setCookie(w, sessionCookie, "", time.Unix(0, 0))
	http.Redirect(w, r, "/login", http.StatusSeeOther)
}

func fmtTime(t time.Time) string {
	if t.IsZero() {
		return "never"
	}
	return t.UTC().Format("2 Jan 2006 15:04 UTC")
}

func (s *Server) accountPage(w http.ResponseWriter, r *http.Request) {
	u, ok := s.sessionUser(r)
	if !ok {
		http.Redirect(w, r, "/login", http.StatusSeeOther)
		return
	}
	d := pageData{Title: "Account", Wide: true, CSRF: s.csrf(w, r), Email: u.Email, GoogleLinked: u.GoogleSub != ""}
	toks, err := s.st.ListTokens(u.ID)
	if err != nil {
		s.log.Error("listing tokens", "err", err)
		s.message(w, 500, "Error", "Could not load your account. Try again.")
		return
	}
	for _, t := range toks {
		d.Tokens = append(d.Tokens, tokenRow{ID: t.ID, Name: t.Name, Created: fmtTime(t.CreatedAt), LastUsed: fmtTime(t.LastUsedAt)})
	}
	n := s.now().UTC()
	use, err := s.st.UsageSince(u.ID, time.Date(n.Year(), n.Month(), 1, 0, 0, 0, 0, time.UTC))
	if err != nil {
		s.log.Error("reading usage", "err", err)
	}
	d.Input, d.Output = use.Input, use.Output
	s.render(w, 200, "account", d)
}

func (s *Server) revokeToken(w http.ResponseWriter, r *http.Request) {
	if !s.readForm(w, r) {
		return
	}
	u, ok := s.sessionUser(r)
	if !ok {
		http.Redirect(w, r, "/login", http.StatusSeeOther)
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.message(w, 400, "Bad request", "Unknown app.")
		return
	}
	if err := s.st.RevokeToken(u.ID, id, s.now()); err != nil && err != store.ErrNotFound {
		s.log.Error("revoking token", "err", err)
	}
	http.Redirect(w, r, "/", http.StatusSeeOther)
}
