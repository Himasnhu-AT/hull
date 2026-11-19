// The code tools through a real project server: they confine themselves to src/, edit exactly once, record each write in the
// history under its author, return type problems at file:line:col while keeping the write, and refuse to delete a file in use.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createProject, startProjectServer, type ProjectServer } from './index.ts';
import { projectTools } from '../tools/project.ts';

let dir: string;
let outside: string;
let server: ProjectServer;
let ws: WebSocket;
let next = 1;
const waiting = new Map<number, (m: { result?: any; error?: { message: string } }) => void>();
const pushes: { method: string; params: any }[] = [];
const call = <T = any>(method: string, params: unknown = {}): Promise<T> => new Promise((res, rej) => {
  const id = next++;
  waiting.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result as T)));
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
});
const read = (p: string): string => readFileSync(join(dir, p), 'utf8');

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), 'hull-code-'));
  dir = join(base, 'game');
  outside = join(base, 'outside');
  await createProject({ template: 'cube', dir, title: 'Code' });
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.ts'), 'export const s = 1;\n');
  symlinkSync(outside, join(dir, 'src', 'link'));
  writeFileSync(join(dir, 'src', 'rules.ts'), 'export const LIMIT = 3;\nexport const NAME = "rules";\nexport const LIMIT2 = 3;\n');
  writeFileSync(join(dir, 'src', 'user.ts'), "import { LIMIT } from './rules.ts';\nexport const twice = LIMIT * 2;\n");
  server = await startProjectServer({ root: dir, port: 0, historyQuietMs: 0 });
  ws = new WebSocket(server.url + '?role=studio');
  ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.id !== undefined) waiting.get(m.id)?.(m); else pushes.push(m); });
  await new Promise((r) => ws.on('open', r));
}, 90_000);

afterAll(async () => {
  ws?.close();
  await server?.close();
  rmSync(join(dir, '..'), { recursive: true, force: true });
});

describe('code tools', () => {
  it('are project tools, so the app, MCP and the agent all reach them', () => {
    expect(projectTools.map((t) => t.name)).toEqual(expect.arrayContaining(['code.list', 'code.read', 'code.search', 'code.edit', 'code.write', 'code.delete']));
  });

  it('lists, reads (whole and a range) and searches', async () => {
    const l = await call('code.list');
    expect(l.items.map((i: any) => i.path)).toEqual(expect.arrayContaining(['src/rules.ts', 'src/user.ts']));
    const all = await call('code.read', { path: 'src/rules.ts' });
    expect(all).toMatchObject({ ok: true, total: 4, from: 1 });
    expect(all.text).toContain('LIMIT2');
    expect(await call('code.read', { path: 'src/rules.ts', from: 2, to: 2 })).toMatchObject({ text: 'export const NAME = "rules";', from: 2, to: 2 });
    expect((await call('code.read', { path: 'src/nope.ts' })).ok).toBe(false);
    const s = await call('code.search', { pattern: 'LIMIT' });
    expect(s.matches.map((m: any) => m.file + ':' + m.line + ':' + m.col)).toEqual(['src/rules.ts:1:14', 'src/rules.ts:3:14', 'src/user.ts:1:10', 'src/user.ts:2:22']);
  });

  it('edits once, atomically, recorded under the caller, and the game is told to reload', async () => {
    const r = await call('code.edit', { path: 'src/rules.ts', old: 'NAME = "rules"', new: 'NAME = "laws"', author: 'ai:test' });
    expect(r).toMatchObject({ ok: true, written: true, problems: [], line: 2 });
    expect(read('src/rules.ts')).toContain('NAME = "laws"');
    const h = await call('history.list', { limit: 3 });
    expect(h[0].by).toBe('ai:test');
    expect(h[0].details.join('\n')).toContain('src/rules.ts');
    const p = await call('history.patch', { to: h[0].id, file: 'src/rules.ts' });
    expect(p.lines.some((l: any) => l.op === 'add' && l.text.includes('laws'))).toBe(true);
    // Not a tunable write: Vite is not told to ignore it, and the server announces a source change.
    await new Promise((res) => setTimeout(res, 400));
    expect(pushes.some((x) => x.method === 'source.changed' && x.params.path === 'src/rules.ts')).toBe(true);
  });

  it('refuses an edit that matches nothing or several places, and changes nothing', async () => {
    const before = read('src/rules.ts');
    const none = await call('code.edit', { path: 'src/rules.ts', old: 'NOPE', new: 'x' });
    expect(none).toMatchObject({ ok: false, written: false });
    expect(none.problems[0].message).toContain('not found');
    const many = await call('code.edit', { path: 'src/rules.ts', old: ' = 3;', new: ' = 4;' });
    expect(many).toMatchObject({ ok: false, written: false });
    expect(many.problems[0].message).toContain('2 times (lines 1, 3)');
    expect(read('src/rules.ts')).toBe(before);
    const all = await call('code.edit', { path: 'src/rules.ts', old: ' = 3;', new: ' = 4;', all: true, author: 'ai:test' });
    expect(all).toMatchObject({ ok: true, written: true, replaced: 2 });
    expect(read('src/rules.ts')).toContain('LIMIT = 4;');
    expect(read('src/rules.ts')).toContain('LIMIT2 = 4;');
  });

  it('refuses paths that leave src/: dot-dot, config/, absolute, symlinks; nothing is written', async () => {
    for (const path of ['../outside/secret.ts', 'src/../hull.json', 'config/sound/a.json', '/etc/hosts', 'hull.json', 'src/link/secret.ts', 'src/link/new.ts']) {
      for (const [m, p] of [['code.write', { path, text: 'x' }], ['code.edit', { path, old: 'a', new: 'b' }], ['code.read', { path }], ['code.delete', { path }]] as const) {
        const r = await call(m, p);
        expect(r.ok, m + ' ' + path).toBe(false);
        expect(r.written ?? false).toBe(false);
      }
    }
    expect(readFileSync(join(outside, 'secret.ts'), 'utf8')).toBe('export const s = 1;\n');
    expect(existsSync(join(outside, 'new.ts'))).toBe(false);
    expect((await call('code.search', { pattern: 'x', path: '../outside' })).ok).toBe(false);
  });

  it('keeps a write that does not type-check and returns the problems as file:line:col', async () => {
    const r = await call('code.edit', { path: 'src/rules.ts', old: 'export const NAME = "laws";', new: 'export const NAME: number = "laws";', author: 'ai:test' });
    expect(r).toMatchObject({ ok: false, written: true });
    expect(r.problems[0]).toMatchObject({ file: 'src/rules.ts', line: 2, rule: 'types' });
    expect(r.problems[0].col).toBeGreaterThan(0);
    expect(r.problems[0].message).toContain('TS2322');
    expect(read('src/rules.ts')).toContain('NAME: number');
    // The tool's own output: located problems, and a line saying the edit stayed.
    const tool = projectTools.find((t) => t.name === 'code.edit')!;
    expect(tool.format!(r).join('\n')).toContain('fix them');
    // Fixed by another edit; the check is clean again.
    const fix = await call('code.edit', { path: 'src/rules.ts', old: 'NAME: number', new: 'NAME: string', author: 'ai:test' });
    expect(fix).toMatchObject({ ok: true, written: true, problems: [] });
  }, 60_000);

  it('writes a new file (folders made), and an error in another file shows as a count, not a problem of this file', async () => {
    const r = await call('code.write', { path: 'src/enemies/slime.ts', text: 'export const slime = { hp: 3 };\n', author: 'ai:test' });
    expect(r).toMatchObject({ ok: true, written: true, created: true, problems: [] });
    expect(read('src/enemies/slime.ts')).toContain('hp: 3');
    expect(await call('code.write', { path: 'src/enemies/slime.ts', text: 'export const slime = { hp: 4 };\n', author: 'ai:test' })).toMatchObject({ created: false });
    const broke = await call('code.edit', { path: 'src/rules.ts', old: 'export const LIMIT = 4;', new: 'export const LIMIT = "four";', author: 'ai:test' });
    expect(broke).toMatchObject({ ok: true, written: true, problems: [], elsewhere: 1 });
    await call('code.edit', { path: 'src/rules.ts', old: 'LIMIT = "four"', new: 'LIMIT = 4', author: 'ai:test' });
    expect((await call('code.write', { path: 'src/x.exe', text: 'x' })).ok).toBe(false);
  }, 60_000);

  it('refuses to delete a file that is imported, listing each place; deletes it once nothing imports it', async () => {
    const r = await call('code.delete', { path: 'src/rules.ts', author: 'ai:test' });
    expect(r).toMatchObject({ ok: false, written: false });
    expect(r.importers).toEqual([{ file: 'src/user.ts', line: 1, col: 23, specifier: './rules.ts' }]);
    expect(r.problems[0]).toMatchObject({ file: 'src/user.ts', line: 1, col: 23 });
    expect(existsSync(join(dir, 'src/rules.ts'))).toBe(true);
    // Remove the import first, then the delete goes through.
    await call('code.write', { path: 'src/user.ts', text: 'export const twice = 6;\n', author: 'ai:test' });
    expect(await call('code.delete', { path: 'src/rules.ts', author: 'ai:test' })).toMatchObject({ ok: true, written: true });
    expect(existsSync(join(dir, 'src/rules.ts'))).toBe(false);
    const h = await call('history.list', { limit: 1 });
    expect(h[0].by).toBe('ai:test');
  }, 60_000);

  it('refuses to delete the entry file hull.json names', async () => {
    const entry = (JSON.parse(read('hull.json')) as { entry: string }).entry;
    const r = await call('code.delete', { path: entry.replace(/^\.\//, '') });
    expect(r.ok).toBe(false);
    expect(existsSync(join(dir, entry))).toBe(true);
  });
});
