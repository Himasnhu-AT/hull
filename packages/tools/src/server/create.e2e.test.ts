// The M11 project-server methods against a real project server on a temp copy of the cube template (outside the repo, so
// this also proves docs and the rest do not need the monorepo around the project).
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { setTraceSink, trace } from 'hull';
import { createRecentFeed } from 'hull/dev/recent';
import { projectTools } from '../tools/project.ts';
import { createProject, startProjectServer, type ProjectServer } from './index.ts';

let dir: string;
let server: ProjectServer;
let studio: Rpc;
let game: WebSocket;
const controls: unknown[] = [];
let paused = false;

class Rpc {
  private next = 1;
  private waiting = new Map<number, (m: { result?: unknown; error?: { code: number; message: string } }) => void>();
  readonly pushes: { method: string; params: any }[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.id !== undefined) this.waiting.get(m.id)?.(m); else this.pushes.push(m);
    });
  }
  call<T = any>(method: string, params: unknown = {}): Promise<T> {
    const id = this.next++;
    return new Promise((res, rej) => {
      this.waiting.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result as T)));
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }
  async until(method: string, pred: (p: any) => boolean = () => true, ms = 5000): Promise<any> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = this.pushes.find((p) => p.method === method && pred(p.params));
      if (hit) return hit.params;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no ${method} push within ${ms} ms`);
  }
}

const open = (url: string, role: string): Promise<WebSocket> => new Promise((res, rej) => { const ws = new WebSocket(`${url}?role=${role}&client=g1`); ws.on('open', () => res(ws)); ws.on('error', rej); });

beforeAll(async () => {
  dir = join(mkdtempSync(join(tmpdir(), 'hull-create-')), 'game');
  await createProject({ template: 'cube', dir, title: 'Create cube' });
  server = await startProjectServer({ root: dir, port: 0, historyQuietMs: 0 });
  studio = new Rpc(await open(server.url, 'studio'));
  // A game that answers the control port the way the dev runtime does, with a fixed frame.
  game = await open(server.url, 'game');
  game.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.method === 'game.control') {
      controls.push(m.params);
      // Like the dev runtime: a pause or resume is reported at once, not at the next quarter second.
      if (typeof m.params.paused === 'boolean') {
        paused = m.params.paused;
        game.send(JSON.stringify({ jsonrpc: '2.0', method: 'game.report', params: { tick: 120, time: 2, paused, timeScale: 1, fps: 60 } }));
      }
    }
    if (m.method === 'game.rpc') {
      const op = m.params.control.op;
      const result = op === 'state' ? { tick: 120, time: 2, checksum: 'x', paused: true, nodes: {}, held: [] } : { png: 'AAAA', width: 2, height: 1 };
      game.send(JSON.stringify({ jsonrpc: '2.0', method: 'game.result', params: { id: m.params.id, ok: true, result } }));
    }
  });
}, 60_000);

afterAll(async () => {
  setTraceSink(null);
  studio?.ws.close();
  game?.close();
  await server?.close();
  rmSync(join(dir, '..'), { recursive: true, force: true });
});

describe('game.recent and game.moment', () => {
  it('returns what the engine traced, in game time, newest first, after the game steps', async () => {
    // The game side exactly as dev/runtime.ts wires it: engine trace -> ring -> batch to the server.
    let time = 0;
    const feed = createRecentFeed({ time: () => time, title: (_k, id) => (id === 'sound/sword/hit' ? 'Clash' : undefined), send: (items) => game.send(JSON.stringify({ jsonrpc: '2.0', method: 'game.events', params: { items } })) });
    setTraceSink(feed.add);
    game.send(JSON.stringify({ jsonrpc: '2.0', method: 'game.report', params: { tick: 0, time: 0, paused: false, timeScale: 1, fps: 60, checksum: 'a' } }));
    time = 1; trace('actor', 'character/aya', 'Aya');
    time = 3; trace('sound', 'sound/sword/hit');
    time = 7.5; trace('vfx', 'vfx/clash-sparks'); trace('anim', 'anim-graph/hero#attack', 'Aya');
    expect(feed.flush()).toBe(4);
    expect(feed.flush()).toBe(0);
    setTraceSink(null);
    game.send(JSON.stringify({ jsonrpc: '2.0', method: 'game.report', params: { tick: 450, time: 7.5, paused: false, timeScale: 1, fps: 60, checksum: 'b' } }));
    const push = await studio.until('game.recent');
    expect(push.items.map((e: any) => e.label)).toEqual(['Aya', 'Clash', 'Clash sparks', 'Attack']);
    const r = await studio.call('game.recent', { seconds: 4 });
    expect(r.items.map((e: any) => e.label)).toEqual(['Attack', 'Clash sparks']);
    expect(r.items[0]).toMatchObject({ at: 7.5, kind: 'anim', id: 'anim-graph/hero#attack', node: 'Aya' });
    const wide = await studio.call('game.recent', { seconds: 100 });
    expect(wide.items).toHaveLength(4);
    expect(wide.items.at(-1)).toMatchObject({ label: 'Aya', kind: 'actor', at: 1 });
  });

  it('game.moment pauses the game and returns the frame with the recent events', async () => {
    const m = await studio.call('game.moment');
    expect(m).toMatchObject({ tick: 120, time: 2, png: 'AAAA', width: 2, height: 1 });
    expect(m.recent.length).toBeGreaterThan(0);
    expect(controls).toContainEqual({ paused: true });
  });

  it('shows paused to the studio while frozen, and a later game.control resumes it', async () => {
    expect(paused).toBe(true);
    await studio.until('game.report', (p) => p.paused === true);
    studio.pushes.length = 0;
    await studio.call('game.control', { paused: false });
    expect(controls.at(-1)).toEqual({ paused: false });
    expect(paused).toBe(false);
    const resumed = await studio.until('game.report', (p) => p.paused === false);
    expect(resumed.client).toBe('g1');
  });

  it('says plainly when no game is connected', async () => {
    const other = new Rpc(await open(server.url, 'studio'));
    game.close();
    await new Promise((r) => setTimeout(r, 100));
    expect((await other.call('game.recent')).items).toEqual([]);
    await expect(other.call('game.moment')).rejects.toThrow(/no game is connected/);
    other.ws.close();
  });
});

describe('brief', () => {
  it('is empty before the first write', async () => {
    expect(await studio.call('brief.read')).toEqual({ exists: false, title: '', text: '', sections: [] });
  });

  it('writes a section at a time in the standard order, keeps unknown sections, and pushes brief.changed', async () => {
    const a = await studio.call('brief.write', { section: { id: 'rules', text: 'Three hits and you are out.' }, author: 'ai:test' });
    expect(a.ok).toBe(true);
    expect(a.doc.title).toBe('Create cube');
    await studio.call('brief.write', { section: { id: 'premise', text: 'A cube rolls.' }, author: 'ai:test' });
    await studio.call('brief.write', { section: { id: 'what-you-do', text: 'Dodge.' }, author: 'ai:test' });
    const d = await studio.call('brief.read');
    expect(d.sections.map((s: any) => s.id)).toEqual(['premise', 'what-you-do', 'rules']);
    expect(readFileSync(join(dir, 'GAME.md'), 'utf8')).toMatch(/^# Create cube\n\n## Premise\n\nA cube rolls\.\n\n## What you do/);
    const push = await studio.until('brief.changed', (b) => b.sections.length === 3);
    expect(push.sections[2].text).toBe('Three hits and you are out.');
  });

  it('is recorded in the history under its author, and GAME.md is tracked', async () => {
    let hit: any;
    for (let i = 0; i < 50 && !hit; i++) {
      const list = await studio.call<any[]>('history.list', { limit: 20 });
      hit = list.find((c) => c.by === 'ai:test' && c.details.some((t: string) => t.includes('GAME.md')));
      if (!hit) await new Promise((r) => setTimeout(r, 100));
    }
    expect(hit).toBeTruthy();
  });

  it('refuses a write with nothing in it, with a sentence', async () => {
    const r = await studio.call('brief.write', { text: '  ' });
    expect(r.ok).toBe(false);
    expect(r.problems[0].file).toBe('GAME.md');
    expect((await studio.call('brief.write', { section: { id: 'rules', text: '## Oops\nx' } })).ok).toBe(false);
  });
});

describe('docs', () => {
  it('lists kits, guides and the generated API, and reads them', async () => {
    const { items } = await studio.call<{ items: { id: string; kind: string; bytes: number }[] }>('docs.list');
    const ids = items.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining(['kit/index', 'kit/combat', 'kit/health', 'guide/schemas', 'guide/workflow', 'api/core', 'api/audio', 'api/kits']));
    expect(items.every((i) => i.bytes > 0)).toBe(true);
    const kit = await studio.call('docs.read', { id: 'kit/combat' });
    expect(kit.ok).toBe(true);
    expect(kit.text).toMatch(/^# /m);
    expect((await studio.call('docs.read', { id: 'guide/schemas' })).text).toContain('## 2. The game manifest');
    const api = await studio.call('docs.read', { id: 'api/core' });
    expect(api.text).toContain('# API: hull');
    expect(api.text).toMatch(/- function defineGame\(/);
    expect(api.text).toMatch(/- function trace\(kind: TraceKind, id: string, node\?: string/);
    const missing = await studio.call('docs.read', { id: 'kit/nope' });
    expect(missing.ok).toBe(false);
    expect(missing.problems[0].message).toContain('docs.list');
  }, 60_000);
});

describe('explain and review', () => {
  const flow = (to: string): any => ({ id: 'guard-behaviour', title: 'How a guard fights', stage: 'rules', why: 'It waits, then closes in.', body: { type: 'flow', nodes: [{ id: 'a', text: 'Wait' }, { id: 'b', text: 'Chase' }], edges: [{ from: 'a', to }] } });

  it('rejects an edge to a missing node with the pointer, and writes nothing', async () => {
    const r = await studio.call('explain.write', { doc: flow('zz'), author: 'ai:test' });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatchObject({ file: '.hull/explain/guard-behaviour.json', pointer: '/body/edges/0/to' });
    expect(existsSync(join(dir, '.hull/explain/guard-behaviour.json'))).toBe(false);
  });

  it('keeps a valid document with its author, lists it, and pushes explain.changed', async () => {
    expect((await studio.call('explain.write', { doc: flow('b'), author: 'ai:test' })).ok).toBe(true);
    const { items } = await studio.call('explain.list');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'guard-behaviour', by: 'ai:test' });
    await studio.until('explain.changed', (p) => p.id === 'guard-behaviour');
  });

  it('reviews it under explain:<id> and falls back to unreviewed when the drawing changes', async () => {
    const set = await studio.call('review.set', { key: 'explain:guard-behaviour', state: 'approved', author: 'you' });
    expect(set.ok).toBe(true);
    // Saving the same drawing again keeps the approval (the hash ignores author and time).
    await studio.call('explain.write', { doc: flow('b'), author: 'ai:other' });
    let e = (await studio.call<any[]>('review.list', {})).find((x) => x.key === 'explain:guard-behaviour');
    expect(e.state).toBe('approved');
    await studio.call('explain.write', { doc: { ...flow('b'), why: 'It waits, then closes in fast.' }, author: 'ai:test' });
    e = (await studio.call<any[]>('review.list', {})).find((x) => x.key === 'explain:guard-behaviour');
    expect(e).toMatchObject({ state: 'unreviewed', stale: true, was: 'approved' });
    expect((await studio.call('review.set', { key: 'explain:nope', state: 'approved' })).ok).toBe(false);
  });
});

describe('create state', () => {
  it('starts at play with seven waiting stages', async () => {
    const s = await studio.call('create.get');
    expect(s).toMatchObject({ idea: '', step: 'play', briefApproved: false });
    expect(s.stages.map((x: any) => x.id)).toEqual(['world', 'actors', 'animations', 'rules', 'sounds', 'effects', 'screens']);
    expect(s.stages.every((x: any) => x.status === 'waiting' && x.pieces.length === 0)).toBe(true);
  });

  it('merges a patch and one stage, keeps it on disk, and pushes create.changed', async () => {
    await studio.call('create.set', { patch: { idea: 'a cube that rolls', step: 'build', briefApproved: true } });
    const s = await studio.call('create.set', { stage: { id: 'actors', status: 'ready', summary: 'One cube.', pieces: ['character/cube'] } });
    expect(s.stages[1]).toEqual({ id: 'actors', status: 'ready', summary: 'One cube.', pieces: ['character/cube'] });
    expect(JSON.parse(readFileSync(join(dir, '.hull/create.json'), 'utf8')).step).toBe('build');
    expect((await studio.call('create.get')).idea).toBe('a cube that rolls');
    await studio.until('create.changed', (p) => p.stages[1].status === 'ready');
  });

  it('names the field when the patch is wrong', async () => {
    await expect(studio.call('create.set', { patch: { step: 'dance' } })).rejects.toThrow(/create.json#\/step/);
    await expect(studio.call('create.set', { stage: { id: 'nope' } })).rejects.toThrow(/no stage "nope"/);
  });
});

describe('as tools', () => {
  it('exposes every new method once, with schemas and a summary', () => {
    const names = projectTools.map((t) => t.name);
    for (const m of ['brief.read', 'brief.write', 'docs.list', 'docs.read', 'explain.list', 'explain.write', 'create.get', 'create.set', 'game.recent', 'game.moment']) {
      expect(names.filter((n) => n === m)).toHaveLength(1);
      const t = projectTools.find((x) => x.name === m)!;
      expect(t.summary.length).toBeGreaterThan(40);
      expect(t.input).toBeTruthy();
      expect(t.output).toBeTruthy();
    }
  });

  it('runs through the project tool with the caller as author', async () => {
    const tool = projectTools.find((t) => t.name === 'brief.write')!;
    const ctx = { root: dir, author: 'ai:tool-test' as const, project: { call: (m: string, p: unknown) => studio.call(m, p) }, log: () => {}, signal: new AbortController().signal };
    const r = (await tool.run(ctx as never, { section: { id: 'controls', text: 'WASD.' } })) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect((await studio.call('brief.read')).sections.map((s: any) => s.id)).toContain('controls');
  });
});
