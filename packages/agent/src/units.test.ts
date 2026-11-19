import { describe, expect, it } from 'vitest';
import { buildPrompt, compactIfNeeded, estimateTokens } from './compaction.ts';
import { fakeProvider } from './fake.ts';
import { stripImages, wireName } from './hullTools.ts';
import { anthropicProvider, openaiProvider, providerConfigFromEnv, DEFAULT_ANTHROPIC_MODEL } from './providers.ts';
import type { Msg } from './types.ts';

const signal = new AbortController().signal;
const reply = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

describe('providers', () => {
  it('picks the provider from the environment without ever echoing a key', () => {
    expect(providerConfigFromEnv({})).toBeUndefined();
    expect(providerConfigFromEnv({ ANTHROPIC_API_KEY: 'k' })).toMatchObject({ kind: 'anthropic' });
    expect(providerConfigFromEnv({ ANTHROPIC_API_KEY: 'k', HULL_AGENT_BASE_URL: 'https://ai.marlstudio.com/v1', HULL_AGENT_API_KEY: 'm', HULL_AGENT_MODEL: 'x' })).toMatchObject({ kind: 'openai', baseUrl: 'https://ai.marlstudio.com/v1', model: 'x' });
  });

  it('speaks the Anthropic Messages API and reads tool calls and usage back', async () => {
    let seen: { url: string; headers: Record<string, string>; body: any } | undefined;
    const p = anthropicProvider({ kind: 'anthropic', apiKey: 'sk-secret', fetch: (async (url: string, init: RequestInit) => { seen = { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) }; return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'config_set', input: { id: 'a' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 4 } })); }) as typeof fetch });
    expect(p.model).toBe(DEFAULT_ANTHROPIC_MODEL);
    const msgs: Msg[] = [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }, { role: 'assistant', parts: [{ type: 'tool_use', id: 't0', name: 'check', input: {} }] }, { role: 'user', parts: [{ type: 'tool_result', id: 't0', text: 'fine' }] }];
    const c = await p.complete({ system: 'sys', messages: msgs, tools: [{ name: 'check', description: 'd', schema: { type: 'object' } }], signal });
    expect(seen!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(seen!.headers['x-api-key']).toBe('sk-secret');
    expect(seen!.body.system).toEqual([{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]);
    expect(seen!.body.stream).toBe(true);
    expect(seen!.body.tools[0].input_schema).toEqual({ type: 'object' });
    expect(seen!.body.tools[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(seen!.body.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't0' });
    expect(c).toMatchObject({ text: 'ok', stop: 'tool_use', usage: { input: 10, output: 4 }, toolCalls: [{ id: 't1', name: 'config_set', input: { id: 'a' } }] });
  });

  it('speaks an OpenAI-compatible endpoint, and an error never contains the key', async () => {
    let body: any;
    const p = openaiProvider({ kind: 'openai', apiKey: 'sk-secret', baseUrl: 'https://ai.marlstudio.com/v1/', model: 'm1', fetch: (async (_u: string, init: RequestInit) => { body = JSON.parse(init.body as string); return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'check', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 7, completion_tokens: 2 } })); }) as typeof fetch });
    expect(p.name).toBe('ai.marlstudio.com');
    const msgs: Msg[] = [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }, { role: 'assistant', parts: [{ type: 'tool_use', id: 'c0', name: 'check', input: {} }] }, { role: 'user', parts: [{ type: 'tool_result', id: 'c0', text: 'fine', images: [{ mime: 'image/png', data: 'AAAA' }] }] }];
    const c = await p.complete({ system: 'sys', messages: msgs, tools: [{ name: 'check', description: 'd', schema: {} }], signal });
    expect(body.messages.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(body.messages[4].content[0].image_url.url).toBe('data:image/png;base64,AAAA');
    expect(c).toMatchObject({ stop: 'tool_use', usage: { input: 7, output: 2 }, toolCalls: [{ id: 'c1', name: 'check', input: {} }] });
    const bad = openaiProvider({ kind: 'openai', apiKey: 'sk-secret', baseUrl: 'https://x/v1', fetch: ((reply({ error: 'bad key sk-secret' }, 401)) as unknown) as typeof fetch });
    const err = await bad.complete({ system: '', messages: msgs, tools: [], signal }).catch((e: Error) => e.message);
    expect(err).toContain('HTTP 401');
    expect(err).not.toContain('sk-secret');
  });
});

describe('tools helpers', () => {
  it('turns dotted names into wire names and lifts pictures out of results', () => {
    expect(wireName('config.set')).toBe('config_set');
    const pics: { mime: string; data: string }[] = [];
    const out = stripImages({ a: { png: 'iVBOR' + 'A'.repeat(3000) }, n: 1 }, pics) as any;
    expect(out.a.png).toBe('[image]');
    expect(pics).toHaveLength(1);
    expect(pics[0]!.mime).toBe('image/png');
  });
});

describe('compaction', () => {
  const turn = (i: number): Msg[] => [
    { role: 'user', parts: [{ type: 'text', text: `task ${i} ${'y'.repeat(1500)}` }] },
    { role: 'assistant', parts: [{ type: 'tool_use', id: `u${i}`, name: 'config_read', input: {} }] },
    { role: 'user', parts: [{ type: 'tool_result', id: `u${i}`, text: 'x'.repeat(2000) }] },
    { role: 'assistant', parts: [{ type: 'text', text: `done ${i}` }] },
  ];

  it('does nothing under the limit', async () => {
    const messages = turn(1);
    expect(await compactIfNeeded({ provider: fakeProvider([], { contextWindow: 100_000 }), system: 's', messages, signal })).toBeUndefined();
    expect(messages).toHaveLength(4);
  });

  it('replaces the old turns with a summary and keeps the recent ones, then updates the summary next time', async () => {
    const fake = fakeProvider([], { contextWindow: 3000 });
    const messages = [1, 2, 3, 4, 5, 6].flatMap(turn);
    const before = estimateTokens('s', messages);
    expect(before).toBeGreaterThan(2100);
    const summary = await compactIfNeeded({ provider: fake, system: 's', messages, signal });
    expect(summary).toContain('## Objective');
    expect(messages[0]!.parts[0]).toMatchObject({ type: 'text' });
    expect((messages[0]!.parts[0] as { text: string }).text).toContain('<conversation-checkpoint>');
    expect(JSON.stringify(messages.at(-1))).toContain('done 6');
    expect(messages.length).toBeLessThan(24);
    expect(estimateTokens('s', messages)).toBeLessThan(before);
    // A second compaction asks for an update of the checkpoint, not a fresh summary.
    messages.push(...[7, 8, 9, 10].flatMap(turn));
    await compactIfNeeded({ provider: fake, system: 's', messages, signal });
    const last = JSON.stringify(fake.calls.at(-1)!.messages);
    expect(last).toContain('Update the existing checkpoint');
  });

  it('copies the template: the prompt names the sections the loop relies on', () => {
    expect(buildPrompt(false)).toContain('## Next Move');
  });
});
