package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// errWriter writes an error in the shape the calling API's clients expect.
type errWriter func(w http.ResponseWriter, status int, kind, msg string)

func anthropicErr(w http.ResponseWriter, status int, kind, msg string) {
	writeJSON(w, status, map[string]any{"type": "error", "error": map[string]string{"type": kind, "message": msg}})
}

// openaiErr maps Anthropic's error kinds onto the type and code OpenAI clients branch on.
func openaiErr(w http.ResponseWriter, status int, kind, msg string) {
	typ, code := "invalid_request_error", kind
	switch kind {
	case "authentication_error":
		code = "invalid_api_key"
	case "api_error", "overloaded_error":
		typ = "server_error"
	case "rate_limit_error":
		typ, code = "rate_limit_error", "rate_limit_exceeded"
	}
	writeJSON(w, status, map[string]any{"error": map[string]any{"message": msg, "type": typ, "code": code}})
}

// aiAuth reads the token from x-api-key or Authorization: Bearer and checks it.
func (s *Server) aiAuth(w http.ResponseWriter, r *http.Request, fail errWriter) (userID, tokenID int64, ok bool) {
	tok := r.Header.Get("x-api-key")
	if tok == "" {
		tok = bearer(r)
	}
	if tok != "" {
		if u, id, err := s.st.TokenUser(hashSecret(tok), s.now()); err == nil {
			return u.ID, id, true
		}
	}
	fail(w, http.StatusUnauthorized, "authentication_error", "Missing or invalid API key. Sign in to Hull to get a token.")
	return 0, 0, false
}

// aiReady runs the checks every AI route shares and returns the body.
func (s *Server) aiReady(w http.ResponseWriter, r *http.Request, fail errWriter) (body []byte, userID, tokenID int64, ok bool) {
	userID, tokenID, ok = s.aiAuth(w, r, fail)
	if !ok {
		return
	}
	if s.cfg.AnthropicKey == "" {
		fail(w, http.StatusServiceUnavailable, "api_error", "This server has no ANTHROPIC_API_KEY configured, so it cannot reach the AI.")
		return nil, 0, 0, false
	}
	// Streams outlive the server's short write timeout, so lift it for this request only.
	rc := http.NewResponseController(w)
	rc.SetWriteDeadline(time.Now().Add(15 * time.Minute))
	rc.SetReadDeadline(time.Now().Add(2 * time.Minute))
	r.Body = http.MaxBytesReader(w, r.Body, apiLimit)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		fail(w, http.StatusRequestEntityTooLarge, "request_too_large", "The request body is too large or could not be read (limit 20 MB).")
		return nil, 0, 0, false
	}
	return body, userID, tokenID, true
}

// upstream sends body to Anthropic with the server's key. The caller's own credentials are never forwarded.
func (s *Server) upstream(ctx context.Context, r *http.Request, path string, body []byte) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.cfg.AnthropicBaseURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-api-key", s.cfg.AnthropicKey)
	ver := r.Header.Get("anthropic-version")
	if ver == "" {
		ver = "2023-06-01"
	}
	req.Header.Set("anthropic-version", ver)
	if beta := r.Header.Get("anthropic-beta"); beta != "" {
		req.Header.Set("anthropic-beta", beta)
	}
	return s.client.Do(req)
}

// ---- stream reading ----

// sseTap splits server-sent events as bytes arrive and hands each data line to onData. It only watches:
// the bytes themselves are forwarded by the caller untouched.
type sseTap struct {
	buf    []byte
	onData func(data []byte)
}

func (t *sseTap) Write(p []byte) {
	t.buf = append(t.buf, p...)
	for {
		i := bytes.IndexByte(t.buf, '\n')
		if i < 0 {
			break
		}
		line := bytes.TrimRight(t.buf[:i], "\r")
		if bytes.HasPrefix(line, []byte("data:")) {
			t.onData(bytes.TrimSpace(line[5:]))
		}
		t.buf = t.buf[i+1:]
	}
	if len(t.buf) > 8<<20 {
		t.buf = nil
	}
}

type usageJSON struct {
	InputTokens              int64 `json:"input_tokens"`
	OutputTokens             int64 `json:"output_tokens"`
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
}

// in counts cached prompt tokens too, since they are prompt tokens the person used.
func (u usageJSON) in() int64 {
	return u.InputTokens + u.CacheCreationInputTokens + u.CacheReadInputTokens
}

type usageAcc struct{ in, out int64 }

func (a *usageAcc) feed(data []byte) {
	var ev struct {
		Type    string `json:"type"`
		Message struct {
			Usage usageJSON `json:"usage"`
		} `json:"message"`
		Usage usageJSON `json:"usage"`
	}
	if json.Unmarshal(data, &ev) != nil {
		return
	}
	switch ev.Type {
	case "message_start":
		a.in, a.out = ev.Message.Usage.in(), ev.Message.Usage.OutputTokens
	case "message_delta":
		if o := ev.Usage.OutputTokens; o > 0 {
			a.out = o
		}
		if i := ev.Usage.in(); i > 0 {
			a.in = i
		}
	}
}

func (s *Server) record(userID, tokenID int64, model string, in, out int64) {
	if in == 0 && out == 0 {
		return
	}
	if err := s.st.AddUsage(userID, tokenID, model, in, out, s.now()); err != nil {
		s.log.Error("recording usage", "err", err)
	}
}

func requestModel(body []byte) string {
	var m struct {
		Model string `json:"model"`
	}
	json.Unmarshal(body, &m)
	return m.Model
}

// ---- /v1/messages and count_tokens ----

func (s *Server) handleMessages(w http.ResponseWriter, r *http.Request) {
	s.passthrough(w, r, "/v1/messages", true)
}

func (s *Server) handleCountTokens(w http.ResponseWriter, r *http.Request) {
	s.passthrough(w, r, "/v1/messages/count_tokens", false)
}

func (s *Server) passthrough(w http.ResponseWriter, r *http.Request, path string, bill bool) {
	body, uid, tid, ok := s.aiReady(w, r, anthropicErr)
	if !ok {
		return
	}
	resp, err := s.upstream(r.Context(), r, path, body)
	if err != nil {
		s.log.Error("upstream request failed", "path", path, "err", fmt.Sprint(sanitizeErr(err)))
		anthropicErr(w, http.StatusBadGateway, "api_error", "Could not reach the AI provider.")
		return
	}
	defer resp.Body.Close()
	for _, h := range []string{"Content-Type", "Request-Id", "Retry-After"} {
		if v := resp.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}
	model := requestModel(body)
	acc := &usageAcc{}
	if strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Accel-Buffering", "no")
		w.WriteHeader(resp.StatusCode)
		tap := &sseTap{onData: acc.feed}
		rc := http.NewResponseController(w)
		buf := make([]byte, 16<<10)
		defer func() {
			if bill && resp.StatusCode == 200 {
				s.record(uid, tid, model, acc.in, acc.out)
			}
		}()
		for {
			n, err := resp.Body.Read(buf)
			if n > 0 {
				if _, werr := w.Write(buf[:n]); werr != nil {
					return
				}
				rc.Flush()
				tap.Write(buf[:n])
			}
			if err != nil {
				return
			}
		}
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		anthropicErr(w, http.StatusBadGateway, "api_error", "The AI provider's reply was cut off.")
		return
	}
	if resp.StatusCode == 200 && bill {
		var m struct {
			Usage usageJSON `json:"usage"`
		}
		if json.Unmarshal(data, &m) == nil {
			s.record(uid, tid, model, m.Usage.in(), m.Usage.OutputTokens)
		}
	}
	w.WriteHeader(resp.StatusCode)
	w.Write(data)
}

// sanitizeErr keeps the cause (timeout, refused) but drops any URL text from net errors.
func sanitizeErr(err error) string {
	if err == nil {
		return ""
	}
	if strings.Contains(err.Error(), "context canceled") {
		return "client went away"
	}
	if ue, ok := err.(interface{ Unwrap() error }); ok && ue.Unwrap() != nil {
		return ue.Unwrap().Error()
	}
	return err.Error()
}

func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := s.aiAuth(w, r, openaiErr); !ok {
		return
	}
	data := []map[string]any{}
	for _, id := range []string{"claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"} {
		data = append(data, map[string]any{"id": id, "object": "model", "created": 0, "owned_by": "anthropic"})
	}
	writeJSON(w, 200, map[string]any{"object": "list", "data": data})
}
