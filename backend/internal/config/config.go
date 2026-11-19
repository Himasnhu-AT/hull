// Package config reads the server's settings from the environment only, so the
// same binary runs unchanged on a laptop and on a host, and no secret ever sits in a file we ship.
package config

import (
	"fmt"
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
}

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
	}
	if v := strings.TrimSpace(getenv("ALLOW_SIGNUP")); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return c, fmt.Errorf("env ALLOW_SIGNUP: %q is not true or false", v)
		}
		c.AllowSignup = b
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
