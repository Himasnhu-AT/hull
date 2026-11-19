package config

import "testing"

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
