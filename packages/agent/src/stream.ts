// Server-sent-event parsing for streaming model replies. Everything here is pure (strings in, a Completion out) so the
// tests can feed recorded streams with no network. The providers read the HTTP body and push each piece in.
import type { Completion, Part } from './types.ts';

export interface SseEvent { event?: string; data: string }

/** Splits a byte stream's text into SSE events. Feed it chunks as they arrive; a chunk may end mid-line. */
export class SseSplitter {
  private buf = '';
  private event: string | undefined;
  private data: string[] = [];

  push(chunk: string): SseEvent[] {
    this.buf += chunk;
    const out: SseEvent[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      let line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        if (this.data.length) out.push({ ...(this.event ? { event: this.event } : {}), data: this.data.join('\n') });
        this.event = undefined;
        this.data = [];
      } else if (line.startsWith(':')) {
        // a comment, used as a keep-alive
      } else if (line.startsWith('event:')) this.event = line.slice(6).trim();
      else if (line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /, ''));
    }
    return out;
  }

  /** The stream ended: an event with no blank line after it still counts. */
  end(): SseEvent[] {
    return this.push('\n\n');
  }
}

/** Reads a fetch body to its end, handing each event to `onEvent`. */
export async function readSse(body: ReadableStream<Uint8Array>, onEvent: (e: SseEvent) => void, signal?: AbortSignal): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  const split = new SseSplitter();
  try {
    while (true) {
      if (signal?.aborted) throw new Error('aborted');
      const { done, value } = await reader.read();
      if (done) break;
      for (const e of split.push(dec.decode(value, { stream: true }))) onEvent(e);
    }
    for (const e of split.end()) onEvent(e);
  } finally { reader.releaseLock(); }
}

const asRec = (v: unknown): Record<string, any> => (v && typeof v === 'object' ? (v as Record<string, any>) : {});

/** Whether a tool call's streamed arguments are a whole JSON text (an empty one counts: a call with no arguments). */
const jsonWhole = (json: string): boolean => {
  if (!json.trim()) return true;
  try { JSON.parse(json); return true; } catch { return false; }
};

const parseInput = (json: string): unknown => {
  if (!json.trim()) return {};
  try { return JSON.parse(json); } catch { return {}; }
};

/** Anthropic Messages API stream: message_start, content_block_start/delta/stop, message_delta, message_stop, error. */
export class AnthropicStream {
  text = '';
  private blocks = new Map<number, { type: string; id: string; name: string; json: string; text: string; raw: Record<string, unknown> }>();
  private stopDetails: Record<string, any> | undefined;
  private inputTokens = 0;
  private outputTokens = 0;
  private stopReason: string | undefined;
  private stopped = false;

  constructor(private onDelta?: (t: string) => void, private secret = '') {}

  push(e: SseEvent): void {
    if (e.data === '[DONE]') return;
    let d: Record<string, any>;
    try { d = asRec(JSON.parse(e.data)); } catch { return; }
    switch (d['type'] ?? e.event) {
      case 'message_stop': this.stopped = true; return;
      case 'message_start': {
        const u = asRec(asRec(d['message'])['usage']);
        this.inputTokens = (u['input_tokens'] ?? 0) + (u['cache_read_input_tokens'] ?? 0) + (u['cache_creation_input_tokens'] ?? 0);
        this.outputTokens = u['output_tokens'] ?? 0;
        return;
      }
      case 'content_block_start': {
        const b = asRec(d['content_block']);
        // A thinking block is kept whole: the API wants it back unchanged, signature included.
        this.blocks.set(d['index'] ?? 0, { type: String(b['type']), id: String(b['id'] ?? ''), name: String(b['name'] ?? ''), json: '', text: '', raw: { ...b } });
        return;
      }
      case 'content_block_delta': {
        const dl = asRec(d['delta']);
        if (dl['type'] === 'text_delta' && typeof dl['text'] === 'string' && dl['text']) {
          this.text += dl['text'];
          const i = d['index'] ?? 0;
          const b = this.blocks.get(i) ?? { type: 'text', id: '', name: '', json: '', text: '', raw: {} };
          b.text += dl['text'];
          this.blocks.set(i, b);
          this.onDelta?.(dl['text']);
        } else if (dl['type'] === 'thinking_delta') { const b = this.blocks.get(d['index'] ?? 0); if (b) b.raw['thinking'] = String(b.raw['thinking'] ?? '') + String(dl['thinking'] ?? ''); }
        else if (dl['type'] === 'signature_delta') { const b = this.blocks.get(d['index'] ?? 0); if (b) b.raw['signature'] = String(b.raw['signature'] ?? '') + String(dl['signature'] ?? ''); }
        else if (dl['type'] === 'input_json_delta') { const b = this.blocks.get(d['index'] ?? 0); if (b) b.json += String(dl['partial_json'] ?? ''); }
        return;
      }
      case 'message_delta': {
        const dl = asRec(d['delta']);
        if (dl['stop_reason']) this.stopReason = String(dl['stop_reason']);
        if (dl['stop_details'] && typeof dl['stop_details'] === 'object') this.stopDetails = dl['stop_details'];
        else if (d['stop_details'] && typeof d['stop_details'] === 'object') this.stopDetails = d['stop_details'];
        const u = asRec(d['usage']);
        if (typeof u['output_tokens'] === 'number') this.outputTokens = u['output_tokens'];
        if (typeof u['input_tokens'] === 'number' && u['input_tokens'] > 0) this.inputTokens = u['input_tokens'] + (u['cache_read_input_tokens'] ?? 0) + (u['cache_creation_input_tokens'] ?? 0);
        return;
      }
      case 'error': {
        const msg = String(asRec(d['error'])['message'] ?? 'unknown error');
        throw new Error(`model stream failed: ${this.secret ? msg.split(this.secret).join('***') : msg}`);
      }
      default: return;
    }
  }

  /** The stream ended with no stop reason: the connection dropped before the answer was done. */
  incomplete(): boolean { return this.stopReason === undefined && !this.stopped; }

  result(): Completion {
    const cutOff = this.stopReason === 'max_tokens';
    const ordered = [...this.blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
    const parts: Part[] = [];
    for (const b of ordered) {
      if (b.type === 'thinking' || b.type === 'redacted_thinking') parts.push({ type: 'thinking', block: b.raw });
      else if (b.type === 'tool_use') parts.push({ type: 'tool_use', id: b.id, name: b.name, input: parseInput(b.json) });
      else if (b.text) parts.push({ type: 'text', text: b.text });
    }
    const toolCalls = ordered.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: parseInput(b.json), ...(cutOff && !jsonWhole(b.json) ? { cut: true } : {}) }));
    const refused = this.stopReason === 'refusal';
    return {
      text: this.text, toolCalls, parts,
      stop: refused ? 'refusal' : cutOff ? 'max_tokens' : toolCalls.length ? 'tool_use' : 'end',
      ...(refused ? { refusal: { category: this.stopDetails?.['category'] ?? null, explanation: this.stopDetails?.['explanation'] ?? null } } : {}),
      usage: { input: this.inputTokens, output: this.outputTokens },
    };
  }
}

/** OpenAI-compatible chat stream: "data: {choices:[{delta}]}" chunks, tool-call arguments in pieces, then [DONE]. */
export class OpenAIStream {
  text = '';
  private calls = new Map<number, { id: string; name: string; args: string }>();
  private finish: string | undefined;
  private usage = { input: 0, output: 0 };

  constructor(private onDelta?: (t: string) => void, private secret = '') {}

  push(e: SseEvent): void {
    if (e.data === '[DONE]') return;
    let d: Record<string, any>;
    try { d = asRec(JSON.parse(e.data)); } catch { return; }
    if (d['error']) {
      const msg = String(asRec(d['error'])['message'] ?? JSON.stringify(d['error']));
      throw new Error(`model stream failed: ${this.secret ? msg.split(this.secret).join('***') : msg}`);
    }
    const u = asRec(d['usage']);
    if (typeof u['prompt_tokens'] === 'number') this.usage = { input: u['prompt_tokens'], output: u['completion_tokens'] ?? 0 };
    const choice = asRec((d['choices'] ?? [])[0]);
    const delta = asRec(choice['delta']);
    if (typeof delta['content'] === 'string' && delta['content']) { this.text += delta['content']; this.onDelta?.(delta['content']); }
    for (const t of (delta['tool_calls'] ?? []) as any[]) {
      const i = typeof t.index === 'number' ? t.index : 0;
      const c = this.calls.get(i) ?? { id: '', name: '', args: '' };
      if (t.id) c.id = String(t.id);
      if (t.function?.name) c.name += String(t.function.name);
      if (t.function?.arguments) c.args += String(t.function.arguments);
      this.calls.set(i, c);
    }
    if (choice['finish_reason']) this.finish = String(choice['finish_reason']);
  }

  result(): Completion {
    const cutOff = this.finish === 'length';
    const toolCalls = [...this.calls.entries()].sort((a, b) => a[0] - b[0]).map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, input: parseInput(c.args), ...(cutOff && !jsonWhole(c.args) ? { cut: true } : {}) }));
    return { text: this.text, toolCalls, stop: cutOff ? 'max_tokens' : toolCalls.length ? 'tool_use' : 'end', usage: this.usage };
  }
}

/** Runs a whole recorded stream (a string) through a parser: the tests' entry point. */
export function replay<T extends { push(e: SseEvent): void; result(): Completion }>(parser: T, raw: string, chunk = 17): Completion {
  const split = new SseSplitter();
  for (let i = 0; i < raw.length; i += chunk) for (const e of split.push(raw.slice(i, i + chunk))) parser.push(e);
  for (const e of split.end()) parser.push(e);
  return parser.result();
}
