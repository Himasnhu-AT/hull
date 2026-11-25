package server

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/marlstudio/hull/backend/internal/store"
)

const (
	googleCookie       = "hull_google"
	googleCookieTTL    = 10 * time.Minute
	googleCallbackPath = "/api/v1/auth/google/callback"
	googleNotSetUp     = "Google sign-in is not set up on this server"
)

// googleOff answers 503 when the server has no Google credentials, so the routes are never half on.
func (s *Server) googleOff(w http.ResponseWriter) bool {
	if s.cfg.GoogleEnabled() {
		return false
	}
	s.message(w, http.StatusServiceUnavailable, "Google sign-in", googleNotSetUp)
	return true
}

// googleFail shows the login page with a message; next comes from the cookie so the person can try again.
func (s *Server) googleFail(w http.ResponseWriter, r *http.Request, status int, next, msg string) {
	d := s.authDataNext(w, r, false, next)
	d.Error = msg
	s.render(w, status, "auth", d)
}

func s256(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// googleStart sends the browser to Google. State and the PKCE verifier wait in a short cookie bound to next,
// so the callback can prove it is the same browser that started the sign-in.
func (s *Server) googleStart(w http.ResponseWriter, r *http.Request) {
	if s.googleOff(w) || s.tooMany(w, r) {
		return
	}
	next := safeNext(r.FormValue("next"))
	state, verifier := randomString(32), randomString(48)
	http.SetCookie(w, &http.Cookie{Name: googleCookie, Path: googleCallbackPath, HttpOnly: true, SameSite: http.SameSiteLaxMode,
		Secure: s.cfg.Secure(), MaxAge: int(googleCookieTTL.Seconds()), Expires: s.now().Add(googleCookieTTL),
		Value: state + "|" + verifier + "|" + base64.RawURLEncoding.EncodeToString([]byte(next))})
	q := url.Values{
		"client_id":             {s.cfg.GoogleClientID},
		"redirect_uri":          {s.cfg.PublicURL + googleCallbackPath},
		"response_type":         {"code"},
		"scope":                 {"openid email profile"},
		"state":                 {state},
		"code_challenge":        {s256(verifier)},
		"code_challenge_method": {"S256"},
		"prompt":                {"select_account"},
	}
	sep := "?"
	if strings.Contains(s.cfg.GoogleAuthURL, "?") {
		sep = "&"
	}
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, s.cfg.GoogleAuthURL+sep+q.Encode(), http.StatusFound)
}

func (s *Server) googleCallback(w http.ResponseWriter, r *http.Request) {
	if s.googleOff(w) {
		return
	}
	// The cookie is single use whatever happens next.
	var state, verifier, next string
	next = "/"
	cookieOK := false
	if c, err := r.Cookie(googleCookie); err == nil {
		if parts := strings.Split(c.Value, "|"); len(parts) == 3 {
			if nb, err := base64.RawURLEncoding.DecodeString(parts[2]); err == nil {
				state, verifier, next, cookieOK = parts[0], parts[1], safeNext(string(nb)), true
			}
		}
	}
	http.SetCookie(w, &http.Cookie{Name: googleCookie, Path: googleCallbackPath, HttpOnly: true, SameSite: http.SameSiteLaxMode,
		Secure: s.cfg.Secure(), MaxAge: -1, Expires: time.Unix(0, 0)})

	q := r.URL.Query()
	if q.Get("error") != "" {
		s.googleFail(w, r, http.StatusOK, next, "Google sign-in was cancelled")
		return
	}
	got := q.Get("state")
	if !cookieOK || state == "" || got == "" || subtle.ConstantTimeCompare([]byte(state), []byte(got)) != 1 {
		s.googleFail(w, r, http.StatusBadRequest, next, "The Google sign-in expired or did not start here. Try again.")
		return
	}
	code := q.Get("code")
	if code == "" {
		s.googleFail(w, r, http.StatusBadRequest, next, "Google did not send a sign-in code. Try again.")
		return
	}
	claims, err := s.googleExchange(code, verifier)
	if err != nil {
		// The error text never includes the request, so the client secret cannot reach the log.
		s.log.Error("google sign-in", "err", err)
		s.googleFail(w, r, http.StatusBadGateway, next, "Google sign-in failed. Try again.")
		return
	}
	if msg := claims.check(s.cfg.GoogleClientID, s.now()); msg != "" {
		s.googleFail(w, r, http.StatusForbidden, next, msg)
		return
	}
	u, status, msg := s.googleAccount(claims)
	if msg != "" {
		s.googleFail(w, r, status, next, msg)
		return
	}
	if err := s.startSession(w, u); err != nil {
		s.log.Error("starting session", "err", err)
		s.googleFail(w, r, 500, next, "Something went wrong. Try again.")
		return
	}
	http.Redirect(w, r, next, http.StatusSeeOther)
}

// idClaims are the parts of Google's id_token we use.
type idClaims struct {
	Iss           string          `json:"iss"`
	Aud           json.RawMessage `json:"aud"`
	Exp           float64         `json:"exp"`
	Sub           string          `json:"sub"`
	Email         string          `json:"email"`
	EmailVerified json.RawMessage `json:"email_verified"`
	Hd            string          `json:"hd"`
}

// googleExchange trades the code for an id_token. The token came straight from Google over TLS in answer to a
// request carrying our secret, so (per Google's docs) its signature need not be checked again here.
func (s *Server) googleExchange(code, verifier string) (idClaims, error) {
	form := url.Values{"code": {code}, "client_id": {s.cfg.GoogleClientID}, "client_secret": {s.cfg.GoogleClientSecret},
		"redirect_uri": {s.cfg.PublicURL + googleCallbackPath}, "grant_type": {"authorization_code"}, "code_verifier": {verifier}}
	resp, err := s.google.PostForm(s.cfg.GoogleTokenURL, form)
	if err != nil {
		// A *url.Error repeats the URL, which holds no secret (the form is in the body), but keep only the cause.
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return idClaims{}, fmt.Errorf("google token request: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return idClaims{}, fmt.Errorf("google token response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return idClaims{}, fmt.Errorf("google token endpoint answered %d", resp.StatusCode)
	}
	var tok struct {
		IDToken string `json:"id_token"`
	}
	if err := json.Unmarshal(body, &tok); err != nil || tok.IDToken == "" {
		return idClaims{}, errors.New("google token response has no id_token")
	}
	parts := strings.Split(tok.IDToken, ".")
	if len(parts) != 3 {
		return idClaims{}, errors.New("google id_token is not a JWT")
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return idClaims{}, errors.New("google id_token payload is not base64")
	}
	var c idClaims
	if err := json.Unmarshal(payload, &c); err != nil {
		return idClaims{}, errors.New("google id_token payload is not JSON")
	}
	return c, nil
}

// check returns the message to show, or "" when the claims are good.
func (c idClaims) check(clientID string, now time.Time) string {
	const bad = "Google sign-in failed. Try again."
	if c.Iss != "accounts.google.com" && c.Iss != "https://accounts.google.com" {
		return bad
	}
	var aud string
	var auds []string
	if json.Unmarshal(c.Aud, &aud) == nil {
		auds = []string{aud}
	} else if json.Unmarshal(c.Aud, &auds) != nil {
		return bad
	}
	audOK := false
	for _, a := range auds {
		audOK = audOK || a == clientID
	}
	if !audOK || float64(now.Unix()) >= c.Exp || c.Sub == "" || c.Email == "" {
		return bad
	}
	var verified bool
	var vs string
	if json.Unmarshal(c.EmailVerified, &verified) != nil {
		// Some Google responses send the string "true".
		verified = json.Unmarshal(c.EmailVerified, &vs) == nil && vs == "true"
	}
	if !verified {
		return "Google did not confirm that email address"
	}
	return ""
}

// googleIsAuthority reports whether Google vouches for ownership of this address: it hosts gmail.com itself, or
// the token names the Workspace domain (hd) that the address is on. Any other address, even verified, could be
// a mailbox someone else set up a password account on.
func (c idClaims) googleIsAuthority(email string) bool {
	at := strings.LastIndex(email, "@")
	if at < 0 {
		return false
	}
	dom := email[at+1:]
	return dom == "gmail.com" || dom == "googlemail.com" || (c.Hd != "" && strings.EqualFold(c.Hd, dom))
}

// googleAccount picks the account for a verified Google identity: by subject, then by email (only when Google is
// the authority for it), then a new one.
func (s *Server) googleAccount(c idClaims) (store.User, int, string) {
	const generic = "Something went wrong. Try again."
	email := normEmail(c.Email)
	u, err := s.st.UserByGoogleSub(c.Sub)
	if err == nil {
		return u, 0, ""
	}
	if err != store.ErrNotFound {
		s.log.Error("reading user by google sub", "err", err)
		return store.User{}, 500, generic
	}
	u, err = s.st.UserByEmail(email)
	switch {
	case err == nil:
		if u.GoogleSub != "" || !c.googleIsAuthority(email) {
			return store.User{}, http.StatusConflict, "An account with this email already exists. Sign in with your password."
		}
		// Linking drops the account's password, sessions and tokens (store.LinkGoogle says why): whoever made the
		// password account never proved the address, and must not keep a way in.
		if err := s.st.LinkGoogle(u.ID, c.Sub, s.now()); err != nil {
			s.log.Error("linking google account", "err", err)
			return store.User{}, 500, generic
		}
		u.GoogleSub = c.Sub
		u.PassHash = ""
		return u, 0, ""
	case err != store.ErrNotFound:
		s.log.Error("reading user by email", "err", err)
		return store.User{}, 500, generic
	}
	if !s.cfg.AllowSignup {
		return store.User{}, http.StatusForbidden, "Sign-ups are closed on this server"
	}
	u, err = s.st.CreateGoogleUser(email, c.Sub, s.now())
	if err != nil {
		s.log.Error("creating google user", "err", err)
		return store.User{}, 500, generic
	}
	return u, 0, ""
}
