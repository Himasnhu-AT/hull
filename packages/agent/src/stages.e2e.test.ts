import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import type { CreateState, ExplainDoc, UiBlock } from 'hull/dev/protocol';
import { createProject, startProjectServer, type ProjectServer } from '@hull/tools/server';
import { runTool } from '@hull/tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHullAgent } from './agent.ts';
import { fakeFromPath, fakeProvider, type FakeScript } from './fake.ts';
import { STAGES, missingExplain, stageTask, testsCouldNotRun } from './stages.ts';
import type { Provider } from './types.ts';

// The whole flow against a project made from the arena template, with the scripted model of packages/agent/fixtures/arena:
// brief (two questions, nine sections, a change, approval) then the build, stage by stage.
const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'arena');
let root: string;
let dir: string;
let server: ProjectServer;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'hull-stages-'));
  dir = join(root, 'game');
  await createProject({ template: 'arena', dir, title: 'Gem Run' });
  server = await startProjectServer({ root: dir, port: 0, historyQuietMs: 60_000 });
}, 90_000);

afterAll(async () => {
  await server?.close();
  rmSync(root, { recursive: true, force: true });
});

interface Seen { updates: acp.SessionUpdate[]; asked: acp.RequestPermissionRequest[] }
type Providers = Provider | Partial<Record<'brief' | 'build' | 'fix', Provider>>;

async function session<T>(provider: Providers, decide: (r: acp.RequestPermissionRequest) => string | 'cancel', body: (c: { prompt(text: string, meta?: Record<string, unknown>): Promise<acp.PromptResponse>; seen: Seen }) => Promise<T>, opts: { maxFixRounds?: number; stageSteps?: number } = {}): Promise<T> {
  const up = new TransformStream<acp.AnyMessage>();
  const down = new TransformStream<acp.AnyMessage>();
  const agent = startHullAgent({ projectRoot: dir, provider, stream: { readable: up.readable, writable: down.writable }, log: () => {}, ...opts });
  const seen: Seen = { updates: [], asked: [] };
  const app = acp.client({ name: 'test-client' })
    .onNotification(acp.methods.client.session.update, ({ params }) => { seen.updates.push(params.update); })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      seen.asked.push(params);
      const d = decide(params);
      return d === 'cancel' ? { outcome: { outcome: 'cancelled' as const } } : { outcome: { outcome: 'selected' as const, optionId: d } };
    });
  try {
    return await app.connectWith({ readable: down.readable, writable: up.writable }, async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: 'test-client', version: '1' } });
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: dir, mcpServers: [] });
      return body({ prompt: (text, meta) => ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }], ...(meta ? { _meta: meta } : {}) }), seen });
    });
  } finally { agent.close(); await agent.closed.catch(() => {}); }
}

const cards = (s: Seen): UiBlock[] => s.updates.flatMap((u) => { const b = (u as { _meta?: Record<string, unknown> })._meta?.['hull.ui']; return b ? [b as UiBlock] : []; });
const state = async (): Promise<CreateState> => (await runTool(dir, 'create.get', {})) as CreateState;
const explainDocs = async (): Promise<ExplainDoc[]> => ((await runTool(dir, 'explain.list', {})) as { items: ExplainDoc[] }).items;
const build = { 'hull.mode': 'build' };

describe('the scripted flow on the arena template', () => {
  it('brief: two questions by click, nine sections, a change by typing, then approval sets briefApproved', async () => {
    const providers = fakeFromPath(FIXTURES);
    await session(providers, (r) => (r.options.some((o) => o.optionId === 'yes') ? 'yes' : '0'), async (c) => {
      const res = await c.prompt('A game about collecting gems against the clock', { 'hull.mode': 'brief' });
      expect(res.stopReason).toBe('end_turn');
      expect(c.seen.asked.map((a) => a.toolCall.title)).toEqual(['What should you be doing most of the time?', 'How should a round end?', 'Build from this brief?']);
      const brief = cards(c.seen).filter((b) => b.kind === 'brief');
      expect(brief.length).toBeGreaterThanOrEqual(10);
      expect(brief.every((b) => b.id === 'brief')).toBe(true);
      const last = brief.at(-1) as Extract<UiBlock, { kind: 'brief' }>;
      expect(last.sections.map((s) => s.id)).toEqual(['premise', 'what-you-do', 'controls', 'cast', 'world', 'rules', 'look-and-sound', 'first-playable', 'not-in-the-first-version']);
      expect(last.sections.every((s) => s.status === 'done')).toBe(true);
      expect((brief[0] as Extract<UiBlock, { kind: 'brief' }>).sections[0]!.status).toBe('writing');
    });
    const text = readFileSync(join(dir, 'GAME.md'), 'utf8');
    expect(text.match(/^## /gm)).toHaveLength(9);
    expect(text.indexOf('## Premise')).toBeLessThan(text.indexOf('## Not in the first version'));
    const s = await state();
    expect(s.briefApproved).toBe(true);
    expect(s.step).toBe('build');
  }, 120_000);

  it('brief: a typed change edits one section, marks it changed, asks again; approving then sets briefApproved', async () => {
    // Start over so the approval is not already there.
    await runTool(dir, 'create.set', { patch: { briefApproved: false, step: 'brief' } });
    const providers = fakeFromPath(FIXTURES);
    let approves = 0;
    await session(providers, (r) => {
      if (r.options.some((o) => o.optionId === 'yes')) return approves++ === 0 ? 'cancel' : 'yes';
      return '0';
    }, async (c) => {
      const first = await c.prompt('Gem game', { 'hull.mode': 'brief' });
      expect((first._meta as { ownWords: boolean }).ownWords).toBe(true);
      expect((await state()).briefApproved).toBe(false);
      const second = await c.prompt('Make the premise shorter', { 'hull.mode': 'brief' });
      expect(second.stopReason).toBe('end_turn');
      const changed = cards(c.seen).filter((b): b is Extract<UiBlock, { kind: 'brief' }> => b.kind === 'brief').at(-1)!;
      expect(changed.sections.filter((s) => s.status === 'changed').map((s) => s.id)).toEqual(['premise']);
    });
    expect(readFileSync(join(dir, 'GAME.md'), 'utf8')).toContain('A scout races the clock to gather gems in a walled arena.');
    expect((await state()).briefApproved).toBe(true);
  }, 120_000);

  it('build: the stages become ready in order, each with its pieces, a checkpoint and the cards; explain documents validate', async () => {
    const providers = fakeFromPath(FIXTURES);
    await session(providers, () => 'allow', async (c) => {
      const res = await c.prompt('Build it', build);
      expect(res.stopReason).toBe('end_turn');
      expect((res._meta as { outcome: string; built: string[] }).outcome).toBe('done');
      expect((res._meta as { built: string[] }).built).toEqual(STAGES.map((s) => s.id));

      // The stages card was sent again each time; the last one has every stage ready.
      const stagesCards = cards(c.seen).filter((b): b is Extract<UiBlock, { kind: 'stages' }> => b.kind === 'stages');
      expect(stagesCards.every((b) => b.id === 'stages')).toBe(true);
      expect(stagesCards.at(-1)!.stages.map((s) => s.status)).toEqual(Array(7).fill('ready'));
      // ready came in order: the first card where each stage is ready appears after the previous one's
      const firstReady = STAGES.map((st) => stagesCards.findIndex((b) => b.stages.find((s) => s.id === st.id)!.status === 'ready'));
      expect([...firstReady].sort((a, b) => a - b)).toEqual(firstReady);
      expect(firstReady.every((i) => i >= 0)).toBe(true);
      const pieceCards = cards(c.seen).filter((b) => b.kind === 'pieces');
      expect(pieceCards.map((b) => (b as { stage: string }).stage)).toEqual(STAGES.map((s) => s.id));
      const explainCards = cards(c.seen).filter((b) => b.kind === 'explain');
      expect(explainCards.map((b) => b.id).sort()).toEqual(['explain-arena-map', 'explain-round-loop']);
    });
    const s = await state();
    const by = Object.fromEntries(s.stages.map((x) => [x.id, x]));
    expect(by['world']!.pieces).toEqual(expect.arrayContaining(['tuning/arena', 'explain:arena-map']));
    expect(by['actors']!.pieces).toEqual(['character/soldier']);
    expect(by['animations']!.pieces).toEqual(['anim-graph/locomotion']);
    expect(by['rules']!.pieces).toEqual(expect.arrayContaining(['tunables:player', 'explain:round-loop']));
    expect(by['sounds']!.pieces).toEqual(['sound/thud']);
    expect(by['effects']!.pieces).toEqual(['vfx/dust']);
    expect(by['screens']!.pieces).toEqual(['ui-theme/hud']);
    for (const st of s.stages) {
      expect(st.checkpoint).toBe('stage-' + st.id);
      expect(st.summary?.length).toBeGreaterThan(10);
    }
    expect(s.step).toBe('play');
    // The real changes are in the project.
    const tun = JSON.parse(readFileSync(join(dir, 'config', 'tuning', 'arena.json'), 'utf8'));
    expect(tun.crateCount).toBe(16);
    expect(JSON.parse(readFileSync(join(dir, 'config', 'sound', 'thud.json'), 'utf8')).level).toBe(-6);
    // The explain documents were validated by the server (a flow whose edges name its nodes; a map whose picture is a real screenshot).
    const docs = await explainDocs();
    const map = docs.find((d) => d.id === 'arena-map')!;
    expect(map.body.type).toBe('map');
    if (map.body.type === 'map') { expect(map.body.image.startsWith('data:image/png;base64,')).toBe(true); expect(map.body.image.length).toBeGreaterThan(2000); expect(map.body.width).toBeGreaterThan(1); }
    expect(docs.find((d) => d.id === 'round-loop')!.body.type).toBe('flow');
    // Checkpoints exist in the history, and the final check passes.
    const hist = (await runTool(dir, 'history.list', { limit: 100 })) as { items: { checkpoints: string[] }[] };
    const cps = hist.items.flatMap((i) => i.checkpoints);
    for (const st of STAGES) expect(cps).toContain('stage-' + st.id);
    expect(((await runTool(dir, 'check', {})) as { ok: boolean }).ok).toBe(true);
  }, 300_000);

  it('build: with every stage ready a build prompt changes nothing; hull.stage reworks only that stage with the note', async () => {
    const fake = fakeFromPath(FIXTURES) as Record<'brief' | 'build' | 'fix', Provider & { calls: { system: string; messages: unknown[] }[] }>;
    await session(fake, () => 'allow', async (c) => {
      const none = await c.prompt('Build it', build);
      expect((none._meta as { built: string[] }).built).toEqual([]);
      const before = (await state()).stages.find((s) => s.id === 'sounds')!;
      const res = await c.prompt('The thud is too quiet', { ...build, 'hull.stage': 'sounds' });
      expect((res._meta as { built: string[] }).built).toEqual(['sounds']);
      const after = (await state()).stages.find((s) => s.id === 'sounds')!;
      expect(after.status).toBe('ready');
      expect(after.pieces).toContain('sound/thud');
      expect(after.checkpoint).toBe(before.checkpoint);
    });
    const calls = fake.build.calls;
    expect(calls.every((x) => x.system.includes('Stage: sounds'))).toBe(true);
    expect(JSON.stringify(calls[0]!.messages[0])).toContain('The thud is too quiet');
  }, 120_000);

  it('build: a stage that fails its gate is set failed with the reason, the runner stops, and the next build prompt resumes there', async () => {
    // Start from a clean state: a second copy of the template, so the earlier stages are not ready yet.
    const dir2 = join(root, 'game2');
    await createProject({ template: 'arena', dir: dir2, title: 'Gem Run 2' });
    const server2 = await startProjectServer({ root: dir2, port: 0, historyQuietMs: 60_000 });
    const run = async (script: FakeScript, extra: { maxFixRounds?: number } = {}): Promise<{ res: acp.PromptResponse; seen: Seen }> => {
      const up = new TransformStream<acp.AnyMessage>();
      const down = new TransformStream<acp.AnyMessage>();
      const agent = startHullAgent({ projectRoot: dir2, provider: { build: fakeProvider(script) }, stream: { readable: up.readable, writable: down.writable }, log: () => {}, ...extra });
      const seen: Seen = { updates: [], asked: [] };
      try {
        return await acp.client({ name: 't' }).onNotification(acp.methods.client.session.update, ({ params }) => { seen.updates.push(params.update); })
          .connectWith({ readable: down.readable, writable: up.writable }, async (ctx) => {
            await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION });
            const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: dir2, mcpServers: [] });
            const res = await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'go' }], _meta: build });
            return { res, seen };
          });
      } finally { agent.close(); await agent.closed.catch(() => {}); }
    };
    try {
      const fixtures = JSON.parse(readFileSync(join(FIXTURES, 'build.json'), 'utf8')) as Record<string, FakeScript>;
      // world never writes its map: it fails after the fix rounds, and nothing after it runs.
      const bad = { ...fixtures, world: [{ text: 'Done, with no map.' }] };
      const first = await run(bad as unknown as FakeScript, { maxFixRounds: 1 });
      expect((first.res._meta as { outcome: string }).outcome).toBe('failed');
      expect((first.res._meta as { failed: { stage: string } }).failed.stage).toBe('world');
      const s1 = (await runTool(dir2, 'create.get', {})) as CreateState;
      expect(s1.stages.map((s) => s.status)).toEqual(['failed', ...Array(6).fill('waiting')]);
      expect(s1.stages[0]!.summary).toContain('explain document');
      expect(existsSync(join(dir2, '.hull', 'explain', 'arena-map.json'))).toBe(false);
      // The next build prompt resumes at world (the first stage that is not ready) and goes on to the end.
      const second = await run(fixtures as unknown as FakeScript);
      expect((second.res._meta as { outcome: string }).outcome).toBe('done');
      const s2 = (await runTool(dir2, 'create.get', {})) as CreateState;
      expect(s2.stages.map((s) => s.status)).toEqual(Array(7).fill('ready'));
    } finally { await server2.close(); }
  }, 300_000);
});

describe('stage data and helpers', () => {
  it('lists the seven stages in order, with the explain documents the brief asks for', () => {
    expect(STAGES.map((s) => s.id)).toEqual(['world', 'actors', 'animations', 'rules', 'sounds', 'effects', 'screens']);
    expect(STAGES.find((s) => s.id === 'world')!.explain.map((e) => e.kind)).toEqual(['map']);
    expect(STAGES.find((s) => s.id === 'rules')!.explain.map((e) => e.kind)).toEqual(['flow']);
    for (const s of STAGES) { expect(s.make.length).toBeGreaterThan(30); expect(s.done.length).toBeGreaterThan(10); expect(s.kinds.length).toBeGreaterThan(0); }
  });
  it('knows which explain documents a stage still owes', () => {
    const world = STAGES[0]!;
    const map = { id: 'm', title: 't', stage: 'world', why: 'w', body: { type: 'map', image: 'data:image/png;base64,AA', width: 1, height: 1, marks: [] } } as ExplainDoc;
    expect(missingExplain(world, [])).toHaveLength(1);
    expect(missingExplain(world, [map])).toHaveLength(0);
    expect(missingExplain(world, [{ ...map, stage: 'rules' }])).toHaveLength(1);
  });
  it('seeds a stage with the brief, the docs and what earlier stages made, and the note on a rework', () => {
    const t = stageTask(STAGES[3]!, { brief: '# Game\n## Rules\nWin.', docs: ['kit/index  Kits'], earlier: [{ id: 'world', title: 'World', summary: 'An arena.' }], note: 'harder' });
    expect(t).toContain('## Rules');
    expect(t).toContain('kit/index');
    expect(t).toContain('- World: An arena.');
    expect(t).toContain('"flow" document');
    expect(t).toContain('asked for a change: "harder"');
  });
  it('does not fail a project whose tests cannot load here', () => {
    expect(testsCouldNotRun({ total: 0, problems: [{ message: "Cannot find package 'hull' imported from x" }] })).toBe(true);
    expect(testsCouldNotRun({ total: 3, problems: [{ message: 'expected 1 to be 2' }] })).toBe(false);
    expect(testsCouldNotRun({ total: 0, problems: [] })).toBe(false);
  });
});
