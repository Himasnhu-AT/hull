// Two providers: Anthropic's Messages API with an API key, and any OpenAI-compatible chat endpoint (base URL + key; this
// is how Marl's gateway ai.marlstudio.com plugs in). Both are plain fetch calls: no SDK, so there is nothing to pin or
// to keep in step with a vendor. Both ask for a stream (server-sent events, parsed in stream.ts) and fall back to a plain
// JSON answer when a gateway ignores that. Keys are read from the environment by name and never logged or put in an error.
import { AnthropicStream, OpenAIStream, readSse } from './stream.ts';
import type { Completion, CompleteRequest, Msg, Provider, ToolSpec } from './types.ts';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

export interface ProviderConfig {
  kind: 'anthropic' | 'openai';
  apiKey: string;
  model?: string;
  /** Anthropic: default https://api.anthropic.com. OpenAI-compatible: required, e.g. https://ai.marlstudio.com/v1. */
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
  fetch?: typeof fetch;
}

/** HULL_AGENT_BASE_URL + HULL_AGENT_API_KEY (+ HULL_AGENT_MODEL) select an OpenAI-compatible endpoint; else ANTHROPIC_API_KEY. */
export function providerConfigFromEnv(env: Record<string, string | undefined>): ProviderConfig | undefined {
  const num = (s: string | undefined): number | undefined => (s && Number.isFinite(Number(s)) ? Number(s) : undefined);
  const contextWindow = num(env['HULL_AGENT_CONTEXT']);
  if (env['HULL_AGENT_BASE_URL']) {
    return { kind: 'openai', baseUrl: env['HULL_AGENT_BASE_URL'], apiKey: env['HULL_AGENT_API_KEY'] ?? '', ...(env['HULL_AGENT_MODEL'] ? { model: env['HULL_AGENT_MODEL'] } : {}), ...(contextWindow ? { contextWindow } : {}) };
  }
  if (env['ANTHROPIC_API_KEY']) {
    return { kind: 'anthropic', apiKey: env['ANTHROPIC_API_KEY'], ...(env['HULL_AGENT_MODEL'] ? { model: env['HULL_AGENT_MODEL'] } : {}), ...(env['ANTHROPIC_BASE_URL'] ? { baseUrl: env['ANTHROPIC_BASE_URL'] } : {}), ...(contextWindow ? { contextWindow } : {}) };
  }
  return undefined;
}

export function createProvider(c: ProviderConfig): Provider {
  return c.kind === 'anthropic' ? anthropicProvider(c) : openaiProvider(c);
}

/** Sends the request. A failure becomes an error with the key taken out; the caller reads the body of a good answer. */
async function send(f: typeof fetch, url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal, secret: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
    if (res.status === 429 && attempt === 0) { await new Promise((r) => setTimeout(r, 2000)); continue; }
    if (!res.ok) {
      const text = await res.text();
      const clean = secret ? text.split(secret).join('***') : text;
      throw new Error(`model request failed: HTTP ${res.status} ${clean.slice(0, 500)}`);
    }
    return res;
  }
}

const isStream = (res: Response): boolean => (res.headers.get('content-type') ?? '').includes('text/event-stream');

/** Streams the answer into `parser`, or reads it whole when a gateway ignored stream:true and answered with plain JSON. */
async function read<P extends { push(e: import('./stream.ts').SseEvent): void; result(): Completion }>(res: Response, parser: P, signal: AbortSignal, whole: (json: any) => Completion): Promise<Completion> {
  if (isStream(res) && res.body) {
    await readSse(res.body, (e) => parser.push(e), signal);
    return parser.result();
  }
  return whole(JSON.parse(await res.text()));
}

const anthropicMsg = (m: Msg): unknown => ({
  role: m.role,
  content: m.parts.map((p) => {
    switch (p.type) {
      case 'text': return { type: 'text', text: p.text || ' ' };
      case 'image': return { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } };
      case 'tool_use': return { type: 'tool_use', id: p.id, name: p.name, input: p.input ?? {} };
      case 'tool_result': return { type: 'tool_result', tool_use_id: p.id, is_error: p.isError ?? false, content: [{ type: 'text', text: p.text || ' ' }, ...(p.images ?? []).map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } }))] };
    }
  }),
});

export function anthropicProvider(c: ProviderConfig): Provider {
  const f = c.fetch ?? fetch;
  const model = c.model ?? DEFAULT_ANTHROPIC_MODEL;
  const base = (c.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  return {
    name: 'anthropic', model, contextWindow: c.contextWindow ?? 200_000,
    async complete(req: CompleteRequest): Promise<Completion> {
      // Prompt caching is a prefix match over tools, then system, then messages. The tool list and the system prompt are the same on
      // every call of a run, so a breakpoint on the last tool and one on the system prompt let each step read them back at a tenth
      // of the price; a third on the last message block lets the growing conversation be read back too (3 of the 4 allowed).
      const cache = { type: 'ephemeral' };
      const tools = req.tools.map((t: ToolSpec, i: number) => ({ name: t.name, description: t.description, input_schema: t.schema, ...(i === req.tools.length - 1 ? { cache_control: cache } : {}) }));
      const messages = req.messages.map(anthropicMsg) as { content: Record<string, unknown>[] }[];
      const lastBlock = messages.at(-1)?.content.at(-1);
      if (lastBlock) lastBlock['cache_control'] = cache;
      const body = {
        model, max_tokens: c.maxTokens ?? 8192, stream: true, system: [{ type: 'text', text: req.system, cache_control: cache }], messages,
        ...(tools.length ? { tools } : {}),
      };
      const res = await send(f, `${base}/v1/messages`, { 'x-api-key': c.apiKey, 'anthropic-version': '2023-06-01' }, body, req.signal, c.apiKey);
      return read(res, new AnthropicStream(req.onDelta, c.apiKey), req.signal, (r) => {
        const blocks: any[] = r.content ?? [];
        const toolCalls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: String(b.id), name: String(b.name), input: b.input ?? {} }));
        const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
        if (text) req.onDelta?.(text);
        return {
          text, toolCalls,
          stop: toolCalls.length ? 'tool_use' : r.stop_reason === 'max_tokens' ? 'max_tokens' : 'end',
          usage: { input: (r.usage?.input_tokens ?? 0) + (r.usage?.cache_read_input_tokens ?? 0) + (r.usage?.cache_creation_input_tokens ?? 0), output: r.usage?.output_tokens ?? 0 },
        };
      });
    },
  };
}

/** The wire messages of an OpenAI chat call. A tool result cannot carry a picture there, so pictures follow as a user message. */
function openaiMessages(system: string, messages: Msg[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('');
      const calls = m.parts.filter((p) => p.type === 'tool_use').map((p) => { const u = p as { id: string; name: string; input: unknown }; return { id: u.id, type: 'function', function: { name: u.name, arguments: JSON.stringify(u.input ?? {}) } }; });
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    const pics: unknown[] = [];
    const texts: string[] = [];
    for (const p of m.parts) {
      if (p.type === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: p.id, content: p.text });
        for (const i of p.images ?? []) pics.push({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data}` } });
      } else if (p.type === 'text') texts.push(p.text);
      else if (p.type === 'image') pics.push({ type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } });
    }
    if (texts.length || pics.length) out.push({ role: 'user', content: [...(texts.length ? [{ type: 'text', text: texts.join('\n') }] : []), ...pics] });
  }
  return out;
}

export function openaiProvider(c: ProviderConfig): Provider {
  if (!c.baseUrl) throw new Error('an OpenAI-compatible provider needs a base URL (HULL_AGENT_BASE_URL)');
  const f = c.fetch ?? fetch;
  const base = c.baseUrl.replace(/\/+$/, '');
  const model = c.model ?? 'default';
  let host = base;
  try { host = new URL(base).host; } catch { /* keep the raw text */ }
  return {
    name: host, model, contextWindow: c.contextWindow ?? 128_000,
    async complete(req: CompleteRequest): Promise<Completion> {
      const body = {
        model, max_tokens: c.maxTokens ?? 8192, stream: true, stream_options: { include_usage: true }, messages: openaiMessages(req.system, req.messages),
        ...(req.tools.length ? { tools: req.tools.map((t: ToolSpec) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })) } : {}),
      };
      const res = await send(f, `${base}/chat/completions`, c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}, body, req.signal, c.apiKey);
      return read(res, new OpenAIStream(req.onDelta, c.apiKey), req.signal, (r) => {
        const choice = r.choices?.[0];
        const msg = choice?.message ?? {};
        const toolCalls = ((msg.tool_calls ?? []) as any[]).map((t) => {
          let input: unknown = {};
          try { input = JSON.parse(t.function?.arguments || '{}'); } catch { input = {}; }
          return { id: String(t.id), name: String(t.function?.name), input };
        });
        const text = typeof msg.content === 'string' ? msg.content : '';
        if (text) req.onDelta?.(text);
        return {
          text, toolCalls,
          stop: toolCalls.length ? 'tool_use' : choice?.finish_reason === 'length' ? 'max_tokens' : 'end',
          usage: { input: r.usage?.prompt_tokens ?? 0, output: r.usage?.completion_tokens ?? 0 },
        };
      });
    },
  };
}
