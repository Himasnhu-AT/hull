import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createProject, startProjectServer, type ProjectServer } from './index.ts';

// A third-person project made from the template: its kits' numbers must be tunable without touching engine source.
let dir: string;
let server: ProjectServer;
let ws: WebSocket;
let next = 1;
const waiting = new Map<number, (m: any) => void>();
const pushes: { method: string; params: any }[] = [];
const call = <T = any>(method: string, params: unknown = {}): Promise<T> =>
  new Promise((res, rej) => {
    const id = next++;
    waiting.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result as T)));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
const until = async (method: string, pred: (p: any) => boolean = () => true, ms = 5000): Promise<any> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = pushes.find((p) => p.method === method && pred(p.params));
    if (hit) return hit.params;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no ${method} push within ${ms} ms`);
};

beforeAll(async () => {
  dir = join(mkdtempSync(join(tmpdir(), 'hull-kit-')), 'game');
  await createProject({ template: 'third-person', dir, title: 'Kit tuning' });
  server = await startProjectServer({ root: dir, port: 0 });
  ws = await new Promise<WebSocket>((res, rej) => {
    const s = new WebSocket(`${server.url}?role=studio`);
    s.on('open', () => res(s));
    s.on('error', rej);
  });
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.id !== undefined) waiting.get(m.id)?.(m); else pushes.push(m);
  });
}, 60_000);

afterAll(async () => {
  ws?.close();
  await server?.close();
  rmSync(join(dir, '..'), { recursive: true, force: true });
});

const file = (): string => join(dir, 'config', 'tuning', 'third-person.json');

describe('kit tunables', () => {
  it('lists the kit blocks the project imports, marked as kit, and none it does not', async () => {
    const list = await call<any[]>('tunables.list');
    const run = list.find((t) => t.block === 'thirdPerson' && t.key === 'runSpeed');
    expect(run).toMatchObject({ source: 'kit', value: 7, initial: 7, overrides: 'config/tuning/third-person.json' });
    expect(list.some((t) => t.block === 'followCamera' && t.key === 'distance')).toBe(true);
    expect(list.some((t) => t.block === 'fps')).toBe(false);
    const lib = await call<any[]>('library.list');
    expect(lib.find((i) => i.id === 'tunables:thirdPerson')).toMatchObject({ kind: 'tunables', source: 'kit' });
  });

  it('writes only the changed key into a new tuning file, journaled and pushed as a config change', async () => {
    expect(existsSync(file())).toBe(false);
    const r = await call('tunables.set', { block: 'thirdPerson', key: 'runSpeed', value: 12, author: 'you' });
    expect(r.ok).toBe(true);
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ kind: 'tuning', runSpeed: 12 });
    const push = await until('config.changed', (p) => p.id === 'tuning/third-person');
    expect(JSON.parse(push.text).runSpeed).toBe(12);
    expect((await call<any[]>('journal.list', {})).at(-1)).toMatchObject({ target: 'tuning/third-person', path: '/runSpeed', from: 7, to: 12, by: 'you' });
    const t = (await call<any[]>('tunables.list')).find((x) => x.block === 'thirdPerson' && x.key === 'runSpeed');
    expect(t).toMatchObject({ value: 12, initial: 7 });
  });

  it('does not touch the engine source', async () => {
    const src = readFileSync(join(import.meta.dirname, '../../../hull/src/kits/third-person/third-person.ts'), 'utf8');
    expect(src).toContain('runSpeed: num(7,');
  });

  it('removes the key when the value returns to the kit value', async () => {
    await call('tunables.set', { block: 'thirdPerson', key: 'jumpHeight', value: 2 });
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ kind: 'tuning', runSpeed: 12, jumpHeight: 2 });
    await call('tunables.set', { block: 'thirdPerson', key: 'runSpeed', value: 7 });
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ kind: 'tuning', jumpHeight: 2 });
  });

  it('rejects a value outside the tunable options and leaves the file alone', async () => {
    const before = readFileSync(file(), 'utf8');
    const r = await call('tunables.set', { block: 'thirdPerson', key: 'runSpeed', value: 500 });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatchObject({ file: 'config/tuning/third-person.json', pointer: '/runSpeed' });
    expect(readFileSync(file(), 'utf8')).toBe(before);
  });

  it('reports a bad value written by hand with its file and pointer', async () => {
    writeFileSync(file(), `{\n  "kind": "tuning",\n  "runSpeed": 900\n}\n`);
    const p = await until('problems', (x) => x.problems.some((q: any) => q.rule === 'tunable'));
    expect(p.problems.find((q: any) => q.rule === 'tunable')).toMatchObject({ file: 'config/tuning/third-person.json', pointer: '/runSpeed', line: 3 });
    expect(p.problems.filter((q: any) => q.file === 'config/tuning/third-person.json')).toHaveLength(1);
    // The game is told too, so it skips just that key like a restart would, instead of keeping an older value.
    expect((await until('config.changed', (c) => c.id === 'tuning/third-person' && c.text.includes('900'))).path).toBe('config/tuning/third-person.json');
    const t = (await call<any[]>('tunables.list')).find((x) => x.key === 'runSpeed');
    expect(t.value).toBe(7);
  });
});
