package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// ---- OpenAI request -> Anthropic request ----

type oaiRequest struct {
	Model               string          `json:"model"`
	Messages            []oaiMessage    `json:"messages"`
	Tools               []oaiTool       `json:"tools"`
	ToolChoice          json.RawMessage `json:"tool_choice"`
	MaxTokens           *int            `json:"max_tokens"`
	MaxCompletionTokens *int            `json:"max_completion_tokens"`
	Temperature         *float64        `json:"temperature"`
	TopP                *float64        `json:"top_p"`
	Stop                json.RawMessage `json:"stop"`
	Stream              bool            `json:"stream"`
	StreamOptions       *struct {
		IncludeUsage bool `json:"include_usage"`
	} `json:"stream_options"`
}

type oaiMessage struct {
	Role       string          `json:"role"`
	Content    json.RawMessage `json:"content"`
	ToolCalls  []oaiToolCall   `json:"tool_calls"`
	ToolCallID string          `json:"tool_call_id"`
}

type oaiToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type oaiTool struct {
	Type     string `json:"type"`
	Function struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		Parameters  json.RawMessage `json:"parameters"`
	} `json:"function"`
}

type anthMsg struct {
	Role    string `json:"role"`
	Content []any  `json:"content"`
}

type anthReq struct {
	Model         string    `json:"model"`
	MaxTokens     int       `json:"max_tokens"`
	System        string    `json:"system,omitempty"`
	Messages      []anthMsg `json:"messages"`
	Tools         []any     `json:"tools,omitempty"`
	ToolChoice    any       `json:"tool_choice,omitempty"`
	Temperature   *float64  `json:"temperature,omitempty"`
	TopP          *float64  `json:"top_p,omitempty"`
	StopSequences []string  `json:"stop_sequences,omitempty"`
	Stream        bool      `json:"stream,omitempty"`
}

// contentParts reads an OpenAI content field (string, array of parts, or null) into Anthropic blocks.
func contentParts(raw json.RawMessage) ([]any, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var str string
	if json.Unmarshal(raw, &str) == nil {
		if str == "" {
			return nil, nil
		}
		return []any{map[string]any{"type": "text", "text": str}}, nil
	}
	var parts []struct {
		Type     string `json:"type"`
		Text     string `json:"text"`
		ImageURL struct {
			URL string `json:"url"`
		} `json:"image_url"`
	}
	if err := json.Unmarshal(raw, &parts); err != nil {
		return nil, errors.New("content must be a string or an array of parts")
	}
	var out []any
	for i, p := range parts {
		switch p.Type {
		case "text":
			if p.Text != "" {
				out = append(out, map[string]any{"type": "text", "text": p.Text})
			}
		case "image_url":
			u := p.ImageURL.URL
			if rest, ok := strings.CutPrefix(u, "data:"); ok {
				meta, data, found := strings.Cut(rest, ",")
				mime, enc, _ := strings.Cut(meta, ";")
				if !found || enc != "base64" || mime == "" {
					return nil, fmt.Errorf("content[%d]: image_url must be a base64 data: URL or an http(s) URL", i)
				}
				out = append(out, map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": mime, "data": data}})
			} else if strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "http://") {
				out = append(out, map[string]any{"type": "image", "source": map[string]any{"type": "url", "url": u}})
			} else {
				return nil, fmt.Errorf("content[%d]: image_url must be a base64 data: URL or an http(s) URL", i)
			}
		default:
			return nil, fmt.Errorf("content[%d]: unsupported part type %q", i, p.Type)
		}
	}
	return out, nil
}

func textOf(raw json.RawMessage) (string, error) {
	blocks, err := contentParts(raw)
	if err != nil {
		return "", err
	}
	var sb []string
	for _, b := range blocks {
		if m := b.(map[string]any); m["type"] == "text" {
			sb = append(sb, m["text"].(string))
		}
	}
	return strings.Join(sb, "\n"), nil
}

func (s *Server) toAnthropic(o oaiRequest) (anthReq, error) {
	a := anthReq{Model: o.Model, MaxTokens: 8192, Temperature: o.Temperature, TopP: o.TopP, Stream: o.Stream}
	if !strings.HasPrefix(a.Model, "claude-") {
		// OpenAI clients send names like gpt-4o; any other name means "the default model".
		a.Model = s.cfg.DefaultModel
	}
	if o.MaxCompletionTokens != nil {
		a.MaxTokens = *o.MaxCompletionTokens
	} else if o.MaxTokens != nil {
		a.MaxTokens = *o.MaxTokens
	}
	if a.MaxTokens < 1 {
		return a, errors.New("max_tokens must be at least 1")
	}
	if len(o.Stop) > 0 && string(o.Stop) != "null" {
		var one string
		var many []string
		if json.Unmarshal(o.Stop, &one) == nil {
			a.StopSequences = []string{one}
		} else if json.Unmarshal(o.Stop, &many) == nil {
			a.StopSequences = many
		} else {
			return a, errors.New("stop must be a string or an array of strings")
		}
	}
	var system []string
	for i, m := range o.Messages {
		role := m.Role
		var blocks []any
		switch role {
		case "system", "developer":
			t, err := textOf(m.Content)
			if err != nil {
				return a, fmt.Errorf("messages[%d]: %w", i, err)
			}
			if t != "" {
				system = append(system, t)
			}
			continue
		case "user":
			b, err := contentParts(m.Content)
			if err != nil {
				return a, fmt.Errorf("messages[%d]: %w", i, err)
			}
			blocks = b
		case "assistant":
			b, err := contentParts(m.Content)
			if err != nil {
				return a, fmt.Errorf("messages[%d]: %w", i, err)
			}
			blocks = b
			for _, tc := range m.ToolCalls {
				var in json.RawMessage = json.RawMessage("{}")
				if args := strings.TrimSpace(tc.Function.Arguments); args != "" {
					var probe map[string]any
					if json.Unmarshal([]byte(args), &probe) != nil {
						return a, fmt.Errorf("messages[%d]: tool call %q arguments are not a JSON object", i, tc.ID)
					}
					in = json.RawMessage(args)
				}
				blocks = append(blocks, map[string]any{"type": "tool_use", "id": tc.ID, "name": tc.Function.Name, "input": in})
			}
		case "tool":
			t, err := textOf(m.Content)
			if err != nil {
				return a, fmt.Errorf("messages[%d]: %w", i, err)
			}
			if m.ToolCallID == "" {
				return a, fmt.Errorf("messages[%d]: tool message needs tool_call_id", i)
			}
			blocks = []any{map[string]any{"type": "tool_result", "tool_use_id": m.ToolCallID, "content": t}}
			role = "user"
		default:
			return a, fmt.Errorf("messages[%d]: unsupported role %q", i, m.Role)
		}
		if len(blocks) == 0 {
			continue
		}
		// Anthropic needs strictly alternating roles, so neighbours with the same role become one message.
		if n := len(a.Messages); n > 0 && a.Messages[n-1].Role == role {
			a.Messages[n-1].Content = append(a.Messages[n-1].Content, blocks...)
		} else {
			a.Messages = append(a.Messages, anthMsg{Role: role, Content: blocks})
		}
	}
	if len(a.Messages) == 0 {
		return a, errors.New("messages must contain at least one user or assistant message")
	}
	a.System = strings.Join(system, "\n\n")
	for i, t := range o.Tools {
		if t.Type != "function" || t.Function.Name == "" {
			return a, fmt.Errorf("tools[%d]: only function tools with a name are supported", i)
		}
		schema := t.Function.Parameters
		if len(bytes.TrimSpace(schema)) == 0 || string(bytes.TrimSpace(schema)) == "null" {
			schema = json.RawMessage(`{"type":"object","properties":{}}`)
		}
		tool := map[string]any{"name": t.Function.Name, "input_schema": schema}
		if t.Function.Description != "" {
			tool["description"] = t.Function.Description
		}
		a.Tools = append(a.Tools, tool)
	}
	if len(o.ToolChoice) > 0 && string(o.ToolChoice) != "null" {
		var mode string
		var obj struct {
			Function struct {
				Name string `json:"name"`
			} `json:"function"`
		}
		switch {
		case json.Unmarshal(o.ToolChoice, &mode) == nil:
			switch mode {
			case "auto":
				a.ToolChoice = map[string]any{"type": "auto"}
			case "none":
				a.ToolChoice = map[string]any{"type": "none"}
			case "required":
				a.ToolChoice = map[string]any{"type": "any"}
			default:
				return a, fmt.Errorf("tool_choice %q is not supported", mode)
			}
		case json.Unmarshal(o.ToolChoice, &obj) == nil && obj.Function.Name != "":
			a.ToolChoice = map[string]any{"type": "tool", "name": obj.Function.Name}
		default:
			return a, errors.New("tool_choice must be auto, none, required or {type:function,function:{name}}")
		}
		if len(a.Tools) == 0 {
			a.ToolChoice = nil
		}
	}
	return a, nil
}

// ---- Anthropic response -> OpenAI response ----

func finishReason(stop string) any {
	switch stop {
	case "end_turn", "stop_sequence", "pause_turn":
		return "stop"
	case "max_tokens":
		return "length"
	case "tool_use":
		return "tool_calls"
	case "":
		return nil
	}
	return "stop"
}

func chatID(anthropicID string) string { return "chatcmpl-" + strings.TrimPrefix(anthropicID, "msg_") }

func oaiUsage(u usageJSON) map[string]any {
	in := u.in()
	return map[string]any{"prompt_tokens": in, "completion_tokens": u.OutputTokens, "total_tokens": in + u.OutputTokens}
}

func (s *Server) handleChat(w http.ResponseWriter, r *http.Request) {
	body, uid, tid, ok := s.aiReady(w, r, openaiErr)
	if !ok {
		return
	}
	var o oaiRequest
	if err := json.Unmarshal(body, &o); err != nil {
		openaiErr(w, 400, "invalid_request_error", "The request body is not valid JSON.")
		return
	}
	a, err := s.toAnthropic(o)
	if err != nil {
		openaiErr(w, 400, "invalid_request_error", err.Error())
		return
	}
	payload, _ := json.Marshal(a)
	resp, err := s.upstream(r.Context(), r, "/v1/messages", payload)
	if err != nil {
		s.log.Error("upstream request failed", "path", "/v1/chat/completions", "err", sanitizeErr(err))
		openaiErr(w, http.StatusBadGateway, "api_error", "Could not reach the AI provider.")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		s.upstreamError(w, resp)
		return
	}
	if a.Stream {
		s.chatStream(w, resp, a.Model, o.StreamOptions != nil && o.StreamOptions.IncludeUsage, uid, tid)
		return
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		openaiErr(w, http.StatusBadGateway, "api_error", "The AI provider's reply was cut off.")
		return
	}
	var m struct {
		ID      string `json:"id"`
		Model   string `json:"model"`
		Content []struct {
			Type  string          `json:"type"`
			Text  string          `json:"text"`
			ID    string          `json:"id"`
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
		} `json:"content"`
		StopReason string    `json:"stop_reason"`
		Usage      usageJSON `json:"usage"`
	}
	if err := json.Unmarshal(data, &m); err != nil {
		openaiErr(w, http.StatusBadGateway, "api_error", "The AI provider sent a reply that could not be read.")
		return
	}
	var text strings.Builder
	var calls []any
	for _, c := range m.Content {
		switch c.Type {
		case "text":
			text.WriteString(c.Text)
		case "tool_use":
			args := string(c.Input)
			if args == "" {
				args = "{}"
			}
			calls = append(calls, map[string]any{"id": c.ID, "type": "function", "function": map[string]any{"name": c.Name, "arguments": args}})
		}
	}
	msg := map[string]any{"role": "assistant", "content": nil}
	if text.Len() > 0 || len(calls) == 0 {
		msg["content"] = text.String()
	}
	if len(calls) > 0 {
		msg["tool_calls"] = calls
	}
	s.record(uid, tid, a.Model, m.Usage.in(), m.Usage.OutputTokens)
	writeJSON(w, 200, map[string]any{"id": chatID(m.ID), "object": "chat.completion", "created": s.now().Unix(), "model": m.Model,
		"choices": []any{map[string]any{"index": 0, "message": msg, "finish_reason": finishReason(m.StopReason)}}, "usage": oaiUsage(m.Usage)})
}

// upstreamError turns Anthropic's error body into OpenAI's, keeping the status code.
func (s *Server) upstreamError(w http.ResponseWriter, resp *http.Response) {
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var e struct {
		Error struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"error"`
	}
	json.Unmarshal(data, &e)
	if e.Error.Message == "" {
		e.Error.Message = fmt.Sprintf("The AI provider answered with status %d.", resp.StatusCode)
	}
	if e.Error.Type == "" {
		e.Error.Type = "api_error"
	}
	if v := resp.Header.Get("Retry-After"); v != "" {
		w.Header().Set("Retry-After", v)
	}
	openaiErr(w, resp.StatusCode, e.Error.Type, e.Error.Message)
}

// ---- streaming ----

func (s *Server) chatStream(w http.ResponseWriter, resp *http.Response, model string, includeUsage bool, uid, tid int64) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)
	rc := http.NewResponseController(w)

	var out bytes.Buffer
	var u usageJSON
	id, created, finished, doneSent := "chatcmpl-"+randomString(12), s.now().Unix(), false, false
	toolIndex := map[int]int{} // Anthropic content block index -> OpenAI tool_calls index
	chunk := func(delta map[string]any, finish any) {
		b, _ := json.Marshal(map[string]any{"id": id, "object": "chat.completion.chunk", "created": created, "model": model,
			"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}}})
		out.WriteString("data: ")
		out.Write(b)
		out.WriteString("\n\n")
	}
	done := func() {
		if !doneSent {
			out.WriteString("data: [DONE]\n\n")
			doneSent = true
		}
	}
	recorded := false
	rec := func() { // once, and before the last bytes go out, so a client that reads to the end sees its usage
		if !recorded {
			recorded = true
			s.record(uid, tid, model, u.in(), u.OutputTokens)
		}
	}
	tap := &sseTap{onData: func(data []byte) {
		var ev struct {
			Type    string `json:"type"`
			Index   int    `json:"index"`
			Message struct {
				ID    string    `json:"id"`
				Model string    `json:"model"`
				Usage usageJSON `json:"usage"`
			} `json:"message"`
			ContentBlock struct {
				Type string `json:"type"`
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"content_block"`
			Delta struct {
				Type        string `json:"type"`
				Text        string `json:"text"`
				PartialJSON string `json:"partial_json"`
				StopReason  string `json:"stop_reason"`
			} `json:"delta"`
			Usage usageJSON `json:"usage"`
			Error struct {
				Type    string `json:"type"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(data, &ev) != nil {
			return
		}
		switch ev.Type {
		case "message_start":
			u = ev.Message.Usage
			if ev.Message.ID != "" {
				id = chatID(ev.Message.ID)
			}
			if ev.Message.Model != "" {
				model = ev.Message.Model
			}
			chunk(map[string]any{"role": "assistant", "content": ""}, nil)
		case "content_block_start":
			if ev.ContentBlock.Type == "tool_use" {
				n := len(toolIndex)
				toolIndex[ev.Index] = n
				chunk(map[string]any{"tool_calls": []any{map[string]any{"index": n, "id": ev.ContentBlock.ID, "type": "function",
					"function": map[string]any{"name": ev.ContentBlock.Name, "arguments": ""}}}}, nil)
			}
		case "content_block_delta":
			switch ev.Delta.Type {
			case "text_delta":
				chunk(map[string]any{"content": ev.Delta.Text}, nil)
			case "input_json_delta":
				if n, ok := toolIndex[ev.Index]; ok {
					chunk(map[string]any{"tool_calls": []any{map[string]any{"index": n, "function": map[string]any{"arguments": ev.Delta.PartialJSON}}}}, nil)
				}
			}
		case "message_delta":
			if ev.Usage.OutputTokens > 0 {
				u.OutputTokens = ev.Usage.OutputTokens
			}
			if i := ev.Usage.in(); i > 0 {
				u = usageJSON{InputTokens: i, OutputTokens: u.OutputTokens}
			}
			chunk(map[string]any{}, finishReason(ev.Delta.StopReason))
			finished = true
		case "message_stop":
			rec()
			if includeUsage {
				b, _ := json.Marshal(map[string]any{"id": id, "object": "chat.completion.chunk", "created": created, "model": model,
					"choices": []any{}, "usage": oaiUsage(u)})
				out.WriteString("data: ")
				out.Write(b)
				out.WriteString("\n\n")
			}
			done()
		case "error":
			b, _ := json.Marshal(map[string]any{"error": map[string]any{"message": ev.Error.Message, "type": "server_error", "code": ev.Error.Type}})
			out.WriteString("data: ")
			out.Write(b)
			out.WriteString("\n\n")
			done()
		}
	}}
	defer rec()
	flush := func() bool {
		if out.Len() == 0 {
			return true
		}
		_, err := w.Write(out.Bytes())
		out.Reset()
		rc.Flush()
		return err == nil
	}
	buf := make([]byte, 16<<10)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			tap.Write(buf[:n])
			if !flush() {
				return
			}
		}
		if err != nil {
			break
		}
	}
	if !doneSent {
		// The upstream stream ended without message_stop; say so instead of leaving the client waiting.
		if !finished {
			b, _ := json.Marshal(map[string]any{"error": map[string]any{"message": "The AI provider's stream ended early.", "type": "server_error", "code": "upstream_closed"}})
			out.WriteString("data: ")
			out.Write(b)
			out.WriteString("\n\n")
		}
		done()
		flush()
	}
}
