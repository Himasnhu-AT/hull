// The Content Browser's tools through a real project server: they write the files, rewrite references, refuse what would
// break something, record each change in the history with its author, and tell the game and the Studio.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createProject, startProjectServer, type ProjectServer } from './index.ts';
import { projectTools } from '../tools/project.ts';

let dir: string;
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
// The app calls the project server's methods; the MCP tools of tools/project.ts are the same methods under the same names.
const tool = async (name: string, input: unknown): Promise<{ ok: boolean; output: any; problems: any[] }> => { const o = await call(name, input); return { ok: o.ok ?? true, output: o, problems: o.problems ?? [] }; };
const read = (p: string): string => readFileSync(join(dir, p), 'utf8');

beforeAll(async () => {
  dir = join(mkdtempSync(join(tmpdir(), 'hull-assets-')), 'game');
  await createProject({ template: 'cube', dir, title: 'Assets' });
  mkdirSync(join(dir, 'config/sound'), { recursive: true });
  mkdirSync(join(dir, 'config/material'), { recursive: true });
  writeFileSync(join(dir, 'config/sound/click.json'), JSON.stringify({ kind: 'sound', bus: 'top', source: { type: 'synth', length: 0.1, layers: { a: { from: { osc: 'sine', freq: 300 }, then: [{ envelope: { attack: 0.001, decay: 0.05 } }] } } } }, null, 2));
  writeFileSync(join(dir, 'config/sound/clicks.json'), JSON.stringify({ kind: 'sound', bus: 'top', source: { type: 'pick', from: ['sound/click'] } }, null, 2));
  writeFileSync(join(dir, 'config/material/cloth.json'), '{"kind":"material","color":"#445566","roughness":0.5,"metalness":0}');
  writeFileSync(join(dir, 'src/ids.ts'), "export const CLICK = 'sound/click';\n");
  server = await startProjectServer({ root: dir, port: 0, historyQuietMs: 0 });
  ws = new WebSocket(server.url + '?role=studio');
  ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.id !== undefined) waiting.get(m.id)?.(m); else pushes.push(m); });
  await new Promise((r) => ws.on('open', r));
}, 60_000);

afterAll(async () => {
  ws?.close();
  await server?.close();
  rmSync(join(dir, '..'), { recursive: true, force: true });
});

describe('asset tools', () => {
  it('are in the registry as tools, so the app and MCP reach them', () => {
    const names = projectTools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['content.list', 'asset.refs', 'asset.new', 'asset.duplicate', 'asset.rename', 'asset.move', 'asset.delete', 'folder.new']));
  });

  it('lists folders, code and previews', async () => {
    const r = await call('content.list');
    expect(r.folders).toEqual(expect.arrayContaining(['sound', 'material']));
    expect(r.code.map((c: any) => c.path)).toContain('src/ids.ts');
    expect(r.thumbs['material/cloth']).toMatchObject({ type: 'material', color: '#445566' });
    expect(r.thumbs['sound/click'].bars).toHaveLength(28);
    expect(r.creatable).toContain('sound');
  });

  it('says who refers to an asset and what it uses', async () => {
    const r = await tool('asset.refs', { id: 'sound/click' });
    expect(r.output.referencedBy.map((x: any) => x.file)).toEqual(['config/sound/clicks.json', 'src/ids.ts']);
    expect(r.output.referencedBy[0]).toMatchObject({ pointer: '/source/from/0' });
    expect((await tool('asset.refs', { id: 'sound/clicks' })).output.uses.map((u: any) => u.id)).toEqual(['sound/click']);
  });

  it('refuses to delete a referenced asset and lists the places; nothing changes', async () => {
    const r = await tool('asset.delete', { ids: ['sound/click'] });
    expect(r.ok).toBe(false);
    expect(r.output.refs.length).toBe(2);
    expect(r.problems[0].message).toContain('config/sound/clicks.json#/source/from/0');
    expect(r.problems[0].message).toContain('src/ids.ts');
    expect(existsSync(join(dir, 'config/sound/click.json'))).toBe(true);
  });

  it('renames with references rewritten in configs and code, as the caller, recorded in the history', async () => {
    const r = await tool('asset.rename', { id: 'sound/click', to: 'sound/ui/tap', author: 'ai:test' });
    expect(r.ok).toBe(true);
    expect(existsSync(join(dir, 'config/sound/click.json'))).toBe(false);
    expect(existsSync(join(dir, 'config/sound/ui/tap.json'))).toBe(true);
    expect(JSON.parse(read('config/sound/clicks.json')).source.from).toEqual(['sound/ui/tap']);
    expect(read('src/ids.ts')).toContain("'sound/ui/tap'");
    expect(read('.hull/gen/ids.ts')).toContain("'clicks' | 'ui/tap'");
    await call('history.list', {});
    const h = await call('history.list', { limit: 3 });
    expect(h[0].by).toBe('ai:test');
    expect(pushes.some((p) => p.method === 'config.removed' && p.params.id === 'sound/click')).toBe(true);
    const journal = await call('journal.list', {});
    expect(journal.at(-1)).toMatchObject({ target: 'sound/ui/tap', from: 'sound/click', to: 'sound/ui/tap', by: 'ai:test' });
    expect((await call('problems.list')).filter((p: any) => p.file.startsWith('config/'))).toEqual([]);
  });

  it('refuses a rename onto an existing id and a kind change', async () => {
    expect((await tool('asset.rename', { id: 'sound/ui/tap', to: 'sound/clicks' })).ok).toBe(false);
    expect((await tool('asset.rename', { id: 'sound/ui/tap', to: 'material/tap' })).ok).toBe(false);
  });

  it('moves assets and whole folders; references follow', async () => {
    expect((await tool('folder.new', { path: 'sound/combat' })).ok).toBe(true);
    expect(existsSync(join(dir, 'config/sound/combat'))).toBe(true);
    expect((await call('content.list')).folders).toContain('sound/combat');
    expect((await tool('asset.move', { ids: ['sound/ui/tap'], folder: 'sound/combat' })).ok).toBe(true);
    expect(JSON.parse(read('config/sound/clicks.json')).source.from).toEqual(['sound/combat/tap']);
    expect((await tool('asset.rename', { id: 'sound/combat', to: 'sound/fight' })).ok).toBe(true);
    expect(JSON.parse(read('config/sound/clicks.json')).source.from).toEqual(['sound/fight/tap']);
    expect(existsSync(join(dir, 'config/sound/combat'))).toBe(false);
    expect(read('src/ids.ts')).toContain("'sound/fight/tap'");
  });

  it('creates from a starter and duplicates', async () => {
    expect((await tool('asset.new', { kind: 'material', id: 'material/steel' })).ok).toBe(true);
    expect(JSON.parse(read('config/material/steel.json')).kind).toBe('material');
    expect((await tool('asset.new', { kind: 'material', id: 'material/steel' })).ok).toBe(false);
    const d = await tool('asset.duplicate', { id: 'material/steel' });
    expect(d.output.created).toEqual(['material/steel-copy']);
    expect(read('config/material/steel-copy.json')).toBe(read('config/material/steel.json'));
  });

  it('deletes an unreferenced asset, and a folder with its assets once nothing refers to them', async () => {
    expect((await tool('asset.delete', { ids: ['material/steel-copy', 'material/steel'] })).ok).toBe(true);
    expect(existsSync(join(dir, 'config/material/steel-copy.json'))).toBe(false);
    const gone = await tool('asset.delete', { ids: ['sound/fight'] });
    expect(gone.ok).toBe(false);
    expect(existsSync(join(dir, 'config/sound/fight/tap.json'))).toBe(true);
  });
});
