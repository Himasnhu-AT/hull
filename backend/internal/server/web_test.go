package server

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/marlstudio/hull/backend/internal/config"
)

func TestSignupLoginLogoutCSRF(t *testing.T) {
	e := newEnv(t, nil)
	c := e.browser()

	// A POST without the CSRF token is refused.
	resp, _ := e.post(c, "/signup", url.Values{"email": {"a@example.com"}, "password": {"correct horse"}, "confirm": {"correct horse"}})
	if resp.StatusCode != 403 {
		t.Fatalf("signup without csrf: %d", resp.StatusCode)
	}
	// Validation messages.
	tok := e.csrf(c, "/signup")
	for name, f := range map[string]url.Values{
		"short":    {"email": {"a@example.com"}, "password": {"short"}, "confirm": {"short"}},
		"mismatch": {"email": {"a@example.com"}, "password": {"correct horse"}, "confirm": {"correct hors3"}},
		"email":    {"email": {"nope"}, "password": {"correct horse"}, "confirm": {"correct horse"}},
	} {
		f.Set("csrf", tok)
		if resp, _ := e.post(c, "/signup", f); resp.StatusCode != 400 {
			t.Errorf("%s: status %d", name, resp.StatusCode)
		}
	}
	// Good signup logs in and redirects to next, with mixed-case email lowercased.
	resp, _ = e.post(c, "/signup", url.Values{"csrf": {tok}, "email": {"  Ann@Example.COM "}, "password": {"correct horse"}, "confirm": {"correct horse"}, "next": {"/"}})
	if resp.StatusCode != 303 || resp.Header.Get("Location") != "/" {
		t.Fatalf("signup: %d %q", resp.StatusCode, resp.Header.Get("Location"))
	}
	var sess *http.Cookie
	for _, ck := range resp.Cookies() {
		if ck.Name == sessionCookie {
			sess = ck
		}
	}
	if sess == nil || !sess.HttpOnly || sess.SameSite != http.SameSiteLaxMode || sess.Secure {
		t.Fatalf("session cookie wrong: %+v", sess)
	}
	// Account page shows the email.
	r2, err := c.Get(e.ts.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	b := readAll(r2)
	if r2.StatusCode != 200 || !strings.Contains(b, "ann@example.com") || !strings.Contains(b, "input tokens") {
		t.Fatalf("account page: %d %s", r2.StatusCode, b)
	}
	// Duplicate email.
	c2 := e.browser()
	if resp := e.signup(c2, "ann@example.com", "another long one"); resp.StatusCode != 409 {
		t.Errorf("duplicate signup: %d", resp.StatusCode)
	}
	// Logout needs CSRF, then ends the session.
	resp, _ = e.post(c, "/logout", url.Values{})
	if resp.StatusCode != 403 {
		t.Errorf("logout without csrf: %d", resp.StatusCode)
	}
	resp, _ = e.post(c, "/logout", url.Values{"csrf": {tok}})
	if resp.StatusCode != 303 {
		t.Fatalf("logout: %d", resp.StatusCode)
	}
	if r3, _ := c.Get(e.ts.URL + "/"); r3.StatusCode != 303 || r3.Header.Get("Location") != "/login" {
		t.Errorf("account after logout: %d", r3.StatusCode)
	}
	// Login: wrong password and unknown email give the same message; right one works; next is honoured.
	lt := e.csrf(c, "/login")
	_, wrongPw := e.post(c, "/login", url.Values{"csrf": {lt}, "email": {"ann@example.com"}, "password": {"nope nope nope"}})
	resp, noUser := e.post(c, "/login", url.Values{"csrf": {lt}, "email": {"ghost@example.com"}, "password": {"nope nope nope"}})
	if resp.StatusCode != 401 || !strings.Contains(wrongPw, "The email or password is wrong.") || !strings.Contains(noUser, "The email or password is wrong.") {
		t.Errorf("login failures: %d", resp.StatusCode)
	}
	resp, _ = e.post(c, "/login", url.Values{"csrf": {lt}, "email": {"ANN@example.com"}, "password": {"correct horse"}, "next": {"/oauth/authorize?x=1"}})
	if resp.StatusCode != 303 || resp.Header.Get("Location") != "/oauth/authorize?x=1" {
		t.Errorf("login: %d %q", resp.StatusCode, resp.Header.Get("Location"))
	}
	resp, _ = e.post(c, "/login", url.Values{"csrf": {lt}, "email": {"ann@example.com"}, "password": {"correct horse"}, "next": {"https://evil.example/"}})
	if resp.Header.Get("Location") != "/" {
		t.Errorf("open redirect: %q", resp.Header.Get("Location"))
	}
}

func readAll(r *http.Response) string {
	defer r.Body.Close()
	var sb strings.Builder
	buf := make([]byte, 4096)
	for {
		n, err := r.Body.Read(buf)
		sb.Write(buf[:n])
		if err != nil {
			return sb.String()
		}
	}
}

func TestSafeNext(t *testing.T) {
	for in, want := range map[string]string{"": "/", "/a?b=c": "/a?b=c", "//evil.com": "/", "/\\evil.com": "/", "https://x.y": "/", "javascript:1": "/", "/ok\nx": "/"} {
		if got := safeNext(in); got != want {
			t.Errorf("safeNext(%q)=%q want %q", in, got, want)
		}
	}
}

func TestSignupClosed(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.AllowSignup = false })
	c := e.browser()
	if resp := e.signup(c, "a@example.com", "correct horse"); resp.StatusCode != 403 {
		t.Fatalf("closed signup: %d", resp.StatusCode)
	}
}

func TestRateLimit(t *testing.T) {
	e := newEnv(t, nil)
	c := e.browser()
	tok := e.csrf(c, "/login")
	var last int
	for i := 0; i < 12; i++ {
		resp, _ := e.post(c, "/login", url.Values{"csrf": {tok}, "email": {"x@example.com"}, "password": {"whatever whatever"}})
		last = resp.StatusCode
	}
	if last != 429 {
		t.Fatalf("12th login attempt status %d, want 429", last)
	}
}

func TestSecureCookiesOnHTTPS(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.PublicURL = "https://hull.example.com" })
	c := e.browser()
	tok := e.csrf(c, "/signup")
	resp, _ := e.post(c, "/signup", url.Values{"csrf": {tok}, "email": {"s@example.com"}, "password": {"correct horse"}, "confirm": {"correct horse"}})
	for _, ck := range resp.Cookies() {
		if ck.Name == sessionCookie && !ck.Secure {
			t.Fatal("session cookie must be Secure when PUBLIC_URL is https")
		}
	}
}

func TestPKCEFlow(t *testing.T) {
	e := newEnv(t, nil)
	c := e.browser()

	// Not logged in: authorize sends the person to log in and back.
	v, ch := pkce()
	q := e.authorizeQuery(ch, loopback)
	resp, _ := c.Get(e.ts.URL + "/oauth/authorize?" + q.Encode())
	loc := resp.Header.Get("Location")
	if resp.StatusCode != 302 || !strings.HasPrefix(loc, "/login?next=") {
		t.Fatalf("logged-out authorize: %d %q", resp.StatusCode, loc)
	}
	next, _ := url.QueryUnescape(strings.TrimPrefix(loc, "/login?next="))
	if next != "/oauth/authorize?"+q.Encode() {
		t.Fatalf("next lost the request: %q", next)
	}
	e.signup(c, "pk@example.com", "correct horse")

	// Consent page names the app.
	resp, _ = c.Get(e.ts.URL + "/oauth/authorize?" + q.Encode())
	if body := readAll(resp); !strings.Contains(body, "Allow hull to use your account?") {
		t.Fatalf("consent page: %s", body)
	}

	// Allow -> code and state on the redirect; exchange works once.
	code, rl := e.consent(c, q, "allow")
	if rl.Host != "127.0.0.1:51234" || rl.Path != "/callback" || rl.Query().Get("state") != "st8" || code == "" {
		t.Fatalf("redirect %v", rl)
	}
	status, m := e.exchange(code, v, loopback, "hull")
	tok, _ := m["access_token"].(string)
	if status != 200 || !strings.HasPrefix(tok, "hull_") || m["token_type"] != "Bearer" || m["account"].(map[string]any)["email"] != "pk@example.com" {
		t.Fatalf("exchange: %d %v", status, m)
	}
	// Only the hash is stored.
	if _, _, err := e.st.TokenUser(tok, time.Now()); err == nil {
		t.Error("raw token must not be what is stored")
	}
	// Reuse fails with invalid_grant.
	status, m = e.exchange(code, v, loopback, "hull")
	if status != 400 || m["error"] != "invalid_grant" {
		t.Errorf("reuse: %d %v", status, m)
	}

	// Bad verifier burns the code, so the right verifier afterwards fails too.
	v2, ch2 := pkce()
	code2, _ := e.consent(c, e.authorizeQuery(ch2, loopback), "allow")
	if status, m := e.exchange(code2, "wrong-verifier-wrong-verifier-wrong-verifier-123", loopback, "hull"); status != 400 || m["error"] != "invalid_grant" {
		t.Errorf("bad verifier: %d %v", status, m)
	}
	if status, _ := e.exchange(code2, v2, loopback, "hull"); status != 400 {
		t.Errorf("code survived a bad verifier: %d", status)
	}

	// Mismatched redirect_uri and client_id.
	v3, ch3 := pkce()
	code3, _ := e.consent(c, e.authorizeQuery(ch3, loopback), "allow")
	if status, _ := e.exchange(code3, v3, "http://127.0.0.1:51234/other", "hull"); status != 400 {
		t.Errorf("redirect mismatch: %d", status)
	}
	code4, _ := e.consent(c, e.authorizeQuery(ch3, loopback), "allow")
	if status, _ := e.exchange(code4, v3, loopback, "evil"); status != 400 {
		t.Errorf("client mismatch: %d", status)
	}

	// Expired code.
	code5, _ := e.consent(c, e.authorizeQuery(ch3, loopback), "allow")
	e.s.now = func() time.Time { return time.Now().Add(6 * time.Minute) }
	if status, m := e.exchange(code5, v3, loopback, "hull"); status != 400 || !strings.Contains(m["error_description"].(string), "expired") {
		t.Errorf("expired: %d %v", status, m)
	}
	e.s.now = time.Now

	// Cancel -> access_denied with state, no code.
	code6, rl6 := e.consent(c, e.authorizeQuery(ch3, "http://localhost:9/cb?x=1"), "deny")
	if code6 != "" || rl6.Query().Get("error") != "access_denied" || rl6.Query().Get("state") != "st8" || rl6.Query().Get("x") != "1" {
		t.Errorf("deny redirect: %v", rl6)
	}

	// JSON body is accepted too.
	v7, ch7 := pkce()
	code7, _ := e.consent(c, e.authorizeQuery(ch7, loopback), "allow")
	r7, body := e.do("POST", "/oauth/token", "", nil, `{"grant_type":"authorization_code","code":"`+code7+`","redirect_uri":"`+loopback+`","client_id":"hull","code_verifier":"`+v7+`"}`)
	if r7.StatusCode != 200 || !strings.Contains(body, "access_token") {
		t.Errorf("json exchange: %d %s", r7.StatusCode, body)
	}
}

func TestAuthorizeRejectsBadRedirects(t *testing.T) {
	e := newEnv(t, nil)
	c := e.browser()
	e.signup(c, "r@example.com", "correct horse")
	_, ch := pkce()
	for _, ru := range []string{"https://evil.example/cb", "http://evil.example:80/cb", "http://127.0.0.1/cb", "http://127.0.0.1.evil.com:80/cb",
		"http://user@127.0.0.1:80/cb", "myapp://cb", "http://127.0.0.1:80", "javascript:alert(1)", "http://127.0.0.1:80/cb#frag", "//127.0.0.1:80/cb", ""} {
		resp, _ := c.Get(e.ts.URL + "/oauth/authorize?" + e.authorizeQuery(ch, ru).Encode())
		if resp.StatusCode != 400 || resp.Header.Get("Location") != "" {
			t.Errorf("redirect_uri %q: status %d location %q", ru, resp.StatusCode, resp.Header.Get("Location"))
		}
	}
	for name, q := range map[string]url.Values{
		"client": func() url.Values { q := e.authorizeQuery(ch, loopback); q.Set("client_id", "Bad Name!"); return q }(),
		"method": func() url.Values {
			q := e.authorizeQuery(ch, loopback)
			q.Set("code_challenge_method", "plain")
			return q
		}(),
		"response": func() url.Values { q := e.authorizeQuery(ch, loopback); q.Set("response_type", "token"); return q }(),
		"empty":    {},
	} {
		// Logged-out check: the 400 comes before any login redirect.
		resp, _ := e.browser().Get(e.ts.URL + "/oauth/authorize?" + q.Encode())
		if resp.StatusCode != 400 {
			t.Errorf("%s: status %d", name, resp.StatusCode)
		}
	}
	// A forged POST with a bad redirect is refused as well.
	resp, _ := e.post(c, "/oauth/authorize", url.Values{"csrf": {e.csrf(c, "/login")}, "decision": {"allow"}, "response_type": {"code"}, "client_id": {"hull"},
		"redirect_uri": {"https://evil.example/cb"}, "code_challenge": {ch}, "code_challenge_method": {"S256"}})
	if resp.StatusCode != 400 {
		t.Errorf("forged consent: %d", resp.StatusCode)
	}
	// A POST without csrf is refused.
	resp, _ = e.post(c, "/oauth/authorize", e.authorizeQuery(ch, loopback))
	if resp.StatusCode != 403 {
		t.Errorf("consent without csrf: %d", resp.StatusCode)
	}
}

func TestTokenAuthAndRevoke(t *testing.T) {
	e := newEnv(t, nil)
	tok := e.token("me@example.com")

	if resp, body := e.do("GET", "/api/me", tok, nil, ""); resp.StatusCode != 200 || !strings.Contains(body, `"email":"me@example.com"`) || !strings.Contains(body, "created_at") {
		t.Fatalf("/api/me: %d %s", resp.StatusCode, body)
	}
	for _, bad := range []string{"", "hull_nope", "garbage"} {
		if resp, body := e.do("GET", "/api/me", bad, nil, ""); resp.StatusCode != 401 || !strings.Contains(body, `"error"`) {
			t.Errorf("/api/me with %q: %d %s", bad, resp.StatusCode, body)
		}
	}

	// /v1 accepts either header; each API's 401 has its own shape.
	for name, hdr := range map[string]map[string]string{"x-api-key": {"x-api-key": tok}, "bearer": {"Authorization": "Bearer " + tok}} {
		resp, _ := e.do("POST", "/v1/messages", "", hdr, `{"model":"claude-opus-5-5","max_tokens":5,"messages":[{"role":"user","content":"hi"}]}`)
		if resp.StatusCode != 200 {
			t.Errorf("messages with %s: %d", name, resp.StatusCode)
		}
		if resp, _ := e.do("GET", "/v1/models", "", hdr, ""); resp.StatusCode != 200 {
			t.Errorf("models with %s: %d", name, resp.StatusCode)
		}
	}
	_, body := e.do("POST", "/v1/messages", "nope", nil, `{}`)
	if !strings.Contains(body, `"type":"error"`) || !strings.Contains(body, "authentication_error") {
		t.Errorf("anthropic 401 shape: %s", body)
	}
	resp, body := e.do("GET", "/v1/models", "nope", nil, "")
	if resp.StatusCode != 401 || !strings.Contains(body, `"code":"invalid_api_key"`) {
		t.Errorf("openai 401 shape: %d %s", resp.StatusCode, body)
	}
	if e.up.calls == 0 {
		t.Fatal("upstream never called")
	}
	before := e.up.calls
	e.do("POST", "/v1/chat/completions", "nope", nil, `{}`)
	if e.up.calls != before {
		t.Error("an unauthenticated request reached the upstream")
	}

	// Revoke from the account page.
	c := e.browser()
	lt := e.csrf(c, "/login")
	e.post(c, "/login", url.Values{"csrf": {lt}, "email": {"me@example.com"}, "password": {"correct horse battery"}})
	page, _ := c.Get(e.ts.URL + "/")
	b := readAll(page)
	if !strings.Contains(b, "hull") || !strings.Contains(b, "Revoke") {
		t.Fatalf("account page lacks the app: %s", b)
	}
	toks, _ := func() (int, error) {
		u, _ := e.st.UserByEmail("me@example.com")
		l, err := e.st.ListTokens(u.ID)
		return len(l), err
	}()
	if toks != 1 {
		t.Fatalf("tokens listed: %d", toks)
	}
	u, _ := e.st.UserByEmail("me@example.com")
	l, _ := e.st.ListTokens(u.ID)
	resp, _ = e.post(c, "/tokens/"+itoa(l[0].ID)+"/revoke", url.Values{"csrf": {lt}})
	if resp.StatusCode != 303 {
		t.Fatalf("revoke: %d", resp.StatusCode)
	}
	if resp, _ := e.do("GET", "/api/me", tok, nil, ""); resp.StatusCode != 401 {
		t.Errorf("revoked token still works: %d", resp.StatusCode)
	}

	// A second token, revoked from the app itself.
	tok2 := e.token("me2@example.com")
	if resp, _ := e.do("POST", "/api/logout", tok2, nil, ""); resp.StatusCode != 204 {
		t.Errorf("api logout: %d", resp.StatusCode)
	}
	if resp, _ := e.do("GET", "/api/me", tok2, nil, ""); resp.StatusCode != 401 {
		t.Errorf("token works after api logout: %d", resp.StatusCode)
	}
	if resp, _ := e.do("POST", "/api/logout", "", nil, ""); resp.StatusCode != 401 {
		t.Errorf("api logout without token: %d", resp.StatusCode)
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
