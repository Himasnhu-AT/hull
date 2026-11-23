import { describe, expect, it } from 'vitest';
import { anthropicProvider, openaiProvider } from './providers.ts';
import { AnthropicStream, OpenAIStream, replay, SseSplitter } from './stream.ts';
import { fakeProvider, pieces } from './fake.ts';

// Recorded-style streams (the shape the APIs send), parsed with no network.
const ANTHROPIC = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","role":"assistant","content":[],"model":"m","usage":{"input_tokens":25,"cache_creation_input_tokens":100,"cache_read_input_tokens":4000,"output_tokens":1}}}',
  '',
  'event: ping',
  'data: {"type":"ping"}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"I will raise "}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"the crate count."}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"config_set","input":{}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"id\\": \\"tuning/arena\\", \\"poin"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"ter\\": \\"/crateCount\\", \\"value\\": 20}"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":1}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_2","name":"check","input":{}}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":2}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":57}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

const OPENAI = [
  'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}',
  '',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Checking "}}]}',
  '',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"now."}}]}',
  '',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"config_set","arguments":""}}]}}]}',
  '',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"id\\":\\"tuning/"}}]}}]}',
  '',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"arena\\"}"}}]}}]}',
  '',
  'data: {"id":"c1","choices":[{"index":1,"delta":{"tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"check","arguments":"{}"}}]}}]}',
  '',
  'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
  '',
  'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":321,"completion_tokens":44}}',
  '',
  'data: [DONE]',
  '',
  '',
].join('\n');

describe('the stream parsers', () => {
  it('splits server-sent events at any chunk boundary, joins data lines, skips comments, and flushes a last event', () => {
    for (const size of [1, 3, 7, 1000]) {
      const sp = new SseSplitter();
      const got = [];
      const raw = ': keep-alive\r\nevent: a\r\ndata: one\r\ndata: two\r\n\r\ndata: three\n\nevent: z\ndata: last';
      for (let i = 0; i < raw.length; i += size) got.push(...sp.push(raw.slice(i, i + size)));
      got.push(...sp.end());
      expect(got).toEqual([{ event: 'a', data: 'one\ntwo' }, { data: 'three' }, { event: 'z', data: 'last' }]);
    }
  });

  it('reads an Anthropic stream: text deltas as they come, tool input from json pieces, usage with the cache counted', () => {
    for (const size of [5, 17, 4096]) {
      const deltas: string[] = [];
      const c = replay(new AnthropicStream((t) => deltas.push(t)), ANTHROPIC, size);
      expect(deltas).toEqual(['I will raise ', 'the crate count.']);
      expect(c.text).toBe('I will raise the crate count.');
      expect(c.toolCalls).toEqual([
        { id: 'toolu_1', name: 'config_set', input: { id: 'tuning/arena', pointer: '/crateCount', value: 20 } },
        { id: 'toolu_2', name: 'check', input: {} }, // a tool with no input streams no json
      ]);
      expect(c.stop).toBe('tool_use');
      expect(c.usage).toEqual({ input: 25 + 100 + 4000, output: 57 });
    }
  });

  it('reads an Anthropic stream that ends on max_tokens, and marks a half-sent tool input as cut (input {}) rather than throwing', () => {
    const raw = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":1}}}', '',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t","name":"code_write"}}', '',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"src/a.ts\\",\\"te"}}', '',
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":9}}', '', '',
    ].join('\n');
    const c = replay(new AnthropicStream(), raw);
    expect(c.toolCalls).toEqual([{ id: 't', name: 'code_write', input: {}, cut: true }]);
    expect(c.stop).toBe('max_tokens');
    expect(c.usage).toEqual({ input: 3, output: 9 });
  });

  it('turns an error event into an error with the key taken out', () => {
    const raw = 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded sk-secret"}}\n\n';
    expect(() => replay(new AnthropicStream(undefined, 'sk-secret'), raw)).toThrow(/model stream failed: Overloaded \*\*\*/);
  });

  it('reads an OpenAI-compatible stream: text, tool-call arguments in pieces, two calls by index, usage in the last chunk', () => {
    const deltas: string[] = [];
    const c = replay(new OpenAIStream((t) => deltas.push(t)), OPENAI, 11);
    expect(deltas).toEqual(['Checking ', 'now.']);
    expect(c.toolCalls).toEqual([{ id: 'call_a', name: 'config_set', input: { id: 'tuning/arena' } }, { id: 'call_b', name: 'check', input: {} }]);
    expect(c.stop).toBe('tool_use');
    expect(c.usage).toEqual({ input: 321, output: 44 });
  });
});

const sse = (raw: string): Response => new Response(new ReadableStream({ start(ctl) { const b = new TextEncoder().encode(raw); for (let i = 0; i < b.length; i += 50) ctl.enqueue(b.slice(i, i + 50)); ctl.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
const signal = new AbortController().signal;

describe('providers stream', () => {
  it('Anthropic: asks for a stream, marks the system prompt, the last tool and the last message for caching, and calls onDelta', async () => {
    let body: any;
    const p = anthropicProvider({ kind: 'anthropic', apiKey: 'sk-secret', fetch: (async (_u: string, init: RequestInit) => { body = JSON.parse(init.body as string); return sse(ANTHROPIC); }) as typeof fetch });
    const deltas: string[] = [];
    const c = await p.complete({
      system: 'sys', signal, onDelta: (t) => deltas.push(t),
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      tools: [{ name: 'a', description: 'd', schema: { type: 'object' } }, { name: 'b', description: 'd', schema: { type: 'object' } }],
    });
    expect(body.stream).toBe(true);
    expect(body.system).toEqual([{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]);
    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.tools[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(deltas.join('')).toBe('I will raise the crate count.');
    expect(c.toolCalls.map((t) => t.name)).toEqual(['config_set', 'check']);
    expect(c.usage.output).toBe(57);
  });

  it('OpenAI-compatible: asks for a stream with usage, and falls back to a plain JSON answer from a gateway that ignores stream', async () => {
    let body: any;
    const p = openaiProvider({ kind: 'openai', apiKey: 'k', baseUrl: 'https://x/v1', fetch: (async (_u: string, init: RequestInit) => { body = JSON.parse(init.body as string); return sse(OPENAI); }) as typeof fetch });
    const deltas: string[] = [];
    const c = await p.complete({ system: 's', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }], tools: [], signal, onDelta: (t) => deltas.push(t) });
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(deltas.join('')).toBe('Checking now.');
    expect(c.usage).toEqual({ input: 321, output: 44 });

    const plain = openaiProvider({ kind: 'openai', apiKey: 'k', baseUrl: 'https://x/v1', fetch: (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'whole answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2 } }))) as typeof fetch });
    const got: string[] = [];
    const w = await plain.complete({ system: 's', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }], tools: [], signal, onDelta: (t) => got.push(t) });
    expect(w.text).toBe('whole answer');
    expect(got).toEqual(['whole answer']); // the host still gets its text
  });

  it('never puts the key in an error from a stream that fails midway', async () => {
    const p = anthropicProvider({ kind: 'anthropic', apiKey: 'sk-secret', fetch: (async () => sse('event: error\ndata: {"type":"error","error":{"message":"bad sk-secret"}}\n\n')) as typeof fetch });
    const err = await p.complete({ system: '', messages: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }], tools: [], signal }).catch((e: Error) => e.message);
    expect(err).toContain('model stream failed');
    expect(err).not.toContain('sk-secret');
  });
});

describe('the scripted model streams too', () => {
  it('sends its text in small pieces that join back to the text, and skips steps whose "when" does not match', async () => {
    expect(pieces('abc').join('')).toBe('abc');
    const text = 'I raised the jump height from 1.6 m to 2 m so the jump feels higher.';
    expect(pieces(text).length).toBeGreaterThan(3);
    expect(pieces(text).join('')).toBe(text);
    const f = fakeProvider([{ when: 'nope', text: 'skipped' }, { text }]);
    const got: string[] = [];
    const c = await f.complete({ system: '', messages: [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }], tools: [], signal, onDelta: (t) => got.push(t) });
    expect(got.join('')).toBe(text);
    expect(c.text).toBe(text);
  });

  it('fills "$screenshot" with the newest picture and its size', async () => {
    // a 2x3 PNG header is enough for the size
    const hdr = Buffer.alloc(24); hdr.write('\x89PNG\r\n\x1a\n', 0, 'latin1'); hdr.writeUInt32BE(13, 8); hdr.write('IHDR', 12, 'latin1'); hdr.writeUInt32BE(2, 16); hdr.writeUInt32BE(3, 20);
    const png = hdr.toString('base64');
    const f = fakeProvider([{ tools: [{ name: 'explain.write', input: { image: '$screenshot', width: '$screenshot.width', height: '$screenshot.height' } }] }]);
    const c = await f.complete({ system: '', tools: [], signal, messages: [{ role: 'user', parts: [{ type: 'tool_result', id: 'x', text: 'ok', images: [{ mime: 'image/png', data: png }] }] }] });
    expect(c.toolCalls[0]!.input).toEqual({ image: 'data:image/png;base64,' + png, width: 2, height: 3 });
  });

  it('plays a keyed script by the Stage line and starts a stage again from its top when its history is fresh', async () => {
    const f = fakeProvider({ world: [{ text: 'w1' }, { text: 'w2' }], rules: [{ text: 'r1' }] });
    const ask = (stage: string, n: number) => f.complete({ system: 'Stage: ' + stage + '\nrest', tools: [], signal, messages: Array.from({ length: n }, () => ({ role: 'user' as const, parts: [{ type: 'text' as const, text: 'x' }] })) });
    expect((await ask('world', 1)).text).toBe('w1');
    expect((await ask('rules', 1)).text).toBe('r1');
    expect((await ask('world', 3)).text).toBe('w2');
    expect((await ask('world', 1)).text).toBe('w1'); // fresh history: from the top
  });
});
