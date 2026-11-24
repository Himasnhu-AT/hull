package config

import (
	"strings"
	"testing"
)

func TestLoadGuards(t *testing.T) {
	c, err := Load(func(string) string { return "" })
	if err != nil || c.DailyTokenBudget != 2_000_000 || c.AIRequestsPerMinute != 30 || len(c.AllowedModels) != 3 || len(c.TrustedProxies) != 0 {
		t.Fatalf("defaults: %+v %v", c, err)
	}
	env := map[string]string{"ALLOWED_MODELS": "claude-a, claude-b", "DAILY_TOKEN_BUDGET": "0", "AI_REQUESTS_PER_MINUTE": "5", "TRUSTED_PROXIES": "10.0.0.0/8, 192.0.2.1"}
	c, err = Load(func(k string) string { return env[k] })
	if err != nil || len(c.AllowedModels) != 2 || c.DailyTokenBudget != 0 || c.AIRequestsPerMinute != 5 || len(c.TrustedProxies) != 2 {
		t.Fatalf("env: %+v %v", c, err)
	}
	for _, bad := range []map[string]string{{"DAILY_TOKEN_BUDGET": "lots"}, {"DAILY_TOKEN_BUDGET": "-1"}, {"AI_REQUESTS_PER_MINUTE": "x"}, {"TRUSTED_PROXIES": "nope"}} {
		if _, err := Load(func(k string) string { return bad[k] }); err == nil {
			t.Errorf("accepted %v", bad)
		}
	}
}

func TestLoadDefaultsAndErrors(t *testing.T) {
	c, err := Load(func(string) string { return "" })
	if err != nil || c.Addr != "127.0.0.1:8787" || c.DataDir != "./data" || c.AnthropicBaseURL != "https://api.anthropic.com" ||
		!c.AllowSignup || c.DefaultModel != "claude-opus-5-5" || c.Secure() {
		t.Fatalf("defaults: %+v %v", c, err)
	}
	env := map[string]string{"ALLOW_SIGNUP": "false", "PUBLIC_URL": "https://hull.example.com/", "ADDR": ":9"}
	c, err = Load(func(k string) string { return env[k] })
	if err != nil || c.AllowSignup || !c.Secure() || c.PublicURL != "https://hull.example.com" || c.Addr != ":9" {
		t.Fatalf("env: %+v %v", c, err)
	}
	if _, err := Load(func(k string) string { return map[string]string{"ALLOW_SIGNUP": "maybe"}[k] }); err == nil {
		t.Error("bad ALLOW_SIGNUP accepted")
	}
	if _, err := Load(func(k string) string { return map[string]string{"PUBLIC_URL": "ftp://x"}[k] }); err == nil {
		t.Error("bad PUBLIC_URL accepted")
	}
}

func TestLoadDatabaseWaitlistAdmin(t *testing.T) {
	c, err := Load(func(string) string { return "" })
	if err != nil || c.DatabaseURL != "" || c.DatabaseSchema != "public" || len(c.SiteOrigins) != 2 || len(c.AdminEmails) != 0 ||
		!c.OriginAllowed("https://marlstudio.com") || !c.OriginAllowed("https://www.marlstudio.com") || c.OriginAllowed("https://evil.example") || c.IsAdmin("a@example.com") {
		t.Fatalf("defaults: %+v %v", c, err)
	}
	env := map[string]string{"DATABASE_URL": "postgres://hull:pw@db.example.com:5432/hull?sslmode=verify-full", "DATABASE_SCHEMA": "hull_app",
		"SITE_ORIGINS": "http://localhost:3000/, https://Site.Example", "ADMIN_EMAILS": " Boss@Example.com ,, b2@example.com"}
	c, err = Load(func(k string) string { return env[k] })
	if err != nil || c.DatabaseSchema != "hull_app" || !c.OriginAllowed("http://localhost:3000") || !c.OriginAllowed("https://site.example") ||
		c.OriginAllowed("https://marlstudio.com") || !c.IsAdmin("BOSS@example.com") || !c.IsAdmin("b2@example.com") || c.IsAdmin("x@example.com") {
		t.Fatalf("env: %+v %v", c, err)
	}
	for _, bad := range []map[string]string{{"DATABASE_URL": "mysql://u:secretpw@h/db"}, {"DATABASE_URL": "not a url secretpw"}, {"DATABASE_SCHEMA": "a;drop"},
		{"SITE_ORIGINS": "https://a.example/path"}, {"SITE_ORIGINS": "ftp://a.example"}} {
		_, err := Load(func(k string) string { return bad[k] })
		if err == nil {
			t.Errorf("accepted %v", bad)
		} else if strings.Contains(err.Error(), "secretpw") {
			t.Errorf("error repeats the database URL: %v", err)
		}
	}
}
