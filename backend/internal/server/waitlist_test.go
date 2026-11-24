package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/marlstudio/hull/backend/internal/config"
	"github.com/marlstudio/hull/backend/internal/ratelimit"
)

func waitlistEnv(t *testing.T) *env {
	return newEnv(t, func(c *config.Config) {
		c.SiteOrigins = []string{"https://marlstudio.com", "https://www.marlstudio.com"}
	})
}

func (e *env) join(body string, origin string) (*http.Response, string) {
	e.t.Helper()
	h := map[string]string{}
	if origin != "" {
		h["Origin"] = origin
	}
	return e.do("POST", "/api/waitlist", "", h, body)
}

func (e *env) waitlistRows() map[string]string {
	e.t.Helper()
	rows := map[string]string{}
	st, err := e.st.AdminStats(e.s.now())
	if err != nil {
		e.t.Fatal(err)
	}
	for _, w := range st.WaitlistNewest {
		rows[w.Email] = w.Source
	}
	return rows
}

func TestWaitlistAccepted(t *testing.T) {
	e := waitlistEnv(t)
	resp, body := e.join(`{"email":"  Ada@Example.COM ","source":"home"}`, "")
	if resp.StatusCode != 200 || strings.TrimSpace(body) != `{"ok":true}` {
		t.Fatalf("status %d %q", resp.StatusCode, body)
	}
	if got := e.waitlistRows(); len(got) != 1 || got["ada@example.com"] != "home" {
		t.Fatalf("rows %v", got)
	}
	// A source with characters outside the allowed set is dropped, not rejected.
	resp, _ = e.join(`{"email":"b@example.com","source":"ho me<script>"}`, "")
	if resp.StatusCode != 200 || e.waitlistRows()["b@example.com"] != "" {
		t.Fatalf("odd source: %d %v", resp.StatusCode, e.waitlistRows())
	}
	resp, _ = e.join(`{"email":"c@example.com"}`, "")
	if resp.StatusCode != 200 || len(e.waitlistRows()) != 3 {
		t.Fatalf("no source: %d", resp.StatusCode)
	}
}

func TestWaitlistDuplicateLooksNew(t *testing.T) {
	e := waitlistEnv(t)
	_, first := e.join(`{"email":"dup@example.com","source":"home"}`, "")
	resp, second := e.join(`{"email":"DUP@example.com","source":"other"}`, "")
	if resp.StatusCode != 200 || first != second {
		t.Fatalf("duplicate answered %d %q, first %q", resp.StatusCode, second, first)
	}
	if got := e.waitlistRows(); len(got) != 1 || got["dup@example.com"] != "home" {
		t.Fatalf("rows %v", got)
	}
}

func TestWaitlistInvalid(t *testing.T) {
	e := waitlistEnv(t)
	e.s.waitlistLimit = ratelimit.New(1000)
	long := strings.Repeat("a", 250) + "@example.com"
	for _, em := range []string{"", "nobody", "a@b", "a b@example.com", "a@@example.com", "a@example..com", "@example.com", "a@.example.com", long, "a@exa mple.com", "a@example.com\nb@example.com"} {
		b, _ := json.Marshal(map[string]string{"email": em})
		resp, body := e.join(string(b), "")
		if resp.StatusCode != 400 || strings.TrimSpace(body) != `{"error":"invalid_email"}` {
			t.Errorf("%q: %d %q", em, resp.StatusCode, body)
		}
	}
	for _, bad := range []string{"not json", "", "[]", "\"x\""} {
		resp, body := e.join(bad, "")
		if resp.StatusCode != 400 || strings.TrimSpace(body) != `{"error":"invalid_request"}` {
			t.Errorf("%q: %d %q", bad, resp.StatusCode, body)
		}
	}
	if resp, body := e.join("null", ""); resp.StatusCode != 400 || strings.TrimSpace(body) != `{"error":"invalid_email"}` {
		t.Errorf("null: %d %q", resp.StatusCode, body)
	}
	if len(e.waitlistRows()) != 0 {
		t.Fatalf("stored %v", e.waitlistRows())
	}
}

func TestWaitlistHoneypot(t *testing.T) {
	e := waitlistEnv(t)
	resp, body := e.join(`{"email":"bot@example.com","company":"Acme"}`, "")
	if resp.StatusCode != 200 || strings.TrimSpace(body) != `{"ok":true}` || len(e.waitlistRows()) != 0 {
		t.Fatalf("%d %q %v", resp.StatusCode, body, e.waitlistRows())
	}
}

func TestWaitlistRateLimit(t *testing.T) {
	e := waitlistEnv(t)
	for i := 0; i < 5; i++ {
		if resp, _ := e.join(`{"email":"x@example.com"}`, ""); resp.StatusCode != 200 {
			t.Fatalf("request %d: %d", i, resp.StatusCode)
		}
	}
	resp, body := e.join(`{"email":"x@example.com"}`, "")
	if resp.StatusCode != 429 || strings.TrimSpace(body) != `{"error":"rate_limited"}` || resp.Header.Get("Retry-After") == "" {
		t.Fatalf("%d %q retry-after %q", resp.StatusCode, body, resp.Header.Get("Retry-After"))
	}
}

func TestWaitlistBodyTooLarge(t *testing.T) {
	e := waitlistEnv(t)
	resp, body := e.join(`{"email":"a@example.com","source":"`+strings.Repeat("x", 5000)+`"}`, "")
	if resp.StatusCode != 400 || strings.TrimSpace(body) != `{"error":"invalid_request"}` || len(e.waitlistRows()) != 0 {
		t.Fatalf("%d %q", resp.StatusCode, body)
	}
}

func TestWaitlistCORS(t *testing.T) {
	e := waitlistEnv(t)
	resp, _ := e.join(`{"email":"a@example.com"}`, "https://marlstudio.com")
	if resp.Header.Get("Access-Control-Allow-Origin") != "https://marlstudio.com" || resp.Header.Get("Vary") != "Origin" || resp.Header.Get("Access-Control-Allow-Credentials") != "" {
		t.Fatalf("allowed origin headers: %v", resp.Header)
	}
	resp, _ = e.join(`{"email":"b@example.com"}`, "https://evil.example")
	for k := range resp.Header {
		if strings.HasPrefix(k, "Access-Control-") {
			t.Errorf("other origin got %s", k)
		}
	}
	if resp.StatusCode != 200 {
		t.Errorf("other origin status %d", resp.StatusCode) // CORS is the browser's check; the server still answers
	}
	// An error carries the headers too, or the site could not read the error code.
	resp, _ = e.join("nope", "https://www.marlstudio.com")
	if resp.StatusCode != 400 || resp.Header.Get("Access-Control-Allow-Origin") != "https://www.marlstudio.com" {
		t.Errorf("error response: %d %v", resp.StatusCode, resp.Header)
	}
	// No other route is opened to the site.
	resp, _ = e.do("GET", "/api/me", "", map[string]string{"Origin": "https://marlstudio.com"}, "")
	if resp.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Error("CORS leaked to /api/me")
	}
}

func TestWaitlistPreflight(t *testing.T) {
	e := waitlistEnv(t)
	hdr := map[string]string{"Origin": "https://marlstudio.com", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"}
	resp, _ := e.do("OPTIONS", "/api/waitlist", "", hdr, "")
	h := resp.Header
	if resp.StatusCode != 204 || h.Get("Access-Control-Allow-Origin") != "https://marlstudio.com" || h.Get("Access-Control-Allow-Methods") != "POST, OPTIONS" ||
		h.Get("Access-Control-Allow-Headers") != "Content-Type" || h.Get("Access-Control-Max-Age") != "600" || h.Get("Access-Control-Allow-Credentials") != "" {
		t.Fatalf("preflight %d %v", resp.StatusCode, h)
	}
	hdr["Origin"] = "https://evil.example"
	resp, _ = e.do("OPTIONS", "/api/waitlist", "", hdr, "")
	for k := range resp.Header {
		if strings.HasPrefix(k, "Access-Control-") {
			t.Errorf("other origin preflight got %s", k)
		}
	}
	// A preflight is not a sign-up and does not use the rate limit.
	for i := 0; i < 10; i++ {
		if resp, _ = e.do("OPTIONS", "/api/waitlist", "", map[string]string{"Origin": "https://marlstudio.com"}, ""); resp.StatusCode != 204 {
			t.Fatalf("preflight %d: %d", i, resp.StatusCode)
		}
	}
}
