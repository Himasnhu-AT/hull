package config

import "testing"

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
