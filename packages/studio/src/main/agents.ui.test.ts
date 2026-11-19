import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProject } from '@hull/tools/server';
import type { GameMoment, UiBlock } from 'hull/dev/protocol';
import type { AgentEvent } from '../shared/agentApi.ts';
import { promptBlocks, promptMeta } from './agents.ts';
import { agentEnv, createSettingsStore, NEEDS_KEY } from './agentSettings.ts';
import { createHost, type Host } from './host.ts';

const moment: GameMoment = { tick: 720, time: 12.4, png: 'AAAA', width: 2, height: 2, recent: [{ at: 12.1, kind: 'sound', id: 'sound/clash', label: 'Clash' }, { at: 11.9, kind: 'vfx', id: 'vfx/sparks', label: 'Sparks' }] };

describe('prompt shape', () => {
  it('a plain prompt is one text block with no meta', () => {
    expect(promptBlocks('hello')).toEqual([{ type: 'text', text: 'hello' }]);
    expect(promptMeta()).toBeUndefined();
    expect(promptMeta({})).toBeUndefined();
  });
  it('carries the mode and stage in _meta', () => {
    expect(promptMeta({ mode: 'build', stage: 'sounds' })).toEqual({ 'hull.mode': 'build', 'hull.stage': 'sounds' });
    expect(promptMeta({ mode: 'fix' })).toEqual({ 'hull.mode': 'fix' });
  });
  it('a frozen moment is the note, the screenshot, then the moment line with what to look at', () => {
    const b = promptBlocks('too quiet', { mode: 'fix', moment, about: ['sound/clash', 'explain:raider-turn'] });
    expect(b).toHaveLength(3);
    expect(b[0]).toEqual({ type: 'text', text: 'too quiet' });
    expect(b[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'AAAA' });
    expect(b[2]).toEqual({ type: 'text', text: 'Moment: time 12.4 s, tick 720. Just now: sound sound/clash (Clash), vfx vfx/sparks (Sparks)\nAbout: sound/clash, explain:raider-turn' });
  });
  it('a note about pieces without a moment gets an About line only', () => {
    expect(promptBlocks('softer', { about: ['sound/pickup'] })).toEqual([{ type: 'text', text: 'softer' }, { type: 'text', text: 'About: sound/pickup' }]);
  });
});

describe('settings', () => {
  const crypto = { available: () => true, encrypt: (s: string) => Buffer.from('x' + s).toString('base64'), decrypt: (b: string) => Buffer.from(b, 'base64').toString().slice(1) };
  it('keeps the key out of what the page gets, and lays it over the agent environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hull-set-'));
    try {
      const store = createSettingsStore({ dataDir: dir, crypto, env: {} });
      expect(await store.get()).toMatchObject({ provider: 'anthropic', hasKey: false, source: 'app' });
      expect(await store.needs({})).toBe(NEEDS_KEY);
      const saved = await store.set({ provider: 'openai', apiKey: 'sk-secret-123', baseUrl: 'https://ai.example.com/v1', model: 'm1' });
      expect(saved).toEqual({ provider: 'openai', hasKey: true, baseUrl: 'https://ai.example.com/v1', model: 'm1', source: 'app' });
      expect(JSON.stringify(await store.get())).not.toContain('sk-secret');
      // On disk the key is encrypted.
      expect(readFileSync(join(dir, 'agent-settings.json'), 'utf8')).not.toContain('sk-secret');
      const env = await store.env({ ANTHROPIC_API_KEY: 'other' });
      expect(env).toMatchObject({ HULL_AGENT_BASE_URL: 'https://ai.example.com/v1', HULL_AGENT_API_KEY: 'sk-secret-123', HULL_AGENT_MODEL: 'm1' });
      expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
      expect(await store.needs({})).toBeNull();
      // Saving again without a key keeps the old one; switching to Anthropic changes the names.
      await store.set({ provider: 'anthropic' });
      expect(await store.env({ HULL_AGENT_BASE_URL: 'x' })).toMatchObject({ ANTHROPIC_API_KEY: 'sk-secret-123' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('in web mode the environment decides and a save says so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hull-set-'));
    try {
      const store = createSettingsStore({ dataDir: dir, env: { ANTHROPIC_API_KEY: 'k' } });
      expect(await store.get()).toEqual({ provider: 'anthropic', hasKey: true, source: 'environment' });
      await expect(store.set({ provider: 'anthropic', apiKey: 'k2' })).rejects.toThrow(/environment/);
      expect(agentEnv({ A: '1' }, null, null)).toEqual({ A: '1' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// The hub against the scripted agent in its brief, build and fix modes: the cards arrive as ui events, real state is written
// through the MCP server, and a waiting card is answered with agentAnswer.
const fixture = join(import.meta.dirname, 'fixtures', 'fake-acp-agent.mjs');
let dir = ''; let host: Host; let root = '';
const events: AgentEvent[] = [];

describe('the conversation, against the scripted agent', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'hull-ui-'));
    root = join(dir, 'game');
    await createProject({ template: 'arena', dir: root, title: 'UI arena' });
    const env = { ...process.env, HULL_ENSURE_AGENT: 'fake', HULL_ACP_AGENTS: JSON.stringify([{ id: 'fake', name: 'Fake agent', command: process.execPath, args: [fixture] }]) };
    host = createHost({ dataDir: join(dir, 'data'), env });
    host.onAgentEvent((e) => events.push(e));
    await host.openProject(root);
  }, 120_000);
  afterAll(async () => { await host.closeProject(); rmSync(dir, { recursive: true, force: true }); });

  const waitFor = async (pred: () => boolean, ms = 60_000): Promise<void> => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error('timed out: ' + JSON.stringify(events.slice(-5))); await new Promise((r) => setTimeout(r, 30)); } };
  const uis = (): Extract<AgentEvent, { type: 'ui' }>[] => events.filter((e): e is Extract<AgentEvent, { type: 'ui' }> => e.type === 'ui');
  const blocks = (kind: UiBlock['kind']): UiBlock[] => uis().map((u) => u.block).filter((b) => b.kind === kind);
  const doneCount = (): number => events.filter((e) => e.type === 'done').length;

  it('ensure starts one builder and gives the same session again', async () => {
    const a = await host.agents.ensure();
    const b = await host.agents.ensure();
    expect(a).toHaveProperty('sid');
    expect(b).toEqual(a);
  }, 60_000);

  it('brief mode: streamed text, an ask that waits, brief cards that fill, an approve that sets briefApproved', async () => {
    events.length = 0;
    const { sid } = (await host.agents.ensure()) as { sid: string };
    await host.agents.prompt(sid, 'A samurai game on an island', { mode: 'brief' });
    await waitFor(() => uis().some((u) => u.reqId && u.block.kind === 'ask'));
    const ask = uis().find((u) => u.block.kind === 'ask')!;
    expect(ask.block).toMatchObject({ kind: 'ask', question: 'Who do you play?' });
    // Text came as several chunks before the card.
    expect(events.filter((e) => e.type === 'message').length).toBeGreaterThan(3);
    await host.agents.answer(sid, ask.reqId!, '0');
    await waitFor(() => uis().some((u) => u.reqId && u.block.kind === 'approve'));
    expect(events.find((e) => e.type === 'permission-done')).toMatchObject({ reqId: ask.reqId, optionId: '0' });
    const briefs = blocks('brief') as Extract<UiBlock, { kind: 'brief' }>[];
    expect(briefs.length).toBeGreaterThanOrEqual(3);
    expect(briefs.every((b) => b.id === 'brief')).toBe(true);
    expect(briefs.some((b) => b.sections.some((s) => s.status === 'writing'))).toBe(true);
    expect(briefs.at(-1)!.sections.map((s) => s.id)).toEqual(['premise', 'what-you-do', 'controls']);
    const ok = uis().find((u) => u.block.kind === 'approve')!;
    await host.agents.answer(sid, ok.reqId!, 'yes');
    await waitFor(() => doneCount() === 1);
    expect(existsSync(join(root, 'GAME.md'))).toBe(true);
    expect(readFileSync(join(root, 'GAME.md'), 'utf8')).toContain('## Premise');
    const state = JSON.parse(readFileSync(join(root, '.hull', 'create.json'), 'utf8')) as { briefApproved: boolean };
    expect(state.briefApproved).toBe(true);
  }, 90_000);

  it('typing instead of answering cancels the card and ends the run', async () => {
    events.length = 0;
    const { sid } = (await host.agents.ensure()) as { sid: string };
    // A fresh session so the interview starts over.
    await host.agents.stopEnsured();
    const second = (await host.agents.ensure()) as { sid: string };
    expect(second.sid).not.toBe(sid);
    await host.agents.prompt(second.sid, 'another game', { mode: 'brief' });
    await waitFor(() => uis().some((u) => u.reqId));
    await host.agents.answer(second.sid, uis().find((u) => u.reqId)!.reqId!, null);
    await waitFor(() => doneCount() === 1);
    expect(events.find((e) => e.type === 'permission-done')).toMatchObject({ optionId: null });
  }, 60_000);

  it('build mode for one stage: stages, pieces and explain cards, and the state is real', async () => {
    events.length = 0;
    const { sid } = (await host.agents.ensure()) as { sid: string };
    await host.agents.prompt(sid, 'Build the rules stage', { mode: 'build', stage: 'rules' });
    await waitFor(() => doneCount() === 1);
    const stages = blocks('stages') as Extract<UiBlock, { kind: 'stages' }>[];
    expect(stages.at(-1)!.stages.find((s) => s.id === 'rules')).toMatchObject({ status: 'ready', pieces: ['explain:raider-turn'] });
    expect(blocks('pieces')[0]).toMatchObject({ kind: 'pieces', stage: 'rules', keys: ['explain:raider-turn'] });
    const ex = blocks('explain')[0] as Extract<UiBlock, { kind: 'explain' }>;
    expect(ex.doc.body.type).toBe('flow');
    expect(existsSync(join(root, '.hull', 'explain', 'raider-turn.json'))).toBe(true);
  }, 60_000);

  it('fix mode with a frozen moment: the agent sees the screenshot and answers with a change card that names a history change', async () => {
    events.length = 0;
    const { sid } = (await host.agents.ensure()) as { sid: string };
    await host.agents.prompt(sid, 'too slow', { mode: 'fix', moment, about: ['tunables:player'] });
    await waitFor(() => doneCount() === 1);
    const change = blocks('change')[0] as Extract<UiBlock, { kind: 'change' }>;
    expect(change).toMatchObject({ kind: 'change', piece: 'Player numbers' });
    expect(change.change).toBeTruthy();
    const said = events.filter((e): e is Extract<AgentEvent, { type: 'message' }> => e.type === 'message').map((e) => e.text).join('');
    expect(said).toContain('frozen picture');
  }, 60_000);

  it('without a key Hull\'s own agent is not started and ensure says what is missing', async () => {
    const d2 = mkdtempSync(join(tmpdir(), 'hull-ui2-'));
    try {
      const env = { PATH: process.env['PATH'] } as NodeJS.ProcessEnv;
      const h = createHost({ dataDir: d2, env });
      await h.openProject(root);
      expect(await h.agents.ensure()).toEqual({ needs: NEEDS_KEY });
      await h.closeProject();
    } finally { rmSync(d2, { recursive: true, force: true }); }
  }, 60_000);
});
void writeFileSync;
