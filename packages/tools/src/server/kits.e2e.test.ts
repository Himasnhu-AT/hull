// kit.list and kit.add through a real project server, the helpful answers for a config file that is not there and for
// code.write under config/, and a wrong import in a test file being found by check (it used to pass check and fail in test).
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { check } from '../tools/check.ts';
import { test as testTool } from '../tools/test.ts';
import { projectTools } from '../tools/project.ts';
import { createProject, startProjectServer, type ProjectServer } from './index.ts';

let dir: string;
let server: ProjectServer;
let ws: WebSocket;
let next = 1;
const waiting = new Map<number, (m: { result?: any; error?: { message: string } }) => void>();
const call = <T = any>(method: string, params: unknown = {}): Promise<T> => new Promise((res, rej) => {
  const id = next++;
  waiting.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result as T)));
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
});
const ctx = () => ({ root: dir, author: 'test', log: () => {}, signal: new AbortController().signal });

beforeAll(async () => {
  dir = join(mkdtempSync(join(tmpdir(), 'hull-kits-')), 'game');
  await createProject({ template: 'cube', dir, title: 'Kits' });
  server = await startProjectServer({ root: dir, port: 0, historyQuietMs: 0 });
  ws = new WebSocket(server.url + '&role=studio');
  ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.id !== undefined) waiting.get(m.id)?.(m); });
  await new Promise((r) => ws.on('open', r));
}, 60_000);

afterAll(async () => {
  ws?.close();
  await server?.close();
  rmSync(join(dir, '..'), { recursive: true, force: true });
});

describe('kit tools', () => {
  it('are tools, so the app and MCP reach them', () => {
    expect(projectTools.map((t) => t.name)).toEqual(expect.arrayContaining(['kit.list', 'kit.add']));
  });

  it('kit.list names each kit and its files', async () => {
    const r = await call('kit.list');
    expect(r.items.map((k: { kit: string }) => k.kit)).toEqual(expect.arrayContaining(['level', 'menu', 'pickups']));
    expect(r.items.find((k: { kit: string }) => k.kit === 'menu').config).toContain('ui-screen/title');
  });

  it('kit.add copies the missing files, keeps the rest, and records them under the caller', async () => {
      const first = await call('kit.add', { kit: 'menu', author: 'ai:test' });
    expect(first).toMatchObject({ ok: true, created: ['ui-screen/result', 'ui-screen/title'] });
    expect(existsSync(join(dir, 'config/ui-screen/title.json'))).toBe(true);
    const again = await call('kit.add', { kit: 'menu' });
    expect(again).toMatchObject({ ok: true, created: [], kept: ['ui-screen/result', 'ui-screen/title'] });
    const journal = await call('journal.list', {});
    expect(journal.some((c: { target: string; by: string }) => c.target === 'ui-screen/title' && c.by === 'ai:test')).toBe(true);
    const bad = await call('kit.add', { kit: 'nope' });
    expect(bad.ok).toBe(false);
    expect(bad.problems[0].message).toContain('kit.list');
  });

  it('check names the kit to add when it is imported without its config', async () => {
    writeFileSync(join(dir, 'src', 'screens.ts'), "import { PauseMenu } from 'hull/kits';\nexport const p = PauseMenu;\n");
    const out = await check.run(ctx(), {});
    const p = out.problems.find((x) => x.rule === 'kit-config')!;
    expect(p).toMatchObject({ file: 'src/screens.ts', line: 1 });
    expect(p.message).toContain('ui-screen/pause');
    expect(p.message).toContain('kit.add {"kit":"pause"}');
    await call('kit.add', { kit: 'pause' });
    expect((await check.run(ctx(), {})).problems.filter((x) => x.rule === 'kit-config')).toEqual([]);
  }, 60_000);
});

describe('helpful answers', () => {
  it('config.set on a level that does not exist says how to make it', async () => {
    const e = await call('config.set', { id: 'level/arena', pointer: '/note', value: 'x' }).catch((x: Error) => x);
    expect(String(e.message)).toContain('asset.new {"kind":"level","id":"level/arena"}');
  });

  it('code.write under config/ names asset.new', async () => {
    const r = await call('code.write', { path: 'config/prefab/barrel.json', text: '{}' });
    expect(r.ok).toBe(false);
    expect(r.problems[0].message).toContain('asset.new {"kind":"prefab","id":"prefab/barrel"}');
    expect(r.problems[0].message).toContain('config.set');
  });

  it('asset.new makes a level and then config.set can edit it', async () => {
    const made = await call('asset.new', { kind: 'level', id: 'level/arena' });
    expect(made).toMatchObject({ ok: true });
    expect(made.created).toEqual(['level/arena', 'material/starter']);
    const set = await call('config.set', { id: 'level/arena', pointer: '/note', value: 'Walled ground' });
    expect(set.ok).toBe(true);
  });
});

describe('a wrong import in a test file', () => {
  it('is found by check, as test finds it', async () => {
    writeFileSync(join(dir, 'src', 'wrong.test.ts'), "import { describe, it, expect } from 'vitest';\nimport { kitSources } from 'hull/kits';\ndescribe('x', () => { it('y', () => { expect(typeof kitSources).toBe('function'); }); });\n");
    const out = await check.run(ctx(), {});
    const p = out.problems.find((x) => x.file === 'src/wrong.test.ts' && x.rule === 'types');
    expect(p?.message).toMatch(/kitSources/);
    expect(p?.line).toBe(2);
    const t = await testTool.run(ctx(), {});
    expect(t.ok).toBe(false);
    expect(readFileSync(join(dir, 'src', 'wrong.test.ts'), 'utf8')).toContain('hull/kits');
  }, 120_000);
});
