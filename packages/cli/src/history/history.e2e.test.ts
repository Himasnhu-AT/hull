// The M2 done-when, end to end, on a temp copy of templates/cube: two experiments from one point, tuned differently
// through the server, both pages running side by side, one adopted, the other still in the timeline, and an `ai:` change
// over a value you set flagged by the check.
//
// Browser part (screenshots): HULL_BROWSER=1 HULL_SHOTS=<dir> [HULL_E2E_PORT=5306].
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createProject, startProjectServer, type ProjectServer } from '../server/index.ts';

let dir: string;
let server: ProjectServer;
let studio: Rpc;

class Rpc {
  private next = 1;
  private waiting = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>();
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
}

beforeAll(async () => {
  dir = join(mkdtempSync(join(tmpdir(), 'hull-m2-')), 'game');
  await createProject({ template: 'cube', dir, title: 'M2 cube' });
  server = await startProjectServer({ root: dir, port: Number(process.env['HULL_E2E_PORT'] ?? 0), historyQuietMs: 0 });
  studio = await new Promise<Rpc>((res, rej) => {
    const ws = new WebSocket(`${server.url}?role=studio`);
    ws.on('open', () => res(new Rpc(ws)));
    ws.on('error', rej);
  });
}, 60_000);

afterAll(async () => {
  studio?.ws.close();
  await server?.close();
  rmSync(join(dir, '..'), { recursive: true, force: true });
});

const spinOf = (root: string): number => Number(/num\(([\d.]+)/.exec(readFileSync(join(root, 'src/tuning.ts'), 'utf8'))![1]);
const shots = process.env['HULL_SHOTS'];
const browser = (args: string[]): string => execFileSync('agent-browser', ['--session', 'm2-history', ...args], { encoding: 'utf8', timeout: 60_000 });

describe('M2: history and experiments through the server', () => {
  it('two experiments from one point, tuned differently, side by side; adopt one; the other stays; an AI change over yours is flagged', async () => {
    const t0 = (await studio.call<any[]>('history.list')).length;
    expect(t0).toBeGreaterThanOrEqual(1);

    // 1. Two experiments from one point, tuned differently.
    const a = await studio.call('exp.start', { name: 'slow', from: 'main' });
    const b = await studio.call('exp.start', { name: 'fast', from: 'main' });
    expect(a.from).toBe(b.from);
    expect(a.gameUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(b.gameUrl).not.toBe(a.gameUrl);
    expect(a.gameUrl).not.toBe(server.gameUrl);
    expect(await studio.call('tunables.set', { block: 'cube', key: 'spin', value: 0.3, exp: 'slow' })).toMatchObject({ ok: true });
    expect(await studio.call('tunables.set', { block: 'cube', key: 'spin', value: 4, exp: 'fast', author: 'you' })).toMatchObject({ ok: true });
    expect(await studio.call('config.set', { id: 'tuning/cube-look', pointer: '/note', value: 'the slow one', exp: 'slow' })).toMatchObject({ ok: true });
    // The project itself is untouched by experiment edits.
    expect(spinOf(dir)).toBe(1.2);
    expect(spinOf(join(dir, '.hull/exp/slow'))).toBe(0.3);
    expect(spinOf(join(dir, '.hull/exp/fast'))).toBe(4);

    const exps = await studio.call<any[]>('exp.list');
    expect(exps.map((e) => [e.name, e.status, e.changes])).toEqual([['slow', 'active', 2], ['fast', 'active', 1]]);
    const cmp = await studio.call('exp.compare', { a: 'slow', b: 'fast' });
    const words = cmp.deltas.map((d: any) => d.text) as string[];
    expect(words).toContain('cube.spin 0.3 \u2192 4');
    expect(words.some((w) => w.startsWith('tuning/cube-look: note "the slow one" \u2192'))).toBe(true);

    // 2. Both pages answer, and (with a browser) run side by side.
    for (const e of exps) {
      const html = await (await fetch(e.gameUrl)).text();
      expect(html).toContain('virtual:hull-boot');
    }
    if (process.env['HULL_BROWSER'] && shots) {
      mkdirSync(shots, { recursive: true });
      browser(['open', exps[0].gameUrl]);
      browser(['tab', 'new', exps[1].gameUrl]);
      const results: string[] = [];
      for (const [i, name] of ['slow', 'fast'].entries()) {
        browser(['tab', String(i + 1)]);
        let out = '';
        for (let k = 0; k < 40 && !out.includes('tick'); k++) {
          out = browser(['eval', '(()=>{const h=window.hull;if(!h)return "loading";h.game.paused=true;h.game.step(60);return JSON.stringify({tick:h.game.world.tick,checksum:h.game.world.checksum()})})()']);
          if (!out.includes('tick')) execFileSync('sleep', ['0.5']);
        }
        results.push(`${name}: ${out.trim()}`);
        browser(['screenshot', join(shots, `m2-${name}.png`)]);
      }
      console.log(results.join('\n'));
      browser(['close']);
    }

    // 3. Adopt one. The other is still listed, and its change is still in the timeline.
    const adopt = await studio.call('exp.adopt', { name: 'slow' });
    expect(adopt).toMatchObject({ ok: true, conflicts: [] });
    expect(adopt.change).toMatchObject({ kind: 'merge', line: 'main', by: 'you' });
    expect(spinOf(dir)).toBe(0.3);
    const after = await studio.call<any[]>('exp.list');
    expect(after.map((e) => [e.name, e.status])).toEqual([['slow', 'adopted'], ['fast', 'active']]);
    const timeline = await studio.call<any[]>('history.list');
    expect(timeline.filter((c) => c.line === 'fast').map((c) => c.message)).toEqual(['cube.spin 1.2 → 4']);
    expect(timeline.some((c) => c.line === 'slow')).toBe(true);
    expect(studio.pushes.filter((p) => p.method === 'exp.changed').map((p) => `${p.params.name}:${p.params.change}`)).toEqual(
      expect.arrayContaining(['slow:started', 'fast:started', 'slow:edited', 'fast:edited', 'slow:adopted']),
    );
    expect(studio.pushes.some((p) => p.method === 'history.added')).toBe(true);

    // 4. An ai: change over a value you set is flagged by the check.
    expect(await studio.call('tunables.set', { block: 'cube', key: 'spin', value: 2, author: 'you' })).toMatchObject({ ok: true });
    expect((await studio.call('tool.call', { name: 'check' })).problems.filter((p: any) => p.rule === 'authorship')).toEqual([]);
    expect(await studio.call('tunables.set', { block: 'cube', key: 'spin', value: 9, author: 'ai:claude' })).toMatchObject({ ok: true });
    const checked = await studio.call('tool.call', { name: 'check' });
    const flags = checked.problems.filter((p: any) => p.rule === 'authorship');
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ file: 'src/tuning.ts', pointer: '/cube/spin' });
    console.log(`check flagged: ${flags[0].file}#${flags[0].pointer}: ${flags[0].message}`);

    // And the history can take it back: a restore is a new change.
    const list = await studio.call<any[]>('history.list', { line: 'main' });
    const restore = await studio.call('history.restore', { id: list[1].id });
    expect(restore.ok).toBe(true);
    expect(spinOf(dir)).toBe(2);
  }, 240_000);
});
