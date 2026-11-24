package server

import (
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
	"unicode"
)

const (
	waitlistPath      = "/api/waitlist"
	waitlistBodyLimit = 4 << 10
	waitlistPerMinute = 5
	// The bucket refills one request every 12 s (5 a minute), which is what a blocked client is told to wait.
	waitlistRetryAfter = "12"
)

var sourceRE = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

type waitlistRequest struct {
	Email   string `json:"email"`
	Source  string `json:"source"`
	Company string `json:"company"` // honeypot: people never see this field, bots fill it
}

// validEmail is deliberately loose: one @, something before it, a dotted domain, no spaces. The only real test of an address
// is mailing it.
func validEmail(e string) bool {
	if e == "" || len(e) > 254 || strings.Count(e, "@") != 1 {
		return false
	}
	local, domain, _ := strings.Cut(e, "@")
	if local == "" || len(local) > 64 || !strings.Contains(domain, ".") ||
		strings.HasPrefix(domain, ".") || strings.HasSuffix(domain, ".") || strings.Contains(domain, "..") ||
		strings.HasPrefix(domain, "-") || strings.HasSuffix(domain, "-") {
		return false
	}
	for _, r := range e {
		if unicode.IsSpace(r) || unicode.IsControl(r) || strings.ContainsRune("<>(),;:\\\"[]", r) {
			return false
		}
	}
	for _, r := range domain {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '.' || r == '-') {
			return false
		}
	}
	return true
}

// waitlistCORS answers for the site's own origins only and never allows credentials. Vary: Origin is always set so a
// cache cannot hand one origin's answer to another.
func (s *Server) waitlistCORS(w http.ResponseWriter, r *http.Request) {
	w.Header().Add("Vary", "Origin")
	if o := r.Header.Get("Origin"); o != "" && s.cfg.OriginAllowed(o) {
		w.Header().Set("Access-Control-Allow-Origin", o)
		// Retry-After is not a header a page may read from another origin unless it is named here, and the site
		// uses it to say how long to wait after a 429.
		w.Header().Set("Access-Control-Expose-Headers", "Retry-After")
	}
}

func (s *Server) waitlistPreflight(w http.ResponseWriter, r *http.Request) {
	s.waitlistCORS(w, r)
	if w.Header().Get("Access-Control-Allow-Origin") != "" {
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Max-Age", "600")
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) waitlistJoin(w http.ResponseWriter, r *http.Request) {
	s.waitlistCORS(w, r)
	if !s.waitlistLimit.Allow(s.clientIP(r)) {
		w.Header().Set("Retry-After", waitlistRetryAfter)
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "rate_limited"})
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, waitlistBodyLimit))
	var req waitlistRequest
	if err == nil {
		err = json.Unmarshal(body, &req)
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return
	}
	if strings.TrimSpace(req.Company) != "" {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true}) // looks like success to a bot, stores nothing
		return
	}
	email := normEmail(req.Email)
	if !validEmail(email) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_email"})
		return
	}
	source := strings.TrimSpace(req.Source)
	if !sourceRE.MatchString(source) {
		source = ""
	}
	// A repeat sign-up answers the same as a new one, so the form cannot be used to ask who is on the list.
	if _, err := s.st.AddWaitlist(email, source, s.now()); err != nil {
		s.log.Error("waitlist", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server_error"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
