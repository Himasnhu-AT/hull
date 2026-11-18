import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createProject, listTemplates, startProjectServer, type ProjectServer } from './index.ts';

// A temp copy of the cube template, outside the repo: this also proves a project does not need the monorepo around it.
let dir: string;
let server: ProjectServer;
let studio: Rpc;

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

const connect = (url: string, role: string, origin?: string): Promise<Rpc> =>
  new Promise((res, rej) => {
    const ws = new WebSocket(`${url}?role=${role}`, origin ? { origin } : undefined);
    ws.on('open', () => res(new Rpc(ws)));
    ws.on('error', rej);
    ws.on('unexpected-response', (_q, r) => rej(new Error(`refused: ${r.statusCode}`)));
  });

beforeAll(async () => {
  dir = join(mkdtempSync(join(tmpdir(), 'hull-e2e-')), 'game');
  await createProject({ template: 'cube', dir, title: 'E2E cube' });
  server = await startProjectServer({ root: dir, port: 0 });
  studio = await connect(server.url, 'studio');
}, 60_000);

afterAll(async () => {
  studio?.ws.close();
  await server?.close();
  rmSync(join(dir, '..'), { recursive: true, force: true });
});

describe('templates and projects', () => {
  it('lists the cube template and makes a standalone project', () => {
    expect(listTemplates().map((t) => t.name)).toContain('cube');
    expect(JSON.parse(readFileSync(join(dir, 'hull.json'), 'utf8'))).toMatchObject({ title: 'E2E cube', id: 'e2e-cube' });
    const ts = JSON.parse(readFileSync(join(dir, 'tsconfig.json'), 'utf8'));
    expect(ts.extends).toBeUndefined();
    expect(ts.references).toBeUndefined();
    expect(ts.compilerOptions.paths.hull).toBeDefined();
  });
});

describe('project server', () => {
  it('answers project.info and library.list', async () => {
    const info = await studio.call('project.info');
    expect(info).toMatchObject({ title: 'E2E cube', gameUrl: server.gameUrl });
    const lib = await studio.call<any[]>('library.list');
    expect(lib.map((i) => i.id)).toEqual(expect.arrayContaining(['hull.json', 'tuning/cube-look', 'tunables:cube']));
  });

  it('serves the dev page', async () => {
    const html = await (await fetch(server.gameUrl)).text();
    expect(html).toContain('virtual:hull-boot');
    const boot = await (await fetch(`${server.gameUrl}@id/__x00__virtual:hull-boot`)).text();
    expect(boot).toContain('connectDev');
  });

  it('refuses a web page from another origin', async () => {
    await expect(connect(server.url, 'studio', 'https://evil.example')).rejects.toThrow(/403|refused/);
  });

  it('config.set changes the file, keeps its formatting, journals it and pushes it to games', async () => {
    const game = await connect(server.url, 'game');
    const file = join(dir, 'config/tuning/cube-look.json');
    const before = readFileSync(file, 'utf8');
    const r = await studio.call('config.set', { id: 'tuning/cube-look', pointer: '/spin', value: 3.5, author: 'ai:test' });
    expect(r).toEqual({ ok: true, problems: [] });
    expect(readFileSync(file, 'utf8')).toBe(before.replace('"spin": 1.2', '"spin": 3.5'));
    const push = await game.until('config.changed');
    expect(push).toMatchObject({ id: 'tuning/cube-look', path: 'config/tuning/cube-look.json' });
    expect(JSON.parse(push.text).spin).toBe(3.5);
    const j = await studio.call<any[]>('journal.list', {});
    expect(j.at(-1)).toMatchObject({ by: 'ai:test', target: 'tuning/cube-look', path: '/spin', from: 1.2, to: 3.5 });
    expect(readFileSync(join(dir, '.hull/journal.jsonl'), 'utf8').trim().split('\n')).toHaveLength(j.length);
    game.ws.close();
  });

  it('config.set rejects a bad value with its pointer and leaves the file alone', async () => {
    const file = join(dir, 'config/tuning/cube-look.json');
    const before = readFileSync(file, 'utf8');
    const r = await studio.call('config.set', { id: 'tuning/cube-look', pointer: '/spin', value: 'fast' });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatchObject({ file: 'config/tuning/cube-look.json', pointer: '/spin', rule: 'schema' });
    expect(readFileSync(file, 'utf8')).toBe(before);
    const kind = await studio.call('config.set', { id: 'tuning/cube-look', pointer: '/kind', value: 'sound' });
    expect(kind.ok).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('config.read gives text, value, schema and problems', async () => {
    const r = await studio.call('config.read', { id: 'tuning/cube-look' });
    expect(r.value.spin).toBe(3.5);
    expect(r.schema).toMatchObject({ type: 'object' });
    expect(r.problems).toEqual([]);
    await expect(studio.call('config.read', { id: '../../etc/passwd' })).rejects.toThrow();
  });

  it('tunables.list finds cube.spin with its place', async () => {
    const list = await studio.call<any[]>('tunables.list');
    const spin = list.find((t) => t.block === 'cube' && t.key === 'spin');
    expect(spin).toMatchObject({ kind: 'num', value: 1.2, file: 'src/tuning.ts', line: 4, opts: { min: 0, max: 10 } });
    const line = readFileSync(join(dir, 'src/tuning.ts'), 'utf8').split('\n')[spin.line - 1]!;
    expect(line.slice(spin.col - 1, spin.col + 2)).toBe('1.2');
  });

  it('tunables.set rewrites the literal, journals it and tells games', async () => {
    const game = await connect(server.url, 'game');
    const file = join(dir, 'src/tuning.ts');
    const before = readFileSync(file, 'utf8');
    const r = await studio.call('tunables.set', { block: 'cube', key: 'spin', value: 6 });
    expect(r).toEqual({ ok: true, problems: [] });
    expect(readFileSync(file, 'utf8')).toBe(before.replace('num(1.2,', 'num(6,'));
    expect(await game.until('tunable.changed')).toEqual({ block: 'cube', key: 'spin', value: 6 });
    expect((await studio.call<any[]>('journal.list', {})).at(-1)).toMatchObject({ target: 'tunables:cube', path: 'spin', from: 1.2, to: 6, by: 'you' });
    // The server's own write is not announced as a source change: the game already has the value.
    await new Promise((r2) => setTimeout(r2, 600));
    expect(studio.pushes.filter((p) => p.method === 'source.changed')).toEqual([]);
    game.ws.close();
  });

  it('tunables.set rejects a value out of range and an unknown tunable', async () => {
    const file = join(dir, 'src/tuning.ts');
    const before = readFileSync(file, 'utf8');
    const r = await studio.call('tunables.set', { block: 'cube', key: 'spin', value: 99 });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatchObject({ file: 'src/tuning.ts', pointer: '/cube/spin', rule: 'tunable', line: 4 });
    expect(r.problems[0].message).toMatch(/at most 10/);
    expect((await studio.call('tunables.set', { block: 'cube', key: 'nope', value: 1 })).ok).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('pushes config.changed for an edit made on disk, and source.changed for code', async () => {
    const file = join(dir, 'config/tuning/cube-look.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('3.5', '4.5'));
    const p = await studio.until('config.changed', (x) => JSON.parse(x.text).spin === 4.5);
    expect(p.id).toBe('tuning/cube-look');
    // An invalid edit on disk is reported, not pushed.
    writeFileSync(file, readFileSync(file, 'utf8').replace('4.5', '"x"'));
    const probs = await studio.until('problems', (x) => x.problems.length > 0);
    expect(probs.problems[0]).toMatchObject({ file: 'config/tuning/cube-look.json', pointer: '/spin' });
    writeFileSync(file, readFileSync(file, 'utf8').replace('"x"', '1.2'));
    await studio.until('problems', (x) => x.problems.length === 0);

    const main = join(dir, 'src/main.ts');
    writeFileSync(main, `${readFileSync(main, 'utf8')}\n// touched\n`);
    expect(await studio.until('source.changed')).toEqual({ path: 'src/main.ts' });
  });

  it('forwards game.control to games and relays reports to studios', async () => {
    const game = await connect(server.url, 'game');
    await studio.call('game.control', { paused: true, timeScale: 0.5 });
    expect(await game.until('game.control')).toEqual({ paused: true, timeScale: 0.5 });
    game.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'game.report', params: { tick: 5, time: 0.08, paused: true, timeScale: 0.5, fps: 60 } }));
    expect(await studio.until('game.report', (x) => x.tick === 5)).toMatchObject({ fps: 60, client: expect.any(String) });
    game.ws.close();
  });

  it('answers unknown methods with an error', async () => {
    await expect(studio.call('nope')).rejects.toThrow(/unknown method/);
  });
});

describe('build', () => {
  it('writes one game.js with config inlined and no dev code', async () => {
    const r = await studio.call('tool.call', { name: 'build' });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    const js = readFileSync(join(dir, 'dist/web/game.js'), 'utf8');
    expect(js).not.toMatch(/connectDev|\[hull dev\]|dev\/runtime/);
    // Config is inside (the validated cube-look file), and the tunable is a constant: no file reads at run time.
    expect(js).toContain('cube-look');
    expect(js).not.toContain('ajv');
    expect(readFileSync(join(dir, 'dist/web/index.html'), 'utf8')).toContain('game.js');
  }, 120_000);
});
