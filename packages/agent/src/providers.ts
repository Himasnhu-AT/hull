// Two providers: Anthropic's Messages API with an API key, and any OpenAI-compatible chat endpoint (base URL + key; this
// is how Marl's gateway ai.marlstudio.com plugs in). Both are plain fetch calls: no SDK, so there is nothing to pin or
// to keep in step with a vendor. Both ask for a stream (server-sent events, parsed in stream.ts) and fall back to a plain
// JSON answer when a gateway ignores that. Keys are read from the environment by name and never logged or put in an error.
import { EFFORTS, effortFor, limitsFor, type Effort } from './models.ts';
import { AnthropicStream, OpenAIStream, readSse } from './stream.ts';
import type { Completion, CompleteRequest, Msg, Part, Provider, ToolSpec } from './types.ts';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

export interface ProviderConfig {
  kind: 'anthropic' | 'openai';
  apiKey: string;
  model?: string;
  /** Anthropic: default https://api.anthropic.com. OpenAI-compatible: required, e.g. https://ai.marlstudio.com/v1. */
  baseUrl?: string;
  /** Overrides the model table (HULL_AGENT_CONTEXT). */
  contextWindow?: number;
  /** Overrides the model table (HULL_AGENT_MAX_TOKENS). */
  maxTokens?: number;
  fetch?: typeof fetch;
  /** Overrides the effort of every kind of run (HULL_AGENT_EFFORT). Sent only to models whose table row takes one. */
  effort?: Effort;
  /** Waits between retries. Tests pass one that records the wait and returns at once. Default: a timer that stops on abort. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** 0..1 for the backoff jitter. Default Math.random (this is network code, not the simulation). */
  random?: () => number;
}

/** HULL_AGENT_BASE_URL + HULL_AGENT_API_KEY (+ HULL_AGENT_MODEL) select an OpenAI-compatible endpoint; else ANTHROPIC_API_KEY. */
export function providerConfigFromEnv(env: Record<string, string | undefined>): ProviderConfig | undefined {
  const num = (s: string | undefined): number | undefined => (s && Number.isFinite(Number(s)) ? Number(s) : undefined);
  const contextWindow = num(env['HULL_AGENT_CONTEXT']);
  const maxTokens = num(env['HULL_AGENT_MAX_TOKENS']);
  const effort = EFFORTS.find((e) => e === env['HULL_AGENT_EFFORT']);
  if (env['HULL_AGENT_BASE_URL']) {
    return { kind: 'openai', baseUrl: env['HULL_AGENT_BASE_URL'], apiKey: env['HULL_AGENT_API_KEY'] ?? '', ...(env['HULL_AGENT_MODEL'] ? { model: env['HULL_AGENT_MODEL'] } : {}), ...(contextWindow ? { contextWindow } : {}), ...(maxTokens ? { maxTokens } : {}) };
  }
  if (env['ANTHROPIC_API_KEY']) {
    return { kind: 'anthropic', apiKey: env['ANTHROPIC_API_KEY'], ...(env['HULL_AGENT_MODEL'] ? { model: env['HULL_AGENT_MODEL'] } : {}), ...(env['ANTHROPIC_BASE_URL'] ? { baseUrl: env['ANTHROPIC_BASE_URL'] } : {}), ...(contextWindow ? { contextWindow } : {}), ...(maxTokens ? { maxTokens } : {}), ...(effort ? { effort } : {}) };
  }
  return undefined;
}

export function createProvider(c: ProviderConfig): Provider {
  return c.kind === 'anthropic' ? anthropicProvider(c) : openaiProvider(c);
}

export const MAX_TRIES = 5;
/** What a retry waits at most, whatever a server asks for in Retry-After. */
const MAX_WAIT_MS = 60_000;
const RETRY_STATUS = (s: number): boolean => s === 408 || s === 409 || s === 429 || (s >= 500 && s <= 599);

/** A failed HTTP answer. The message has the key taken out. */
export class ModelHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** A stream that broke after the answer began: a dropped connection, or an error event from the server. */
export class StreamBreak extends Error {}

interface Retry { sleep: (ms: number, signal: AbortSignal) => Promise<void>; random: () => number }

const timerSleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) return resolve();
  const done = (): void => { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); };
  const t = setTimeout(done, ms);
  signal.addEventListener('abort', done);
});

/** Retry-After is seconds or an HTTP date. */
export function retryAfterMs(h: string | null, now = Date.now()): number | undefined {
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** Waits for try `attempt` (0 is the first retry): what the server asked, or 1 s, 2 s, 4 s, 8 s doubled, each with the lower half jittered away. */
export function backoffMs(attempt: number, retryAfter: number | undefined, random: () => number): number {
  const exp = 1000 * 2 ** attempt;
  const jittered = exp / 2 + (exp / 2) * random();
  return Math.min(MAX_WAIT_MS, Math.max(retryAfter ?? 0, jittered));
}

/**
 * Sends the request, trying up to MAX_TRIES times on a timeout (408), a conflict (409), a rate limit (429), any 5xx (529 is Anthropic's
 * "overloaded") and a connection that fails before an answer. Any other failure becomes an error with the key taken out.
 */
async function send(f: typeof fetch, url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal, secret: string, retry: Retry): Promise<Response> {
  const clean = (t: string): string => (secret ? t.split(secret).join('***') : t);
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
    } catch (e) {
      if (signal.aborted || attempt + 1 >= MAX_TRIES) throw e;
      await retry.sleep(backoffMs(attempt, undefined, retry.random), signal);
      continue;
    }
    if (res.ok) return res;
    const text = await res.text();
    if (RETRY_STATUS(res.status) && attempt + 1 < MAX_TRIES && !signal.aborted) {
      await retry.sleep(backoffMs(attempt, retryAfterMs(res.headers.get('retry-after')), retry.random), signal);
      continue;
    }
    throw new ModelHttpError(res.status, `model request failed: HTTP ${res.status} ${clean(text).slice(0, 500)}`);
  }
}

/**
 * One whole call: send, then read the answer. A stream that breaks midway starts the call again, once. Text the first try already
 * showed is not shown twice: the second try's deltas are held back until they pass the length that was already out.
 */
async function callWithStreamRetry(once: (onDelta: ((t: string) => void) | undefined) => Promise<Completion>, req: CompleteRequest, retry: Retry): Promise<Completion> {
  let shown = 0;
  const first = req.onDelta ? (t: string): void => { shown += t.length; req.onDelta!(t); } : undefined;
  try {
    return await once(first);
  } catch (e) {
    if (!(e instanceof StreamBreak) || req.signal.aborted) throw e;
  }
  await retry.sleep(backoffMs(0, undefined, retry.random), req.signal);
  let seen = 0;
  const second = req.onDelta ? (t: string): void => {
    const end = seen + t.length;
    if (end > shown) req.onDelta!(t.slice(Math.max(0, shown - seen)));
    seen = end;
  } : undefined;
  return once(second);
}

const retryOf = (c: ProviderConfig): Retry => ({ sleep: c.sleep ?? timerSleep, random: c.random ?? Math.random });

/** A whole answer that stopped at the limit: its last tool call is the one that was cut, whatever its input looks like. */
const markCut = <T extends { input: unknown }>(calls: T[], cutOff: boolean): (T & { cut?: boolean })[] =>
  calls.map((t, i) => (cutOff && i === calls.length - 1 && Object.keys((t.input ?? {}) as object).length === 0 ? { ...t, cut: true } : t));

const isStream = (res: Response): boolean => (res.headers.get('content-type') ?? '').includes('text/event-stream');

/** Streams the answer into `parser`, or reads it whole when a gateway ignored stream:true and answered with plain JSON. */
async function read<P extends { push(e: import('./stream.ts').SseEvent): void; result(): Completion; incomplete?(): boolean }>(res: Response, parser: P, signal: AbortSignal, whole: (json: any) => Completion): Promise<Completion> {
  if (isStream(res) && res.body) {
    try {
      await readSse(res.body, (e) => parser.push(e), signal);
    } catch (e) {
      if (signal.aborted) throw e;
      throw new StreamBreak(e instanceof Error ? e.message : String(e), { cause: e });
    }
    if (parser.incomplete?.()) throw new StreamBreak('the stream ended before the answer was complete');
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
      case 'thinking': return p.block;
      case 'tool_use': return { type: 'tool_use', id: p.id, name: p.name, input: p.input ?? {} };
      case 'tool_result': return { type: 'tool_result', tool_use_id: p.id, is_error: p.isError ?? false, content: [{ type: 'text', text: p.text || ' ' }, ...(p.images ?? []).map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } }))] };
    }
  }),
});

export function anthropicProvider(c: ProviderConfig): Provider {
  const f = c.fetch ?? fetch;
  const model = c.model ?? DEFAULT_ANTHROPIC_MODEL;
  const base = (c.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  const limits = limitsFor('anthropic', model, { ...(c.contextWindow ? { context: c.contextWindow } : {}), ...(c.maxTokens ? { maxOutput: c.maxTokens } : {}) });
  const retry = retryOf(c);
  return {
    name: 'anthropic', model, contextWindow: limits.workingContext, maxOutput: limits.askOutput,
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
        model, max_tokens: limits.askOutput, stream: true, system: [{ type: 'text', text: req.system, cache_control: cache }], messages,
        ...(tools.length ? { tools } : {}),
        // Effort is how much the model thinks, and so what an answer costs. No thinking field is sent: always-on models reject
        // "disabled" and a budget with a 400, and the others think when they need to. No temperature, top_p or top_k either.
        ...(limits.effort ? { output_config: { effort: effortFor(req.mode, c.effort) } } : {}),
      };
      return callWithStreamRetry(async (onDelta) => {
      const res = await send(f, `${base}/v1/messages`, { 'x-api-key': c.apiKey, 'anthropic-version': '2023-06-01' }, body, req.signal, c.apiKey, retry);
      return read(res, new AnthropicStream(onDelta, c.apiKey), req.signal, (r) => {
        const blocks: any[] = r.content ?? [];
        const toolCalls = markCut(blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: String(b.id), name: String(b.name), input: b.input ?? {} })), r.stop_reason === 'max_tokens');
        const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
        if (text) onDelta?.(text);
        // Every block in the order sent: thinking blocks go back to the API in the same place.
        const parts: Part[] = blocks.flatMap((b): Part[] => b.type === 'thinking' || b.type === 'redacted_thinking' ? [{ type: 'thinking', block: b }]
          : b.type === 'text' ? (b.text ? [{ type: 'text', text: String(b.text) }] : [])
          : b.type === 'tool_use' ? [{ type: 'tool_use', id: String(b.id), name: String(b.name), input: b.input ?? {} }] : []);
        const refused = r.stop_reason === 'refusal';
        return {
          text, toolCalls, parts,
          stop: refused ? 'refusal' : r.stop_reason === 'max_tokens' ? 'max_tokens' : toolCalls.length ? 'tool_use' : 'end',
          ...(refused ? { refusal: { category: r.stop_details?.category ?? null, explanation: r.stop_details?.explanation ?? null } } : {}),
          usage: { input: (r.usage?.input_tokens ?? 0) + (r.usage?.cache_read_input_tokens ?? 0) + (r.usage?.cache_creation_input_tokens ?? 0), output: r.usage?.output_tokens ?? 0 },
        };
      });
      }, req, retry);
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
  const limits = limitsFor('openai', model, { ...(c.contextWindow ? { context: c.contextWindow } : {}), ...(c.maxTokens ? { maxOutput: c.maxTokens } : {}) });
  const retry = retryOf(c);
  let host = base;
  try { host = new URL(base).host; } catch { /* keep the raw text */ }
  return {
    name: host, model, contextWindow: limits.workingContext, maxOutput: limits.askOutput,
    async complete(req: CompleteRequest): Promise<Completion> {
      const body = {
        model, max_tokens: limits.askOutput, stream: true, stream_options: { include_usage: true }, messages: openaiMessages(req.system, req.messages),
        ...(req.tools.length ? { tools: req.tools.map((t: ToolSpec) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })) } : {}),
      };
      return callWithStreamRetry(async (onDelta) => {
      const res = await send(f, `${base}/chat/completions`, c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}, body, req.signal, c.apiKey, retry);
      return read(res, new OpenAIStream(onDelta, c.apiKey), req.signal, (r) => {
        const choice = r.choices?.[0];
        const msg = choice?.message ?? {};
        const cutOff = choice?.finish_reason === 'length';
        const toolCalls = ((msg.tool_calls ?? []) as any[]).map((t) => {
          let input: unknown = {};
          let cut = false;
          try { input = JSON.parse(t.function?.arguments || '{}'); } catch { input = {}; cut = true; }
          return { id: String(t.id), name: String(t.function?.name), input, ...(cut && cutOff ? { cut } : {}) };
        });
        const text = typeof msg.content === 'string' ? msg.content : '';
        if (text) onDelta?.(text);
        return {
          text, toolCalls,
          stop: cutOff ? 'max_tokens' : toolCalls.length ? 'tool_use' : 'end',
          usage: { input: r.usage?.prompt_tokens ?? 0, output: r.usage?.completion_tokens ?? 0 },
        };
      });
      }, req, retry);
    },
  };
}
