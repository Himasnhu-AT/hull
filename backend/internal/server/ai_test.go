package server

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

func sse(w http.ResponseWriter, events ...string) {
	for _, ev := range events {
		fmt.Fprintf(w, "event: x\ndata: %s\n\n", ev)
		w.(http.Flusher).Flush()
	}
}

func TestMessagesPassthroughNonStream(t *testing.T) {
	e := newEnv(t, nil)
	tok := e.token("p@example.com")
	reqBody := `{"model":"claude-sonnet-5-5","max_tokens":5,"messages":[{"role":"user","content":"hi"}],"extra":{"keep":true}}`
	resp, body := e.do("POST", "/v1/messages", "", map[string]string{"x-api-key": tok, "anthropic-beta": "tools-2024", "anthropic-version": "2024-01-01"}, reqBody)
	if resp.StatusCode != 200 || !strings.Contains(body, `"text":"hi"`) {
		t.Fatalf("status %d: %s", resp.StatusCode, body)
	}
	h, got, path := e.up.last()
	if path != "/v1/messages" || string(got) != reqBody {
		t.Errorf("body not forwarded unchanged: %s", got)
	}
	if h.Get("x-api-key") != testKey || h.Get("Authorization") != "" || h.Get("anthropic-beta") != "tools-2024" || h.Get("anthropic-version") != "2024-01-01" {
		t.Errorf("upstream headers wrong: %v", h)
	}
	// Default version, bearer auth.
	e.do("POST", "/v1/messages", tok, nil, reqBody)
	if h, _, _ := e.up.last(); h.Get("anthropic-version") != "2023-06-01" || h.Get("x-api-key") != testKey {
		t.Errorf("default headers wrong: %v", h)
	}
	if u := e.usage("p@example.com"); u.Input != 22 || u.Output != 14 {
		t.Errorf("usage after two calls: %+v", u)
	}
	// Upstream errors pass through with their status and body.
	e.up.respond = func(w http.ResponseWriter, r *http.Request, b []byte) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(429)
		w.Write([]byte(`{"type":"error","error":{"type":"rate_limit_error","message":"slow"}}`))
	}
	resp, body = e.do("POST", "/v1/messages", tok, nil, reqBody)
	if resp.StatusCode != 429 || !strings.Contains(body, "rate_limit_error") {
		t.Errorf("error passthrough: %d %s", resp.StatusCode, body)
	}
	// count_tokens is forwarded but not billed.
	e.up.respond = func(w http.ResponseWriter, r *http.Request, b []byte) { w.Write([]byte(`{"input_tokens":42}`)) }
	resp, body = e.do("POST", "/v1/messages/count_tokens", tok, nil, reqBody)
	if _, _, p := e.up.last(); resp.StatusCode != 200 || !strings.Contains(body, "42") || p != "/v1/messages/count_tokens" {
		t.Errorf("count_tokens: %d %s %s", resp.StatusCode, body, p)
	}
	if u := e.usage("p@example.com"); u.Input != 22 {
		t.Errorf("count_tokens was billed: %+v", u)
	}
}

func TestMessagesPassthroughStream(t *testing.T) {
	e := newEnv(t, nil)
	tok := e.token("s@example.com")
	release := make(chan struct{})
	e.up.respond = func(w http.ResponseWriter, r *http.Request, b []byte) {
		w.Header().Set("Content-Type", "text/event-stream")
		sse(w, `{"type":"message_start","message":{"id":"msg_9","usage":{"input_tokens":25,"output_tokens":1}}}`,
			`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"first"}}`)
		<-release // the rest is held back until the client has read the first events
		sse(w, `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"second"}}`,
			`{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":15}}`, `{"type":"message_stop"}`)
	}
	req, _ := http.NewRequest("POST", e.ts.URL+"/v1/messages", strings.NewReader(`{"model":"claude-opus-5-5","max_tokens":5,"stream":true,"messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("x-api-key", tok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("content type %q", ct)
	}
	sc := bufio.NewScanner(resp.Body)
	var data []string
	read := func(n int) {
		for len(data) < n && sc.Scan() {
			if l := sc.Text(); strings.HasPrefix(l, "data: ") {
				data = append(data, l[6:])
			}
		}
	}
	read(2) // arrives while upstream is still blocked, so nothing is buffered
	if len(data) != 2 || !strings.Contains(data[1], "first") {
		t.Fatalf("first chunks did not arrive early: %v", data)
	}
	close(release)
	read(5)
	if len(data) != 5 || !strings.Contains(data[2], "second") || !strings.Contains(data[4], "message_stop") {
		t.Fatalf("chunks out of order: %v", data)
	}
	resp.Body.Close()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && e.usage("s@example.com").Output == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	if u := e.usage("s@example.com"); u.Input != 25 || u.Output != 15 {
		t.Errorf("stream usage: %+v", u)
	}
}

func TestNoKeyAnswers503(t *testing.T) {
	e := newEnv(t, nil)
	tok := e.token("nk@example.com")
	e.s.cfg.AnthropicKey = ""
	resp, body := e.do("POST", "/v1/messages", tok, nil, `{}`)
	if resp.StatusCode != 503 || !strings.Contains(body, "ANTHROPIC_API_KEY") {
		t.Errorf("anthropic: %d %s", resp.StatusCode, body)
	}
	resp, body = e.do("POST", "/v1/chat/completions", tok, nil, `{}`)
	if resp.StatusCode != 503 || !strings.Contains(body, `"error"`) {
		t.Errorf("openai: %d %s", resp.StatusCode, body)
	}
	if resp, _ := e.do("GET", "/healthz", "", nil, ""); resp.StatusCode != 200 {
		t.Error("healthz must work without a key")
	}
}

func TestModels(t *testing.T) {
	e := newEnv(t, nil)
	tok := e.token("m@example.com")
	_, body := e.do("GET", "/v1/models", tok, nil, "")
	var m struct {
		Object string
		Data   []struct{ ID, Object, Owned_by string }
	}
	json.Unmarshal([]byte(body), &m)
	if m.Object != "list" || len(m.Data) != 3 || m.Data[0].ID != "claude-opus-5-5" || m.Data[2].ID != "claude-haiku-5-5" || m.Data[1].Owned_by != "anthropic" {
		t.Errorf("models: %s", body)
	}
}

func jsonOf(t *testing.T, s string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		t.Fatalf("not JSON: %v: %s", err, s)
	}
	return m
}

func TestChatCompletionsNonStream(t *testing.T) {
	e := newEnv(t, nil)
	tok := e.token("c@example.com")
	resp, body := e.do("POST", "/v1/chat/completions", tok, nil, `{"model":"gpt-4o","max_tokens":100,"temperature":0.5,"top_p":0.9,"stop":"END",
	  "messages":[{"role":"system","content":"Be brief."},{"role":"developer","content":[{"type":"text","text":"Use JSON."}]},
	  {"role":"user","content":[{"type":"text","text":"look"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}}]},
	  {"role":"user","content":"and answer"}]}`)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d: %s", resp.StatusCode, body)
	}
	_, sent, path := e.up.last()
	req := jsonOf(t, string(sent))
	if path != "/v1/messages" || req["model"] != "claude-opus-5-5" || req["system"] != "Be brief.\n\nUse JSON." || req["max_tokens"] != 100.0 || req["temperature"] != 0.5 || req["top_p"] != 0.9 {
		t.Errorf("translated request: %s", sent)
	}
	if s := req["stop_sequences"].([]any); len(s) != 1 || s[0] != "END" {
		t.Errorf("stop: %v", req["stop_sequences"])
	}
	msgs := req["messages"].([]any)
	if len(msgs) != 1 {
		t.Fatalf("consecutive user messages not merged: %s", sent)
	}
	blocks := msgs[0].(map[string]any)["content"].([]any)
	img := blocks[1].(map[string]any)["source"].(map[string]any)
	if len(blocks) != 3 || img["type"] != "base64" || img["media_type"] != "image/png" || img["data"] != "AAAA" {
		t.Errorf("blocks: %v", blocks)
	}
	out := jsonOf(t, body)
	ch := out["choices"].([]any)[0].(map[string]any)
	msg := ch["message"].(map[string]any)
	use := out["usage"].(map[string]any)
	if out["object"] != "chat.completion" || msg["role"] != "assistant" || msg["content"] != "hi" || ch["finish_reason"] != "stop" ||
		use["prompt_tokens"] != 11.0 || use["completion_tokens"] != 7.0 || use["total_tokens"] != 18.0 || out["created"] == nil || out["id"] == "" {
		t.Errorf("response: %s", body)
	}
	if u := e.usage("c@example.com"); u.Input != 11 || u.Output != 7 {
		t.Errorf("usage: %+v", u)
	}
	// Default max_tokens and a named claude model.
	e.do("POST", "/v1/chat/completions", tok, nil, `{"model":"claude-haiku-5-5","messages":[{"role":"user","content":"x"}]}`)
	_, sent, _ = e.up.last()
	if r := jsonOf(t, string(sent)); r["max_tokens"] != 8192.0 || r["model"] != "claude-haiku-5-5" {
		t.Errorf("defaults: %s", sent)
	}
	// max_completion_tokens wins; stop_reason mapping.
	e.up.respond = func(w http.ResponseWriter, r *http.Request, b []byte) {
		w.Write([]byte(`{"id":"msg_2","model":"claude-opus-5-5","content":[{"type":"text","text":"cut"}],"stop_reason":"max_tokens","usage":{"input_tokens":1,"output_tokens":2}}`))
	}
	_, body = e.do("POST", "/v1/chat/completions", tok, nil, `{"max_completion_tokens":7,"messages":[{"role":"user","content":"x"}]}`)
	if _, sent, _ := e.up.last(); jsonOf(t, string(sent))["max_tokens"] != 7.0 || !strings.Contains(body, `"finish_reason":"length"`) {
		t.Errorf("max_completion_tokens / length: %s", body)
	}
	// Errors come back in OpenAI shape; bad input is a 400.
	resp, body = e.do("POST", "/v1/chat/completions", tok, nil, `{"messages":[]}`)
	if resp.StatusCode != 400 || !strings.Contains(body, `"error":{`) || !strings.Contains(body, "invalid_request_error") {
		t.Errorf("bad request: %d %s", resp.StatusCode, body)
	}
	e.up.respond = func(w http.ResponseWriter, r *http.Request, b []byte) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(529)
		w.Write([]byte(`{"type":"error","error":{"type":"overloaded_error","message":"busy"}}`))
	}
	resp, body = e.do("POST", "/v1/chat/completions", tok, nil, `{"messages":[{"role":"user","content":"x"}]}`)
	if resp.StatusCode != 529 || !strings.Contains(body, `"message":"busy"`) || !strings.Contains(body, `"type":"server_error"`) {
		t.Errorf("upstream error: %d %s", resp.StatusCode, body)
	}
}

func TestChatCompletionsTools(t *testing.T) {
	e := newEnv(t, nil)
	tok := e.token("t@example.com")
	e.up.respond = func(w http.ResponseWriter, r *http.Request, b []byte) {
		w.Write([]byte(`{"id":"msg_3","model":"claude-opus-5-5","content":[{"type":"text","text":"checking"},{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{"city":"Paris"}}],"stop_reason":"tool_use","usage":{"input_tokens":30,"output_tokens":12}}`))
	}
	resp, body := e.do("POST", "/v1/chat/completions", tok, nil, `{"tool_choice":{"type":"function","function":{"name":"get_weather"}},
	 "tools":[{"type":"function","function":{"name":"get_weather","description":"Weather","parameters":{"type":"object","properties":{"city":{"type":"string"}}}}}],
	 "messages":[{"role":"user","content":"weather?"},
	  {"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"Rome\"}"}},{"id":"call_2","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"Oslo\"}"}}]},
	  {"role":"tool","tool_call_id":"call_1","content":"sunny"},
	  {"role":"tool","tool_call_id":"call_2","content":"snow"},
	  {"role":"user","content":"thanks, now Paris"}]}`)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d: %s", resp.StatusCode, body)
	}
	_, sent, _ := e.up.last()
	req := jsonOf(t, string(sent))
	tools := req["tools"].([]any)[0].(map[string]any)
	if tools["name"] != "get_weather" || tools["description"] != "Weather" || tools["input_schema"].(map[string]any)["type"] != "object" {
		t.Errorf("tools: %s", sent)
	}
	if tc := req["tool_choice"].(map[string]any); tc["type"] != "tool" || tc["name"] != "get_weather" {
		t.Errorf("tool_choice: %v", tc)
	}
	msgs := req["messages"].([]any)
	if len(msgs) != 3 {
		t.Fatalf("want user/assistant/user, got %d: %s", len(msgs), sent)
	}
	asst := msgs[1].(map[string]any)["content"].([]any)
	tu := asst[0].(map[string]any)
	if len(asst) != 2 || tu["type"] != "tool_use" || tu["id"] != "call_1" || tu["input"].(map[string]any)["city"] != "Rome" {
		t.Errorf("assistant blocks: %v", asst)
	}
	last := msgs[2].(map[string]any)["content"].([]any)
	r1, r2 := last[0].(map[string]any), last[1].(map[string]any)
	if len(last) != 3 || r1["type"] != "tool_result" || r1["tool_use_id"] != "call_1" || r1["content"] != "sunny" || r2["tool_use_id"] != "call_2" || last[2].(map[string]any)["type"] != "text" {
		t.Errorf("tool results not merged into one user message: %v", last)
	}
	ch := jsonOf(t, body)["choices"].([]any)[0].(map[string]any)
	msg := ch["message"].(map[string]any)
	call := msg["tool_calls"].([]any)[0].(map[string]any)
	fn := call["function"].(map[string]any)
	if ch["finish_reason"] != "tool_calls" || msg["content"] != "checking" || call["id"] != "toolu_1" || call["type"] != "function" || fn["name"] != "get_weather" {
		t.Errorf("response: %s", body)
	}
	var args map[string]any
	if json.Unmarshal([]byte(fn["arguments"].(string)), &args) != nil || args["city"] != "Paris" {
		t.Errorf("arguments should be a JSON string: %v", fn["arguments"])
	}
	// tool_choice mapping.
	for in, want := range map[string]string{`"auto"`: "auto", `"none"`: "none", `"required"`: "any"} {
		e.do("POST", "/v1/chat/completions", tok, nil, `{"tool_choice":`+in+`,"tools":[{"type":"function","function":{"name":"f"}}],"messages":[{"role":"user","content":"x"}]}`)
		_, sent, _ := e.up.last()
		if got := jsonOf(t, string(sent))["tool_choice"].(map[string]any)["type"]; got != want {
			t.Errorf("tool_choice %s -> %v want %s", in, got, want)
		}
	}
}

func TestChatCompletionsStream(t *testing.T) {
	e := newEnv(t, nil)
	tok := e.token("cs@example.com")
	e.up.respond = func(w http.ResponseWriter, r *http.Request, b []byte) {
		w.Header().Set("Content-Type", "text/event-stream")
		sse(w, `{"type":"message_start","message":{"id":"msg_s","model":"claude-opus-5-5","usage":{"input_tokens":20,"output_tokens":1}}}`,
			`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
			`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}`,
			`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}`,
			`{"type":"content_block_stop","index":0}`,
			`{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_9","name":"get_weather","input":{}}}`,
			`{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"ci"}}`,
			`{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"ty\":\"Rome\"}"}}`,
			`{"type":"content_block_stop","index":1}`,
			`{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}`,
			`{"type":"message_stop"}`)
	}
	resp, body := e.do("POST", "/v1/chat/completions", tok, nil, `{"stream":true,"stream_options":{"include_usage":true},"tools":[{"type":"function","function":{"name":"get_weather"}}],"messages":[{"role":"user","content":"x"}]}`)
	if ct := resp.Header.Get("Content-Type"); resp.StatusCode != 200 || !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("status %d type %q: %s", resp.StatusCode, ct, body)
	}
	if _, sent, _ := e.up.last(); jsonOf(t, string(sent))["stream"] != true {
		t.Errorf("upstream was not asked to stream: %s", sent)
	}
	var chunks []map[string]any
	var raw []string
	for _, l := range strings.Split(body, "\n") {
		if d, ok := strings.CutPrefix(l, "data: "); ok {
			raw = append(raw, d)
			if d != "[DONE]" {
				chunks = append(chunks, jsonOf(t, d))
			}
		}
	}
	if raw[len(raw)-1] != "[DONE]" {
		t.Fatalf("stream must end with [DONE]: %v", raw)
	}
	var text, args, finish string
	var gotRole, gotID, gotName bool
	var usage map[string]any
	for _, c := range chunks {
		if c["object"] != "chat.completion.chunk" {
			t.Errorf("object: %v", c["object"])
		}
		if u, ok := c["usage"].(map[string]any); ok {
			usage = u
			if len(c["choices"].([]any)) != 0 {
				t.Error("usage chunk must have empty choices")
			}
			continue
		}
		ch := c["choices"].([]any)[0].(map[string]any)
		d := ch["delta"].(map[string]any)
		if d["role"] == "assistant" {
			if text != "" {
				t.Error("role must come first")
			}
			gotRole = true
		}
		if s, ok := d["content"].(string); ok {
			text += s
		}
		tcs, _ := d["tool_calls"].([]any)
		for _, tc := range tcs {
			tcm := tc.(map[string]any)
			if tcm["index"] != 0.0 {
				t.Errorf("tool index %v", tcm["index"])
			}
			fn := tcm["function"].(map[string]any)
			if tcm["id"] == "toolu_9" && tcm["type"] == "function" {
				gotID = true
			}
			if fn["name"] == "get_weather" {
				gotName = true
			}
			args += fn["arguments"].(string)
		}
		if f, ok := ch["finish_reason"].(string); ok {
			finish = f
		}
	}
	if !gotRole || text != "Hello" || args != `{"city":"Rome"}` || !gotID || !gotName || finish != "tool_calls" {
		t.Errorf("role=%v text=%q args=%q id=%v name=%v finish=%q", gotRole, text, args, gotID, gotName, finish)
	}
	if usage["prompt_tokens"] != 20.0 || usage["completion_tokens"] != 9.0 || usage["total_tokens"] != 29.0 {
		t.Errorf("usage chunk: %v", usage)
	}
	if u := e.usage("cs@example.com"); u.Input != 20 || u.Output != 9 {
		t.Errorf("recorded usage: %+v", u)
	}
	// Without include_usage there is no usage chunk.
	_, body = e.do("POST", "/v1/chat/completions", tok, nil, `{"stream":true,"messages":[{"role":"user","content":"x"}]}`)
	if strings.Contains(body, "total_tokens") || !strings.HasSuffix(strings.TrimSpace(body), "[DONE]") {
		t.Errorf("unexpected usage chunk or missing DONE: %s", body)
	}
}

func TestSecretsNeverLeak(t *testing.T) {
	e := newEnv(t, nil)
	tok := e.token("leak@example.com")
	var all strings.Builder
	for _, p := range []string{"/v1/messages", "/v1/chat/completions"} {
		resp, body := e.do("POST", p, tok, nil, `{"model":"claude-opus-5-5","messages":[{"role":"user","content":"x"}]}`)
		all.WriteString(body)
		for k, v := range resp.Header {
			all.WriteString(k + strings.Join(v, ","))
		}
	}
	for _, p := range []string{"/", "/login", "/signup", "/v1/models", "/api/me", "/healthz"} {
		resp, body := e.do("GET", p, tok, nil, "")
		all.WriteString(body)
		for k, v := range resp.Header {
			all.WriteString(k + strings.Join(v, ","))
		}
	}
	// Even the upstream-down path must not echo the key.
	e.upS.Close()
	_, body := e.do("POST", "/v1/messages", tok, nil, `{}`)
	all.WriteString(body)
	_, body = e.do("POST", "/v1/chat/completions", tok, nil, `{"messages":[{"role":"user","content":"x"}]}`)
	all.WriteString(body)
	if !strings.Contains(body, "Could not reach") {
		t.Errorf("upstream down: %s", body)
	}
	if strings.Contains(all.String(), testKey) {
		t.Fatal("the Anthropic key appeared in a response")
	}
	logs := e.logs.String()
	if logs == "" {
		t.Fatal("expected logs")
	}
	for name, secret := range map[string]string{"key": testKey, "token": tok, "password": "correct horse battery", "token body": strings.TrimPrefix(tok, "hull_")} {
		if strings.Contains(logs, secret) {
			t.Errorf("%s appeared in the logs", name)
		}
	}
}
