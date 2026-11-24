package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/marlstudio/hull/backend/internal/config"
	"github.com/marlstudio/hull/backend/internal/passwords"
	"github.com/marlstudio/hull/backend/internal/store"
	"github.com/marlstudio/hull/backend/internal/store/storetest"
)

const testKey = "sk-ant-TESTKEY-do-not-leak-0123456789"

// fakeUp stands in for Anthropic: it records what it was sent and answers with respond.
type fakeUp struct {
	mu      sync.Mutex
	hdr     http.Header
	body    []byte
	path    string
	calls   int
	respond func(w http.ResponseWriter, r *http.Request, body []byte)
}

func (f *fakeUp) last() (http.Header, []byte, string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.hdr, f.body, f.path
}

type env struct {
	t    *testing.T
	s    *Server
	ts   *httptest.Server
	up   *fakeUp
	upS  *httptest.Server
	logs *bytes.Buffer
	st   *store.Store
}

type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) { s.mu.Lock(); defer s.mu.Unlock(); return s.b.Write(p) }

func newEnv(t *testing.T, mut func(*config.Config)) *env {
	t.Helper()
	up := &fakeUp{}
	upS := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		up.mu.Lock()
		up.hdr, up.body, up.path = r.Header.Clone(), body, r.URL.Path
		up.calls++
		resp := up.respond
		up.mu.Unlock()
		if r.Header.Get("x-api-key") != testKey {
			w.WriteHeader(401)
			w.Write([]byte(`{"type":"error","error":{"type":"authentication_error","message":"bad key"}}`))
			return
		}
		if resp == nil {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5-5","content":[{"type":"text","text":"hi"}],"stop_reason":"end_turn","usage":{"input_tokens":11,"output_tokens":7}}`))
			return
		}
		resp(w, r, body)
	}))
	t.Cleanup(upS.Close)
	cfg := config.Config{AnthropicKey: testKey, Addr: "127.0.0.1:0", PublicURL: "http://127.0.0.1:8787", AnthropicBaseURL: upS.URL,
		AllowSignup: true, DefaultModel: "claude-opus-5-5",
		AllowedModels: []string{"claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"}}
	if mut != nil {
		mut(&cfg)
	}
	st := storetest.Open(t)
	logs := &syncBuf{}
	s := New(cfg, st, slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	s.params = passwords.Params{Time: 1, Memory: 8, Threads: 1} // cheap hashes keep tests fast
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	e := &env{t: t, s: s, ts: ts, up: up, upS: upS, st: st}
	e.logs = &logs.b
	return e
}

// browser is a cookie-keeping client that does not follow redirects, so tests can read them.
func (e *env) browser() *http.Client {
	jar, _ := cookiejar.New(nil)
	return &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func (e *env) csrf(c *http.Client, page string) string {
	e.t.Helper()
	resp, err := c.Get(e.ts.URL + page)
	if err != nil {
		e.t.Fatal(err)
	}
	resp.Body.Close()
	u, _ := url.Parse(e.ts.URL)
	for _, ck := range c.Jar.Cookies(u) {
		if ck.Name == csrfCookie {
			return ck.Value
		}
	}
	e.t.Fatal("no csrf cookie after GET", page)
	return ""
}

func (e *env) post(c *http.Client, path string, form url.Values) (*http.Response, string) {
	e.t.Helper()
	resp, err := c.PostForm(e.ts.URL+path, form)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, string(b)
}

func (e *env) signup(c *http.Client, email, pw string) *http.Response {
	e.t.Helper()
	tok := e.csrf(c, "/signup")
	resp, _ := e.post(c, "/signup", url.Values{"csrf": {tok}, "email": {email}, "password": {pw}, "confirm": {pw}})
	return resp
}

func pkce() (verifier, challenge string) {
	verifier = randomString(48)
	sum := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(sum[:])
}

func (e *env) authorizeQuery(challenge, redirect string) url.Values {
	return url.Values{"response_type": {"code"}, "client_id": {"hull"}, "redirect_uri": {redirect}, "state": {"st8"},
		"code_challenge": {challenge}, "code_challenge_method": {"S256"}}
}

const loopback = "http://127.0.0.1:51234/callback"

// consent approves the sign-in as the logged-in browser and returns the code from the redirect.
func (e *env) consent(c *http.Client, q url.Values, decision string) (code string, loc *url.URL) {
	e.t.Helper()
	resp, err := c.Get(e.ts.URL + "/oauth/authorize?" + q.Encode())
	if err != nil {
		e.t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		e.t.Fatalf("authorize page status %d", resp.StatusCode)
	}
	form := url.Values{"csrf": {e.csrf(c, "/login")}, "decision": {decision}}
	for k := range q {
		form.Set(k, q.Get(k))
	}
	resp, _ = e.post(c, "/oauth/authorize", form)
	if resp.StatusCode != 302 {
		e.t.Fatalf("consent status %d", resp.StatusCode)
	}
	loc, _ = resp.Location()
	return loc.Query().Get("code"), loc
}

func (e *env) exchange(code, verifier, redirect, client string) (int, map[string]any) {
	e.t.Helper()
	resp, err := http.PostForm(e.ts.URL+"/oauth/token", url.Values{"grant_type": {"authorization_code"}, "code": {code},
		"redirect_uri": {redirect}, "client_id": {client}, "code_verifier": {verifier}})
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	var m map[string]any
	json.NewDecoder(resp.Body).Decode(&m)
	return resp.StatusCode, m
}

// token signs up a fresh account and runs the whole PKCE flow, returning the app token.
func (e *env) token(email string) string {
	e.t.Helper()
	c := e.browser()
	e.signup(c, email, "correct horse battery")
	v, ch := pkce()
	code, _ := e.consent(c, e.authorizeQuery(ch, loopback), "allow")
	status, m := e.exchange(code, v, loopback, "hull")
	if status != 200 {
		e.t.Fatalf("token exchange status %d: %v", status, m)
	}
	return m["access_token"].(string)
}

func (e *env) do(method, path, token string, hdr map[string]string, body string) (*http.Response, string) {
	e.t.Helper()
	req, _ := http.NewRequest(method, e.ts.URL+path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, string(b)
}

func (e *env) usage(email string) store.Usage {
	e.t.Helper()
	u, err := e.st.UserByEmail(email)
	if err != nil {
		e.t.Fatal(err)
	}
	use, _ := e.st.UsageSince(u.ID, e.s.now().AddDate(-1, 0, 0))
	return use
}
