// Provider retries, output limits, parallel reads and compaction triggers, with no network and no sleeping.
import { describe, expect, it } from 'vitest';
import { compactIfNeeded } from './compaction.ts';
import type { HullTools } from './hullTools.ts';
import { run, type RunIo, type SessionState } from './loop.ts';
import { limitsFor } from './models.ts';
import { BASE } from './prompt.ts';
import { INDEPENDENT_STAGES, SHOT_TICKS, STAGES, stageTask } from './stages.ts';
import { anthropicProvider, backoffMs, openaiProvider, providerConfigFromEnv, retryAfterMs } from './providers.ts';
import type { Completion, CompleteRequest, Msg, Provider } from './types.ts';

const signal = new AbortController().signal;
const req = (over: Partial<CompleteRequest> = {}): CompleteRequest => ({ system: 's', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }], tools: [], signal, ...over });
const ok = (text = 'ok') => new Response(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
const status = (code: number, headers: Record<string, string> = {}) => new Response('{"error":"x sk-secret"}', { status: code, headers });
/** A fetch that answers from a list, one per call. */
const seq = (answers: (Response | Error | (() => Response))[]) => {
  const calls: number[] = [];
  const f = (async () => {
    const a = answers[calls.length]!;
    calls.push(1);
    if (a instanceof Error) throw a;
    return typeof a === 'function' ? a() : a;
  }) as unknown as typeof fetch;
  return { f, calls };
};
const sleeps = () => { const waits: number[] = []; return { waits, sleep: async (ms: number) => { waits.push(ms); } }; };
const sseOf = (lines: string[], breakAfter = false): Response => {
  const enc = new TextEncoder();
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (!sent) { sent = true; c.enqueue(enc.encode(lines.join('\n'))); return; }
      if (breakAfter) c.error(new TypeError('terminated')); else c.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
};
const textDelta = (t: string) => ['data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":' + JSON.stringify(t) + '}}', ''];
const START = ['data: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":1}}}', '', 'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}', ''];
const END = ['data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}', '', 'data: {"type":"message_stop"}', '', ''];

describe('provider errors', () => {
  it('retries 529, 429 and 5xx with jittered backoff, honouring Retry-After, and never sleeps for real', async () => {
    const { f, calls } = seq([status(529, { 'retry-after': '3' }), status(429), status(503), ok('done')]);
    const s = sleeps();
    const p = anthropicProvider({ kind: 'anthropic', apiKey: 'sk-secret', fetch: f, sleep: s.sleep, random: () => 0.5 });
    expect((await p.complete(req())).text).toBe('done');
    expect(calls).toHaveLength(4);
    // 1st: Retry-After 3 s beats the 750 ms backoff. 2nd: 2 s doubled base, half jitter at 0.5 = 1500. 3rd: 4 s base = 3000.
    expect(s.waits).toEqual([3000, 1500, 3000]);
  });

  it('retries 408 and 409, a connection that fails, and an HTTP-date Retry-After', async () => {
    const { f, calls } = seq([status(408), status(409), new TypeError('fetch failed'), ok()]);
    const s = sleeps();
    const p = openaiProvider({ kind: 'openai', apiKey: 'k', baseUrl: 'https://x/v1', fetch: (async (...a: unknown[]) => { const r = await (f as any)(...a); return r.status === 200 ? new Response(JSON.stringify({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] })) : r; }) as typeof fetch, sleep: s.sleep, random: () => 0 });
    expect((await p.complete(req())).text).toBe('hi');
    expect(calls).toHaveLength(4);
    expect(s.waits).toEqual([500, 1000, 2000]);
    expect(retryAfterMs('Thu, 01 Jan 2026 00:00:10 GMT', Date.parse('2026-01-01T00:00:00Z'))).toBe(10_000);
    expect(retryAfterMs('2')).toBe(2000);
    expect(retryAfterMs(null)).toBeUndefined();
    expect(backoffMs(10, undefined, () => 1)).toBe(60_000);
  });

  it('does not retry other client errors, and gives up after 5 tries with the key taken out', async () => {
    const one = seq([status(401)]);
    const s = sleeps();
    const p1 = anthropicProvider({ kind: 'anthropic', apiKey: 'sk-secret', fetch: one.f, sleep: s.sleep });
    await expect(p1.complete(req())).rejects.toThrow(/HTTP 401 .*\*\*\*/);
    expect(one.calls).toHaveLength(1);
    const many = seq([status(500), status(500), status(500), status(500), status(500), ok()]);
    const p2 = anthropicProvider({ kind: 'anthropic', apiKey: 'sk-secret', fetch: many.f, sleep: s.sleep });
    const err = await p2.complete(req()).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/HTTP 500/);
    expect((err as Error).message).not.toContain('sk-secret');
    expect(many.calls).toHaveLength(5);
    expect(s.waits).toHaveLength(4);
  });

  it('retries a stream that breaks midway once, without showing the first words twice', async () => {
    const first = sseOf([...START, ...textDelta('Hello wor')], true);
    const second = sseOf([...START, ...textDelta('Hello world, again'), ...END]);
    const { f, calls } = seq([first, second]);
    const s = sleeps();
    const shown: string[] = [];
    const p = anthropicProvider({ kind: 'anthropic', apiKey: 'k', fetch: f, sleep: s.sleep });
    const c = await p.complete(req({ onDelta: (t) => shown.push(t) }));
    expect(calls).toHaveLength(2);
    expect(c.text).toBe('Hello world, again');
    expect(shown.join('')).toBe('Hello world, again');
    expect(s.waits).toHaveLength(1);
  });

  it('treats a stream that ends with no stop reason as broken, and a second break as an error', async () => {
    const cut = () => sseOf([...START, ...textDelta('half')]);
    const { f, calls } = seq([cut(), cut(), ok('never')]);
    const p = anthropicProvider({ kind: 'anthropic', apiKey: 'k', fetch: f, sleep: sleeps().sleep });
    await expect(p.complete(req())).rejects.toThrow(/before the answer was complete/);
    expect(calls).toHaveLength(2);
  });
});

describe('output limits', () => {
  it('asks for the model table\'s max output, not 8192, and lets the environment override it', async () => {
    const bodies: any[] = [];
    const f = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(init.body as string)); return ok(); }) as unknown as typeof fetch;
    await anthropicProvider({ kind: 'anthropic', apiKey: 'k', fetch: f }).complete(req());
    await anthropicProvider({ kind: 'anthropic', apiKey: 'k', model: 'claude-sonnet-5-5', fetch: f }).complete(req());
    await anthropicProvider({ kind: 'anthropic', apiKey: 'k', model: 'some-new-model', fetch: f }).complete(req());
    const cfg = providerConfigFromEnv({ ANTHROPIC_API_KEY: 'k', HULL_AGENT_MAX_TOKENS: '1234', HULL_AGENT_CONTEXT: '50000' })!;
    const over = anthropicProvider({ ...cfg, fetch: f });
    await over.complete(req());
    expect(bodies.map((b) => b.max_tokens)).toEqual([32_000, 64_000, 16_000, 1234]);
    expect(over.contextWindow).toBe(50_000);
    expect(limitsFor('openai', 'anthropic/claude-haiku-4-5').maxOutput).toBe(32_000);
    expect(limitsFor('openai', 'whatever')).toEqual({ context: 128_000, maxOutput: 8192 });
  });

  it('keeps stop max_tokens when the answer holds a cut tool call', async () => {
    const f = (async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'writing' }, { type: 'tool_use', id: 't', name: 'code_write', input: {} }], stop_reason: 'max_tokens', usage: {} }))) as unknown as typeof fetch;
    const c = await anthropicProvider({ kind: 'anthropic', apiKey: 'k', fetch: f }).complete(req());
    expect(c.stop).toBe('max_tokens');
    expect(c.toolCalls[0]).toMatchObject({ id: 't', cut: true });
  });
});

// A loop with a scripted model and a stand-in for the tools, so each rule can be seen on its own.
type Step = Partial<Completion> & { usageIn?: number };
function harness(steps: Step[], opts: { contextWindow?: number; onSummary?: () => void; failSummary?: boolean } = {}) {
  const requests: CompleteRequest[] = [];
  let i = 0;
  let summaries = 0;
  const provider: Provider = {
    name: 't', model: 't', contextWindow: opts.contextWindow ?? 200_000,
    async complete(r) {
      requests.push({ ...r, messages: structuredClone(r.messages) });
      if (r.tools.length === 0) {
        summaries++;
        if (opts.failSummary) throw new Error('summary failed');
        return { text: '## Objective\n- x', toolCalls: [], stop: 'end', usage: { input: 1, output: 1 } };
      }
      const s = steps[i++] ?? { text: 'end' };
      return { text: s.text ?? '', toolCalls: s.toolCalls ?? [], stop: s.stop ?? (s.toolCalls?.length ? 'tool_use' : 'end'), usage: { input: s.usageIn ?? 10, output: 5 } };
    },
  };
  const log: string[] = [];
  let active = 0;
  let peak = 0;
  const READS = new Set(['config.read', 'code.read', 'docs.read']);
  const tools = {
    specs: ['config_read', 'code_read', 'docs_read', 'code_write', 'game_run'].map((name) => ({ name, description: '', schema: {} })),
    hullName: (w: string) => w.replace('_', '.'),
    kind: (n: string) => (READS.has(n) ? 'read' : 'execute'),
    isWrite: (n: string) => n === 'code.write',
    changesGame: (n: string) => n === 'code.write',
    isRisky: () => false,
    isReadOnly: (n: string) => READS.has(n),
    call: async (n: string) => {
      log.push('start ' + n);
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      log.push('end ' + n);
      return { text: 'ok', ok: true, value: {}, images: [] };
    },
  } as unknown as HullTools;
  const s: SessionState = { provider, tools, system: 'sys', history: [], permissions: 'none', allowed: new Set(), plan: [], maxFixRounds: 2, maxSteps: 20, runs: 0, mode: 'build', uiCount: 0 };
  const events: string[] = [];
  const io: RunIo = {
    text: () => {}, plan: () => {}, ui: () => {}, usage: () => {}, ask: async () => undefined, permission: async () => 'allow_once',
    toolStart: (c) => events.push('start ' + c.id), toolEnd: (c) => events.push('end ' + c.id + (c.ok ? '' : ' failed')),
    compaction: (st) => events.push('compaction ' + st),
  };
  return { s, io, requests, log, events, peak: () => peak, summaries: () => summaries, go: (text = 'go') => run(s, [{ type: 'text', text }], io, signal) };
}
const call = (id: string, name: string, extra: object = {}) => ({ id, name, input: {}, ...extra });

describe('a cut answer is not the end of the turn', () => {
  it('asks a cut text to continue, from where it stopped', async () => {
    const h = harness([{ text: 'part one', stop: 'max_tokens' }, { text: 'part two' }]);
    const r = await h.go();
    expect(r.steps).toBe(2);
    expect(r.text).toBe('part two');
    const last = h.requests[1]!.messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(JSON.stringify(last)).toContain('cut off at the output limit');
  });

  it('answers a cut tool call with an error that says to write the file in smaller parts, and does not run it', async () => {
    const h = harness([{ toolCalls: [call('a', 'config_read'), call('b', 'code_write', { cut: true })], stop: 'max_tokens' }, { text: 'ok, smaller' }]);
    const r = await h.go();
    expect(r.steps).toBe(2);
    expect(h.log).toEqual(['start config.read', 'end config.read']);
    const results = (h.requests[1]!.messages.at(-1) as Msg).parts;
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ type: 'tool_result', id: 'a', text: 'ok' });
    expect(results[1]).toMatchObject({ type: 'tool_result', id: 'b', isError: true });
    expect((results[1] as { text: string }).text).toMatch(/cut .*smaller parts/);
  });

  it('stops after the answer is cut again and again', async () => {
    const h = harness(Array.from({ length: 10 }, () => ({ text: 'x', stop: 'max_tokens' as const })));
    const r = await h.go();
    expect(r.steps).toBe(5);
  });
});

describe('tool calls in one turn', () => {
  it('run side by side when they only read, and anything else waits for the reads before it', async () => {
    const h = harness([{ toolCalls: [call('1', 'config_read'), call('2', 'code_read'), call('3', 'docs_read'), call('4', 'game_run'), call('5', 'config_read')] }, { text: 'done' }]);
    await h.go();
    expect(h.peak()).toBe(3);
    expect(h.log.slice(0, 6).sort()).toEqual(['end code.read', 'end config.read', 'end docs.read', 'start code.read', 'start config.read', 'start docs.read']);
    // the game call started only after all three reads ended; the last read only after the write ended
    expect(h.log.slice(6)).toEqual(['start game.run', 'end game.run', 'start config.read', 'end config.read']);
    // results come back in the order of the calls
    const ids = ((h.requests[1]!.messages.at(-1) as Msg).parts as { id: string }[]).map((p) => p.id);
    expect(ids).toEqual(['1', '2', '3', '4', '5']);
  });

  it('keeps game steps and reads in the order the model wrote them', async () => {
    const h = harness([{ toolCalls: [call('1', 'game_run'), call('2', 'config_read'), call('3', 'game_run')] }, { text: 'done' }]);
    await h.go();
    expect(h.peak()).toBe(1);
  });
});

describe('compaction trigger', () => {
  const big: Msg[] = [{ role: 'user', parts: [{ type: 'text', text: 'start' }] }, { role: 'assistant', parts: [{ type: 'text', text: 'a' }] }, { role: 'user', parts: [{ type: 'text', text: 'again' }] }, { role: 'assistant', parts: [{ type: 'text', text: 'b' }] }, { role: 'user', parts: [{ type: 'text', text: 'more' }] }];
  const p = (): Provider => ({ name: 't', model: 't', contextWindow: 1000, complete: async () => ({ text: '## Objective\n- x', toolCalls: [], stop: 'end', usage: { input: 1, output: 1 } }) });

  it('uses the tokens the provider reported when it has them, not the 4-characters guess', async () => {
    const guess = await compactIfNeeded({ provider: p(), system: 's', messages: structuredClone(big), signal });
    expect(guess).toBeUndefined();
    const reported = await compactIfNeeded({ provider: p(), system: 's', messages: structuredClone(big), signal, reportedTokens: 900 });
    expect(reported).toContain('## Objective');
    expect(await compactIfNeeded({ provider: p(), system: 's', messages: structuredClone(big), signal, reportedTokens: 600 })).toBeUndefined();
  });

  it('starts from the provider count in the loop', async () => {
    const h = harness([{ toolCalls: [call('1', 'config_read')], usageIn: 900 }, { toolCalls: [call('2', 'config_read')], usageIn: 100 }, { text: 'done', usageIn: 100 }], { contextWindow: 1000 });
    h.s.history.push(...structuredClone(big), { role: 'assistant', parts: [{ type: 'text', text: 'c' }] });
    await h.go('x');
    expect(h.events.filter((e) => e === 'compaction in_progress')).toHaveLength(1);
    expect(h.summaries()).toBe(1);
  });

  it('does not retry a failed compaction on every step', async () => {
    const calls = Array.from({ length: 6 }, (_, i) => ({ toolCalls: [call('c' + i, 'config_read')], usageIn: 900 }));
    const h = harness([...calls, { text: 'done', usageIn: 900 }], { contextWindow: 1000, failSummary: true });
    h.s.history.push(...structuredClone(big), { role: 'assistant', parts: [{ type: 'text', text: 'c' }] });
    await h.go('x');
    const failed = h.events.filter((e) => e === 'compaction failed').length;
    expect(failed).toBeLessThanOrEqual(2);
    expect(failed).toBeGreaterThanOrEqual(1);
    expect(h.summaries()).toBeLessThanOrEqual(4); // each failed attempt asks twice at most (the nudge), not once per step
  });
});

describe('the prompt', () => {
  it('names the control ops and the order of checks', () => {
    for (const w of ['How to verify', 'state', 'inspect', 'until', 'errors', 'perf', 'frames', 'restart', 'game_recent', 'game_moment', 'check, then test, then step the game and read errors, and only then take a screenshot']) expect(BASE).toContain(w);
  });
});

describe('stages', () => {
  it('seeds a retry with why the first attempt stopped and what it said it made', () => {
    const t = stageTask(STAGES[0]!, { brief: 'b', docs: [], earlier: [], retry: { reason: 'the check still fails: x.ts:1:1', summary: 'Made a floor.' } });
    expect(t).toContain('A first attempt at this stage stopped because the check still fails: x.ts:1:1');
    expect(t).toContain('Made a floor.');
    expect(stageTask(STAGES[0]!, { brief: 'b', docs: [], earlier: [] })).not.toContain('first attempt');
  });
  it('lets only the stages that build on nothing run after a failure, and steps the game 60 ticks before the picture', () => {
    expect(INDEPENDENT_STAGES).toEqual(['sounds', 'effects', 'screens']);
    expect(SHOT_TICKS).toBe(60);
  });
});
