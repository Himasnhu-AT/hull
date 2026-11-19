package server

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/marlstudio/hull/backend/internal/store"
)

var (
	clientIDRe  = regexp.MustCompile(`^[a-z0-9-]{1,40}$`)
	challengeRe = regexp.MustCompile(`^[A-Za-z0-9._~-]{43,128}$`)
)

type authParams struct {
	ClientID, RedirectURI, State, Challenge string
}

// loopbackURI accepts only http://127.0.0.1:<port>/... or http://localhost:<port>/... (RFC 8252), so a
// sign-in code can only ever be handed to a program on the person's own computer.
func loopbackURI(raw string) (*url.URL, bool) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" || u.User != nil || u.Fragment != "" || u.Opaque != "" {
		return nil, false
	}
	if h := u.Hostname(); h != "127.0.0.1" && h != "localhost" {
		return nil, false
	}
	if p, err := strconv.Atoi(u.Port()); err != nil || p < 1 || p > 65535 {
		return nil, false
	}
	if !strings.HasPrefix(u.Path, "/") {
		return nil, false
	}
	return u, true
}

// parseAuth validates the request parameters; the message is shown on a 400 page and nothing redirects on failure.
func parseAuth(get func(string) string) (authParams, string) {
	p := authParams{ClientID: get("client_id"), RedirectURI: get("redirect_uri"), State: get("state"), Challenge: get("code_challenge")}
	switch {
	case get("response_type") != "code":
		return p, "response_type must be code."
	case !clientIDRe.MatchString(p.ClientID):
		return p, "client_id must be 1 to 40 characters of a-z, 0-9 and -."
	case func() bool { _, ok := loopbackURI(p.RedirectURI); return !ok }():
		return p, "redirect_uri must be http://127.0.0.1:<port>/<path> or http://localhost:<port>/<path>."
	case get("code_challenge_method") != "S256":
		return p, "code_challenge_method must be S256."
	case !challengeRe.MatchString(p.Challenge):
		return p, "code_challenge is missing or malformed."
	case len(p.State) > 512:
		return p, "state is too long."
	}
	return p, ""
}

func (s *Server) authorizePage(w http.ResponseWriter, r *http.Request) {
	p, bad := parseAuth(r.URL.Query().Get)
	if bad != "" {
		s.message(w, http.StatusBadRequest, "Cannot sign in", bad)
		return
	}
	u, ok := s.sessionUser(r)
	if !ok {
		http.Redirect(w, r, "/login?next="+url.QueryEscape(r.URL.RequestURI()), http.StatusFound)
		return
	}
	ru, _ := loopbackURI(p.RedirectURI)
	s.render(w, 200, "consent", pageData{Title: "Allow access", CSRF: s.csrf(w, r), Email: u.Email, Client: p.ClientID, Target: ru.Host,
		Hidden: []field{{"response_type", "code"}, {"client_id", p.ClientID}, {"redirect_uri", p.RedirectURI}, {"state", p.State},
			{"code_challenge", p.Challenge}, {"code_challenge_method", "S256"}}})
}

func (s *Server) authorizeSubmit(w http.ResponseWriter, r *http.Request) {
	if !s.readForm(w, r) {
		return
	}
	p, bad := parseAuth(r.PostFormValue)
	if bad != "" {
		s.message(w, http.StatusBadRequest, "Cannot sign in", bad)
		return
	}
	u, ok := s.sessionUser(r)
	if !ok {
		s.message(w, http.StatusUnauthorized, "Log in first", "Your session ended. Start the sign-in again from the app.")
		return
	}
	target, _ := loopbackURI(p.RedirectURI)
	q := target.Query()
	if r.PostFormValue("decision") != "allow" {
		q.Set("error", "access_denied")
	} else {
		code := randomString(32)
		err := s.st.CreateCode(hashSecret(code), store.Code{UserID: u.ID, ClientID: p.ClientID, RedirectURI: p.RedirectURI,
			CodeChallenge: p.Challenge, ExpiresAt: s.now().Add(codeTTL)})
		if err != nil {
			s.log.Error("creating code", "err", err)
			s.message(w, 500, "Error", "Could not complete sign-in. Try again.")
			return
		}
		q.Set("code", code)
	}
	if p.State != "" {
		q.Set("state", p.State)
	}
	target.RawQuery = q.Encode()
	http.Redirect(w, r, target.String(), http.StatusFound)
}

func tokenError(w http.ResponseWriter, status int, code, desc string) {
	writeJSON(w, status, map[string]string{"error": code, "error_description": desc})
}

func (s *Server) oauthToken(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, formLimit)
	var f struct {
		GrantType    string `json:"grant_type"`
		Code         string `json:"code"`
		RedirectURI  string `json:"redirect_uri"`
		ClientID     string `json:"client_id"`
		CodeVerifier string `json:"code_verifier"`
	}
	if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		if err := json.NewDecoder(r.Body).Decode(&f); err != nil {
			tokenError(w, 400, "invalid_request", "The JSON body could not be read.")
			return
		}
	} else {
		if err := r.ParseForm(); err != nil {
			tokenError(w, 400, "invalid_request", "The form body could not be read.")
			return
		}
		f.GrantType, f.Code, f.RedirectURI = r.PostFormValue("grant_type"), r.PostFormValue("code"), r.PostFormValue("redirect_uri")
		f.ClientID, f.CodeVerifier = r.PostFormValue("client_id"), r.PostFormValue("code_verifier")
	}
	if f.GrantType != "authorization_code" {
		tokenError(w, 400, "unsupported_grant_type", "grant_type must be authorization_code.")
		return
	}
	bad := func(why string) { tokenError(w, 400, "invalid_grant", why) }
	if f.Code == "" {
		bad("The code is missing.")
		return
	}
	// The code is deleted by this read, so every failure below also burns it: one guess per code.
	c, err := s.st.ConsumeCode(hashSecret(f.Code))
	if err != nil {
		bad("The code is unknown or was already used.")
		return
	}
	sum := sha256.Sum256([]byte(f.CodeVerifier))
	got := base64.RawURLEncoding.EncodeToString(sum[:])
	switch {
	case !s.now().Before(c.ExpiresAt):
		bad("The code has expired.")
	case c.ClientID != f.ClientID:
		bad("client_id does not match the code.")
	case c.RedirectURI != f.RedirectURI:
		bad("redirect_uri does not match the code.")
	case len(f.CodeVerifier) < 43 || len(f.CodeVerifier) > 128 || subtle.ConstantTimeCompare([]byte(got), []byte(c.CodeChallenge)) != 1:
		bad("code_verifier does not match the code_challenge.")
	default:
		tok := "hull_" + randomString(32)
		if err := s.st.CreateToken(hashSecret(tok), c.UserID, c.ClientID, s.now()); err != nil {
			s.log.Error("creating token", "err", err)
			tokenError(w, 500, "server_error", "Could not create the token.")
			return
		}
		u, err := s.st.UserByID(c.UserID)
		if err != nil {
			tokenError(w, 500, "server_error", "Could not read the account.")
			return
		}
		writeJSON(w, 200, map[string]any{"access_token": tok, "token_type": "Bearer", "account": map[string]string{"email": u.Email}})
	}
}

// ---- token-authenticated JSON API ----

func (s *Server) tokenUser(r *http.Request) (store.User, int64, bool) {
	tok := bearer(r)
	if tok == "" {
		return store.User{}, 0, false
	}
	u, id, err := s.st.TokenUser(hashSecret(tok), s.now())
	return u, id, err == nil
}

func (s *Server) apiMe(w http.ResponseWriter, r *http.Request) {
	u, _, ok := s.tokenUser(r)
	if !ok {
		writeJSON(w, 401, map[string]string{"error": "Missing or invalid token."})
		return
	}
	writeJSON(w, 200, map[string]string{"email": u.Email, "created_at": u.CreatedAt.Format(time.RFC3339)})
}

func (s *Server) apiLogout(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := s.tokenUser(r); !ok {
		writeJSON(w, 401, map[string]string{"error": "Missing or invalid token."})
		return
	}
	s.st.RevokeTokenByHash(hashSecret(bearer(r)), s.now())
	w.WriteHeader(http.StatusNoContent)
}
