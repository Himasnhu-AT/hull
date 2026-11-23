package server

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/marlstudio/hull/backend/internal/config"
)

const okBody = `{"model":"claude-sonnet-5-5","max_tokens":5,"messages":[{"role":"user","content":"hi"}]}`

func TestModelAllowlist(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.AllowedModels = []string{"claude-sonnet-5-5"} })
	tok := e.token("m@example.com")
	if resp, body := e.do("POST", "/v1/messages", tok, nil, okBody); resp.StatusCode != 200 {
		t.Fatalf("allowed model refused: %d %s", resp.StatusCode, body)
	}
	calls := e.up.calls
	resp, body := e.do("POST", "/v1/messages", tok, nil, strings.Replace(okBody, "sonnet", "haiku", 1))
	if resp.StatusCode != 400 || !strings.Contains(body, "not available") || e.up.calls != calls {
		t.Errorf("unlisted model reached upstream or was not refused: %d %s", resp.StatusCode, body)
	}
	if resp, _ = e.do("POST", "/v1/messages", tok, nil, strings.Replace(okBody, "claude-sonnet-5-5", "anything-else", 1)); resp.StatusCode != 400 {
		t.Errorf("unknown model: %d", resp.StatusCode)
	}
	// Chat completions: a non-claude name means the default (always allowed); a claude name must be on the list.
	if resp, body = e.do("POST", "/v1/chat/completions", tok, nil, `{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`); resp.StatusCode != 200 {
		t.Errorf("default-mapped model: %d %s", resp.StatusCode, body)
	}
	if resp, _ = e.do("POST", "/v1/chat/completions", tok, nil, `{"model":"claude-haiku-5-5","messages":[{"role":"user","content":"hi"}]}`); resp.StatusCode != 400 {
		t.Errorf("unlisted claude model on chat: %d", resp.StatusCode)
	}
}

func TestDailyTokenBudget(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.DailyTokenBudget = 30 }) // each fake reply uses 11 + 7 = 18
	tok := e.token("b@example.com")
	for i, want := range []int{200, 200, 429} {
		resp, body := e.do("POST", "/v1/messages", tok, nil, okBody)
		if resp.StatusCode != want {
			t.Fatalf("call %d: %d %s, want %d", i, resp.StatusCode, body, want)
		}
		if want == 429 && (!strings.Contains(body, "daily token budget") || resp.Header.Get("Retry-After") == "") {
			t.Errorf("budget answer: %s %v", body, resp.Header)
		}
	}
	calls := e.up.calls
	if resp, _ := e.do("POST", "/v1/chat/completions", tok, nil, `{"messages":[{"role":"user","content":"hi"}]}`); resp.StatusCode != 429 || e.up.calls != calls {
		t.Errorf("chat past budget: %d", resp.StatusCode)
	}
	// Another user has their own budget; the next UTC day starts a new one.
	other := e.token("b2@example.com")
	if resp, _ := e.do("POST", "/v1/messages", other, nil, okBody); resp.StatusCode != 200 {
		t.Errorf("a second user shares the budget: %d", resp.StatusCode)
	}
	e.s.now = func() time.Time { return time.Now().Add(25 * time.Hour) }
	if resp, _ := e.do("POST", "/v1/messages", tok, nil, okBody); resp.StatusCode != 200 {
		t.Errorf("budget did not reset the next day: %d", resp.StatusCode)
	}
}

func TestBudgetOffWithZero(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.DailyTokenBudget = 0; c.AIRequestsPerMinute = 0 })
	tok := e.token("z@example.com")
	for i := 0; i < 5; i++ {
		if resp, _ := e.do("POST", "/v1/messages", tok, nil, okBody); resp.StatusCode != 200 {
			t.Fatalf("call %d refused with caps off: %d", i, resp.StatusCode)
		}
	}
}

func TestPerUserRequestRate(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.AIRequestsPerMinute = 2; c.DailyTokenBudget = 0 })
	tok := e.token("r@example.com")
	got := []int{}
	for i := 0; i < 3; i++ {
		resp, _ := e.do("POST", "/v1/messages", tok, nil, okBody)
		got = append(got, resp.StatusCode)
	}
	if got[0] != 200 || got[1] != 200 || got[2] != 429 {
		t.Errorf("statuses %v, want 200 200 429", got)
	}
	if resp, _ := e.do("POST", "/v1/messages", e.token("r2@example.com"), nil, okBody); resp.StatusCode != 200 {
		t.Errorf("another user was limited: %d", resp.StatusCode)
	}
}

func TestClientIPTrustedProxies(t *testing.T) {
	mk := func(proxies ...string) *Server {
		var ps []netip.Prefix
		for _, p := range proxies {
			ps = append(ps, netip.MustParsePrefix(p))
		}
		return &Server{cfg: config.Config{TrustedProxies: ps}}
	}
	req := func(remote, xff string) *http.Request {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = remote
		if xff != "" {
			r.Header.Set("X-Forwarded-For", xff)
		}
		return r
	}
	for _, c := range []struct {
		name, remote, xff string
		proxies           []string
		want              string
	}{
		{"no proxies configured: header ignored", "203.0.113.9:1000", "1.2.3.4", nil, "203.0.113.9"},
		{"caller is not a trusted proxy: header ignored", "203.0.113.9:1000", "1.2.3.4", []string{"10.0.0.0/8"}, "203.0.113.9"},
		{"trusted proxy: the client it saw", "10.0.0.5:1000", "198.51.100.7", []string{"10.0.0.0/8"}, "198.51.100.7"},
		{"a forged first entry is passed over", "10.0.0.5:1000", "6.6.6.6, 198.51.100.7", []string{"10.0.0.0/8"}, "198.51.100.7"},
		{"a chain of our proxies is skipped", "10.0.0.5:1000", "198.51.100.7, 10.0.0.9", []string{"10.0.0.0/8"}, "198.51.100.7"},
		{"a malformed entry falls back to the proxy", "10.0.0.5:1000", "not-an-ip", []string{"10.0.0.0/8"}, "10.0.0.5"},
		{"no header from a trusted proxy", "10.0.0.5:1000", "", []string{"10.0.0.0/8"}, "10.0.0.5"},
	} {
		if got := mk(c.proxies...).clientIP(req(c.remote, c.xff)); got != c.want {
			t.Errorf("%s: got %s, want %s", c.name, got, c.want)
		}
	}
}
