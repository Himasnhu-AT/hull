// Package config reads the server's settings from the environment only, so the
// same binary runs unchanged on a laptop and on a host, and no secret ever sits in a file we ship.
package config

import (
	"fmt"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
)

// Config holds every setting. AnthropicKey is a secret: never log or print it.
type Config struct {
	AnthropicKey     string
	Addr             string
	DataDir          string
	PublicURL        string
	AnthropicBaseURL string
	AllowSignup      bool
	DefaultModel     string

	// AllowedModels are the claude-* names the AI routes forward; any other name is refused (chat completions still
	// maps non-claude names such as gpt-4o to DefaultModel). DefaultModel is always allowed.
	AllowedModels []string
	// DailyTokenBudget is the most input plus output tokens one user may use per UTC day. 0 means no cap.
	DailyTokenBudget int64
	// AIRequestsPerMinute caps AI requests per user, with a burst of the same size. 0 means no cap.
	AIRequestsPerMinute int
	// TrustedProxies are the addresses whose X-Forwarded-For header is believed (the reverse proxy in front of this server).
	TrustedProxies []netip.Prefix

	// Google sign-in is on only when both are set. The secret must never be logged or printed.
	GoogleClientID     string
	GoogleClientSecret string
	// Google's endpoints are fields so tests can point them at a fake; the environment cannot change them.
	GoogleAuthURL  string
	GoogleTokenURL string
}

const (
	DefaultGoogleAuthURL  = "https://accounts.google.com/o/oauth2/v2/auth"
	DefaultGoogleTokenURL = "https://oauth2.googleapis.com/token"
)

// GoogleEnabled reports whether the Google sign-in routes and button are on.
func (c Config) GoogleEnabled() bool { return c.GoogleClientID != "" && c.GoogleClientSecret != "" }

// Load builds a Config from getenv (os.Getenv in production, a map in tests).
func Load(getenv func(string) string) (Config, error) {
	def := func(key, fallback string) string {
		if v := strings.TrimSpace(getenv(key)); v != "" {
			return v
		}
		return fallback
	}
	c := Config{
		AnthropicKey:     strings.TrimSpace(getenv("ANTHROPIC_API_KEY")),
		Addr:             def("ADDR", "127.0.0.1:8787"),
		DataDir:          def("DATA_DIR", "./data"),
		PublicURL:        strings.TrimRight(def("PUBLIC_URL", "http://127.0.0.1:8787"), "/"),
		AnthropicBaseURL: strings.TrimRight(def("ANTHROPIC_BASE_URL", "https://api.anthropic.com"), "/"),
		DefaultModel:     def("DEFAULT_MODEL", "claude-opus-5-5"),
		AllowSignup:      true,

		DailyTokenBudget:    2_000_000,
		AIRequestsPerMinute: 30,

		GoogleClientID:     strings.TrimSpace(getenv("GOOGLE_CLIENT_ID")),
		GoogleClientSecret: strings.TrimSpace(getenv("GOOGLE_CLIENT_SECRET")),
		GoogleAuthURL:      DefaultGoogleAuthURL,
		GoogleTokenURL:     DefaultGoogleTokenURL,
	}
	// One half alone is a mistake that would silently leave the button off, so stop at startup.
	if c.GoogleClientID == "" && c.GoogleClientSecret != "" {
		return c, fmt.Errorf("env GOOGLE_CLIENT_ID: not set, but GOOGLE_CLIENT_SECRET is; set both or neither")
	}
	if c.GoogleClientID != "" && c.GoogleClientSecret == "" {
		return c, fmt.Errorf("env GOOGLE_CLIENT_SECRET: not set, but GOOGLE_CLIENT_ID is; set both or neither")
	}
	if v := strings.TrimSpace(getenv("ALLOW_SIGNUP")); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return c, fmt.Errorf("env ALLOW_SIGNUP: %q is not true or false", v)
		}
		c.AllowSignup = b
	}
	c.AllowedModels = []string{"claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"}
	if v := strings.TrimSpace(getenv("ALLOWED_MODELS")); v != "" {
		c.AllowedModels = nil
		for _, m := range strings.Split(v, ",") {
			if m = strings.TrimSpace(m); m != "" {
				c.AllowedModels = append(c.AllowedModels, m)
			}
		}
	}
	for _, kv := range []struct {
		key string
		dst *int64
	}{{"DAILY_TOKEN_BUDGET", &c.DailyTokenBudget}} {
		if v := strings.TrimSpace(getenv(kv.key)); v != "" {
			n, err := strconv.ParseInt(v, 10, 64)
			if err != nil || n < 0 {
				return c, fmt.Errorf("env %s: %q is not a whole number of tokens, 0 or more", kv.key, v)
			}
			*kv.dst = n
		}
	}
	if v := strings.TrimSpace(getenv("AI_REQUESTS_PER_MINUTE")); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			return c, fmt.Errorf("env AI_REQUESTS_PER_MINUTE: %q is not a whole number, 0 or more", v)
		}
		c.AIRequestsPerMinute = n
	}
	for _, p := range strings.Split(getenv("TRUSTED_PROXIES"), ",") {
		if p = strings.TrimSpace(p); p == "" {
			continue
		}
		pre, err := netip.ParsePrefix(p)
		if err != nil {
			a, aerr := netip.ParseAddr(p)
			if aerr != nil {
				return c, fmt.Errorf("env TRUSTED_PROXIES: %q is not an IP address or CIDR range", p)
			}
			pre = netip.PrefixFrom(a, a.BitLen())
		}
		c.TrustedProxies = append(c.TrustedProxies, pre.Masked())
	}
	for _, kv := range [][2]string{{"PUBLIC_URL", c.PublicURL}, {"ANTHROPIC_BASE_URL", c.AnthropicBaseURL}} {
		u, err := url.Parse(kv[1])
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return c, fmt.Errorf("env %s: %q is not an http(s) URL", kv[0], kv[1])
		}
	}
	return c, nil
}

// Secure reports whether cookies must carry the Secure flag.
func (c Config) Secure() bool { return strings.HasPrefix(c.PublicURL, "https://") }
