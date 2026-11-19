package server

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/marlstudio/hull/backend/internal/config"
)

const (
	fakeClientID = "test-client-id.apps.example.com"
	fakeSecret   = "GOCSPX-TESTSECRET-do-not-leak"
)

// fakeGoogle is a token endpoint that answers with an unsigned id_token built from claims.
type fakeGoogle struct {
	mu     sync.Mutex
	claims map[string]any
	status int
	form   url.Values
	calls  int
	srv    *httptest.Server
}

func b64(v any) string {
	b, _ := json.Marshal(v)
	return base64.RawURLEncoding.EncodeToString(b)
}

func goodClaims(sub, email string) map[string]any {
	return map[string]any{"iss": "https://accounts.google.com", "aud": fakeClientID, "exp": time.Now().Add(time.Hour).Unix(),
		"sub": sub, "email": email, "email_verified": true}
}

func newGoogleEnv(t *testing.T, mut func(*config.Config)) (*env, *fakeGoogle) {
	t.Helper()
	fg := &fakeGoogle{status: 200}
	fg.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		fg.mu.Lock()
		defer fg.mu.Unlock()
		fg.form, fg.calls = r.PostForm, fg.calls+1
		if fg.status != 200 {
			w.WriteHeader(fg.status)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"id_token": b64(map[string]string{"alg": "none"}) + "." + b64(fg.claims) + "."})
	}))
	t.Cleanup(fg.srv.Close)
	e := newEnv(t, func(c *config.Config) {
		c.GoogleClientID, c.GoogleClientSecret = fakeClientID, fakeSecret
		c.GoogleAuthURL, c.GoogleTokenURL = "https://accounts.example.com/auth", fg.srv.URL
		if mut != nil {
			mut(c)
		}
	})
	return e, fg
}

func (fg *fakeGoogle) set(claims map[string]any) { fg.mu.Lock(); fg.claims = claims; fg.mu.Unlock() }

// googleLogin runs start then callback in one browser and returns the callback response and body.
func (e *env) googleLogin(c *http.Client, next string) (*http.Response, string) {
	e.t.Helper()
	resp, err := c.Get(e.ts.URL + "/auth/google/start?next=" + url.QueryEscape(next))
	if err != nil {
		e.t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 302 {
		e.t.Fatalf("start status %d", resp.StatusCode)
	}
	loc, _ := resp.Location()
	return e.callback(c, "?code=abc&state="+url.QueryEscape(loc.Query().Get("state")))
}

func (e *env) callback(c *http.Client, query string) (*http.Response, string) {
	e.t.Helper()
	resp, err := c.Get(e.ts.URL + googleCallbackPath + query)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, string(b)
}

func TestGoogleNotConfigured(t *testing.T) {
	e := newEnv(t, nil)
	c := e.browser()
	for _, path := range []string{"/auth/google/start", googleCallbackPath + "?code=x&state=y"} {
		r, err := c.Get(e.ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(r.Body)
		r.Body.Close()
		if r.StatusCode != 503 || !strings.Contains(string(b), "Google sign-in is not set up on this server") {
			t.Fatalf("%s: %d %s", path, r.StatusCode, b)
		}
	}
	for _, page := range []string{"/login", "/signup"} {
		r, _ := c.Get(e.ts.URL + page)
		b, _ := io.ReadAll(r.Body)
		r.Body.Close()
		if strings.Contains(string(b), "Continue with Google") {
			t.Fatalf("%s shows the Google button without credentials", page)
		}
	}
}

func TestGoogleConfigNeedsBoth(t *testing.T) {
	for _, tc := range []struct {
		env  map[string]string
		want string
	}{
		{map[string]string{"GOOGLE_CLIENT_ID": "a"}, "GOOGLE_CLIENT_SECRET"},
		{map[string]string{"GOOGLE_CLIENT_SECRET": "b"}, "GOOGLE_CLIENT_ID"},
	} {
		_, err := config.Load(func(k string) string { return tc.env[k] })
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%v: got %v, want error naming %s", tc.env, err, tc.want)
		}
	}
	c, err := config.Load(func(k string) string {
		return map[string]string{"GOOGLE_CLIENT_ID": "a", "GOOGLE_CLIENT_SECRET": "b"}[k]
	})
	if err != nil || !c.GoogleEnabled() || c.GoogleAuthURL != config.DefaultGoogleAuthURL || c.GoogleTokenURL != config.DefaultGoogleTokenURL {
		t.Fatalf("both set: %+v %v", c, err)
	}
}

func TestGoogleButtonAndStart(t *testing.T) {
	e, _ := newGoogleEnv(t, nil)
	c := e.browser()
	r, _ := c.Get(e.ts.URL + "/login?next=" + url.QueryEscape("/oauth/authorize?x=1"))
	b, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if !strings.Contains(string(b), "Continue with Google") || !strings.Contains(string(b), "/auth/google/start?next=%2Foauth%2Fauthorize%3Fx%3D1") {
		t.Fatalf("login page lacks the button with next:\n%s", b)
	}
	r, _ = c.Get(e.ts.URL + "/signup")
	b, _ = io.ReadAll(r.Body)
	r.Body.Close()
	if !strings.Contains(string(b), "Continue with Google") {
		t.Fatal("signup page lacks the button")
	}

	resp, err := c.Get(e.ts.URL + "/auth/google/start?next=/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 302 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	loc, _ := resp.Location()
	q := loc.Query()
	if loc.Host != "accounts.example.com" || q.Get("client_id") != fakeClientID ||
		q.Get("redirect_uri") != "http://127.0.0.1:8787/api/v1/auth/google/callback" || q.Get("response_type") != "code" ||
		q.Get("scope") != "openid email profile" || q.Get("prompt") != "select_account" ||
		q.Get("code_challenge_method") != "S256" || q.Get("state") == "" || q.Get("code_challenge") == "" {
		t.Fatalf("bad redirect %s", loc)
	}
	if strings.Contains(loc.String(), fakeSecret) {
		t.Fatal("secret in redirect")
	}
	var ck *http.Cookie
	for _, k := range resp.Cookies() {
		if k.Name == googleCookie {
			ck = k
		}
	}
	if ck == nil || !ck.HttpOnly || ck.SameSite != http.SameSiteLaxMode || ck.MaxAge != 600 {
		t.Fatalf("bad state cookie %+v", ck)
	}
	parts := strings.Split(ck.Value, "|")
	if len(parts) != 3 || parts[0] != q.Get("state") {
		t.Fatal("cookie not bound to state")
	}
	if _, ch := pkceFrom(parts[1]); ch != q.Get("code_challenge") {
		t.Fatal("code_challenge is not S256 of the cookie's verifier")
	}
}

func pkceFrom(verifier string) (string, string) {
	// same S256 as the production code, written out so the test does not just call it
	return verifier, s256(verifier)
}

func TestGoogleCallbackRejectsBadState(t *testing.T) {
	e, fg := newGoogleEnv(t, nil)
	fg.set(goodClaims("sub1", "a@gmail.com"))
	// no cookie at all
	c := e.browser()
	if resp, _ := e.callback(c, "?code=abc&state=zzz"); resp.StatusCode != 400 {
		t.Fatalf("missing cookie: %d", resp.StatusCode)
	}
	// wrong state
	c = e.browser()
	r, _ := c.Get(e.ts.URL + "/auth/google/start")
	r.Body.Close()
	if resp, _ := e.callback(c, "?code=abc&state=wrong"); resp.StatusCode != 400 {
		t.Fatalf("wrong state: %d", resp.StatusCode)
	}
	// the cookie is cleared, so even the right state now fails
	if fg.calls != 0 {
		t.Fatal("token endpoint called on a bad state")
	}
	// missing state param
	c = e.browser()
	r, _ = c.Get(e.ts.URL + "/auth/google/start")
	r.Body.Close()
	if resp, _ := e.callback(c, "?code=abc"); resp.StatusCode != 400 {
		t.Fatalf("no state param: %d", resp.StatusCode)
	}
}

func TestGoogleCallbackErrorParam(t *testing.T) {
	e, _ := newGoogleEnv(t, nil)
	c := e.browser()
	r, _ := c.Get(e.ts.URL + "/auth/google/start")
	r.Body.Close()
	resp, body := e.callback(c, "?error=access_denied")
	if resp.StatusCode != 200 || !strings.Contains(body, "Google sign-in was cancelled") {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
}

func TestGoogleRefusals(t *testing.T) {
	cases := map[string]func(m map[string]any){
		"unverified": func(m map[string]any) { m["email_verified"] = false },
		"wrong aud":  func(m map[string]any) { m["aud"] = "someone-else" },
		"wrong iss":  func(m map[string]any) { m["iss"] = "https://evil.example.com" },
		"expired":    func(m map[string]any) { m["exp"] = time.Now().Add(-time.Minute).Unix() },
		"no sub":     func(m map[string]any) { m["sub"] = "" },
		"no email":   func(m map[string]any) { m["email"] = "" },
	}
	for name, mod := range cases {
		t.Run(name, func(t *testing.T) {
			e, fg := newGoogleEnv(t, nil)
			m := goodClaims("sub1", "a@gmail.com")
			mod(m)
			fg.set(m)
			c := e.browser()
			resp, body := e.googleLogin(c, "/")
			if resp.StatusCode == 303 {
				t.Fatal("signed in")
			}
			if name == "unverified" && !strings.Contains(body, "Google did not confirm that email address") {
				t.Fatalf("message: %s", body)
			}
			if _, err := e.st.UserByEmail("a@gmail.com"); err == nil {
				t.Fatal("account created")
			}
		})
	}
}

func TestGoogleNewAccountSignsIn(t *testing.T) {
	e, fg := newGoogleEnv(t, nil)
	fg.set(goodClaims("sub1", "New.Person@Gmail.com"))
	c := e.browser()
	resp, _ := e.googleLogin(c, "/somewhere?a=1")
	if resp.StatusCode != 303 || resp.Header.Get("Location") != "/somewhere?a=1" {
		t.Fatalf("%d %s", resp.StatusCode, resp.Header.Get("Location"))
	}
	u, err := e.st.UserByEmail("new.person@gmail.com")
	if err != nil || u.GoogleSub != "sub1" || u.PassHash != "" {
		t.Fatalf("%+v %v", u, err)
	}
	// the exchange carried the documented form, including our secret and the verifier
	for k, want := range map[string]string{"code": "abc", "client_id": fakeClientID, "client_secret": fakeSecret,
		"redirect_uri": "http://127.0.0.1:8787/api/v1/auth/google/callback", "grant_type": "authorization_code"} {
		if fg.form.Get(k) != want {
			t.Fatalf("token form %s = %q", k, fg.form.Get(k))
		}
	}
	if len(fg.form.Get("code_verifier")) < 43 {
		t.Fatal("no code_verifier")
	}
	r, _ := c.Get(e.ts.URL + "/")
	b, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if r.StatusCode != 200 || !strings.Contains(string(b), "Signed in with Google") || !strings.Contains(string(b), "new.person@gmail.com") {
		t.Fatalf("account page: %d %s", r.StatusCode, b)
	}
	// a second sign-in finds the same account by sub, even if the email changed
	fg.set(goodClaims("sub1", "renamed@gmail.com"))
	c2 := e.browser()
	if resp, _ := e.googleLogin(c2, "/"); resp.StatusCode != 303 {
		t.Fatalf("second sign-in %d", resp.StatusCode)
	}
	if _, err := e.st.UserByEmail("renamed@gmail.com"); err == nil {
		t.Fatal("made a second account for the same sub")
	}
}

func TestGoogleLinking(t *testing.T) {
	t.Run("gmail links", func(t *testing.T) {
		e, fg := newGoogleEnv(t, nil)
		e.signup(e.browser(), "me@gmail.com", "correct horse battery")
		fg.set(goodClaims("sub9", "me@gmail.com"))
		if resp, _ := e.googleLogin(e.browser(), "/"); resp.StatusCode != 303 {
			t.Fatalf("%d", resp.StatusCode)
		}
		u, _ := e.st.UserByEmail("me@gmail.com")
		if u.GoogleSub != "sub9" || u.PassHash == "" {
			t.Fatalf("not linked or lost the password: %+v", u)
		}
	})
	t.Run("other domain refused", func(t *testing.T) {
		e, fg := newGoogleEnv(t, nil)
		e.signup(e.browser(), "me@corp.example", "correct horse battery")
		fg.set(goodClaims("sub9", "me@corp.example"))
		resp, body := e.googleLogin(e.browser(), "/")
		if resp.StatusCode == 303 || !strings.Contains(body, "An account with this email already exists. Sign in with your password.") {
			t.Fatalf("%d %s", resp.StatusCode, body)
		}
		if u, _ := e.st.UserByEmail("me@corp.example"); u.GoogleSub != "" {
			t.Fatal("linked without proof")
		}
	})
	t.Run("hd links", func(t *testing.T) {
		e, fg := newGoogleEnv(t, nil)
		e.signup(e.browser(), "me@corp.example", "correct horse battery")
		m := goodClaims("sub9", "me@corp.example")
		m["hd"] = "corp.example"
		fg.set(m)
		if resp, _ := e.googleLogin(e.browser(), "/"); resp.StatusCode != 303 {
			t.Fatalf("%d", resp.StatusCode)
		}
		if u, _ := e.st.UserByEmail("me@corp.example"); u.GoogleSub != "sub9" {
			t.Fatal("not linked")
		}
	})
	t.Run("hd for another domain refused", func(t *testing.T) {
		e, fg := newGoogleEnv(t, nil)
		e.signup(e.browser(), "me@corp.example", "correct horse battery")
		m := goodClaims("sub9", "me@corp.example")
		m["hd"] = "other.example"
		fg.set(m)
		if resp, _ := e.googleLogin(e.browser(), "/"); resp.StatusCode == 303 {
			t.Fatal("linked on a mismatched hd")
		}
	})
}

func TestGoogleSignupClosed(t *testing.T) {
	e, fg := newGoogleEnv(t, func(c *config.Config) { c.AllowSignup = false })
	fg.set(goodClaims("sub1", "x@gmail.com"))
	resp, body := e.googleLogin(e.browser(), "/")
	if resp.StatusCode == 303 || !strings.Contains(body, "Sign-ups are closed on this server") {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	if _, err := e.st.UserByEmail("x@gmail.com"); err == nil {
		t.Fatal("created while closed")
	}
	// an existing Google account still signs in
	e2, fg2 := newGoogleEnv(t, nil)
	fg2.set(goodClaims("sub1", "x@gmail.com"))
	e2.googleLogin(e2.browser(), "/")
	e2.s.cfg.AllowSignup = false
	if resp, _ := e2.googleLogin(e2.browser(), "/"); resp.StatusCode != 303 {
		t.Fatalf("existing account blocked: %d", resp.StatusCode)
	}
}

func TestGoogleOnlyAccountCannotPasswordLogin(t *testing.T) {
	e, fg := newGoogleEnv(t, nil)
	fg.set(goodClaims("sub1", "g@gmail.com"))
	e.googleLogin(e.browser(), "/")
	c := e.browser()
	tok := e.csrf(c, "/login")
	for _, pw := range []string{"", "anything at all", "correct horse battery"} {
		resp, body := e.post(c, "/login", url.Values{"csrf": {tok}, "email": {"g@gmail.com"}, "password": {pw}})
		if resp.StatusCode != 401 || !strings.Contains(body, "The email or password is wrong.") {
			t.Fatalf("password %q: %d", pw, resp.StatusCode)
		}
	}
}

func TestGoogleExchangeFailure(t *testing.T) {
	e, fg := newGoogleEnv(t, nil)
	fg.status = 400
	resp, body := e.googleLogin(e.browser(), "/")
	if resp.StatusCode != http.StatusBadGateway || !strings.Contains(body, "Google sign-in failed") {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
}

func TestGoogleThroughAppSignIn(t *testing.T) {
	e, fg := newGoogleEnv(t, nil)
	fg.set(goodClaims("sub1", "app@gmail.com"))
	c := e.browser()
	v, ch := pkce()
	q := e.authorizeQuery(ch, loopback)
	authorize := "/oauth/authorize?" + q.Encode()

	r, _ := c.Get(e.ts.URL + authorize)
	r.Body.Close()
	loc, _ := r.Location()
	if r.StatusCode != 302 || loc.Path != "/login" {
		t.Fatalf("authorize while logged out: %d %v", r.StatusCode, loc)
	}
	next := loc.Query().Get("next")
	page, _ := c.Get(e.ts.URL + loc.RequestURI())
	b, _ := io.ReadAll(page.Body)
	page.Body.Close()
	if !strings.Contains(string(b), "/auth/google/start?next=") {
		t.Fatal("login page does not carry next to the Google button")
	}
	resp, _ := e.googleLogin(c, next)
	if resp.StatusCode != 303 || resp.Header.Get("Location") != next {
		t.Fatalf("callback: %d %s", resp.StatusCode, resp.Header.Get("Location"))
	}
	code, _ := e.consent(c, q, "allow")
	status, m := e.exchange(code, v, loopback, "hull")
	if status != 200 || m["access_token"] == nil {
		t.Fatalf("token exchange: %d %v", status, m)
	}
	if acct, _ := m["account"].(map[string]any); acct["email"] != "app@gmail.com" {
		t.Fatalf("account %v", m["account"])
	}
}

func TestGoogleSecretNeverLeaks(t *testing.T) {
	e, fg := newGoogleEnv(t, nil)
	fg.set(goodClaims("sub1", "s@gmail.com"))
	c := e.browser()
	var all strings.Builder
	get := func(path string) {
		r, err := c.Get(e.ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(r.Body)
		r.Body.Close()
		all.WriteString(r.Header.Get("Location") + r.Header.Get("Set-Cookie") + string(b))
	}
	get("/login")
	_, body := e.googleLogin(c, "/")
	all.WriteString(body)
	get("/")
	fg.status = 500
	_, body = e.googleLogin(e.browser(), "/")
	all.WriteString(body)
	get(googleCallbackPath + "?error=access_denied")
	if strings.Contains(all.String(), fakeSecret) {
		t.Fatal("client secret appeared in a response")
	}
	if strings.Contains(e.logs.String(), fakeSecret) {
		t.Fatal("client secret appeared in the log")
	}
}

func TestGoogleStartRateLimited(t *testing.T) {
	e, _ := newGoogleEnv(t, nil)
	c := e.browser()
	got429 := false
	for i := 0; i < 30; i++ {
		r, _ := c.Get(e.ts.URL + "/auth/google/start")
		r.Body.Close()
		got429 = got429 || r.StatusCode == 429
	}
	if !got429 {
		t.Fatal("no rate limit on /auth/google/start")
	}
}

func TestGoogleStartSanitisesNext(t *testing.T) {
	e, fg := newGoogleEnv(t, nil)
	fg.set(goodClaims("sub1", "n@gmail.com"))
	resp, _ := e.googleLogin(e.browser(), "https://evil.example/")
	if resp.Header.Get("Location") != "/" {
		t.Fatalf("redirected to %s", resp.Header.Get("Location"))
	}
}
