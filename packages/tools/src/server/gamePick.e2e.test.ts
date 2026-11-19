// Which game a call without a client reaches: the one in the app's frame, not a headless page a tool opened. Real project server,
// fake games that answer the control port with their own time so the answers tell them apart.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createProject, startProjectServer, type ProjectServer } from './index.ts';

let dir: string;
let server: ProjectServer;
const sockets: WebSocket[] = [];
const heard = new Map<string, unknown[]>();

const wsOpen = (url: string): Promise<WebSocket> => new Promise((res, rej) => { const ws = new WebSocket(url); sockets.push(ws); ws.on('open', () => res(ws)); ws.on('error', rej); });

class Studio {
  private n = 1;
  private waiting = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>();
  readonly pushes: { method: string; params: any }[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.id !== undefined) this.waiting.get(m.id)?.(m); else this.pushes.push(m); });
  }
  call<T = any>(method: string, params: unknown = {}): Promise<T> {
    const id = this.n++;
    return new Promise((res, rej) => { this.waiting.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result as T))); this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
  }
}

/** A game that says its time is `time`, and that records the controls it hears. */
async function fakeGame(client: string, time: number, headless: boolean): Promise<WebSocket> {
  const ws = await wsOpen(`${server.url}?role=game&client=${client}${headless ? '&headless=1' : ''}`);
  heard.set(client, []);
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.method === 'game.control') heard.get(client)!.push(m.params);
    if (m.method === 'game.rpc') {
      const result = m.params.control.op === 'state' ? { tick: time * 60, time, checksum: 'x', paused: true, nodes: {}, held: [] } : { png: 'AAAA', width: 2, height: 1 };
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'game.result', params: { id: m.params.id, ok: true, result } }));
    }
  });
  return ws;
}

let studio: Studio;

beforeAll(async () => {
  dir = join(mkdtempSync(join(tmpdir(), 'hull-pick-')), 'game');
  await createProject({ template: 'cube', dir, title: 'Pick' });
  server = await startProjectServer({ root: dir, port: 0, historyQuietMs: 0 });
  studio = new Studio(await wsOpen(`${server.url}?role=studio`));
}, 60_000);

afterAll(async () => {
  for (const s of sockets) s.close();
  await server?.close();
  rmSync(join(dir, '..'), { recursive: true, force: true });
});

describe('choosing the game', () => {
  it('uses a headless page when it is the only game', async () => {
    await fakeGame('head', 1, true);
    expect((await studio.call('game.run', { control: { op: 'state' } })).time).toBe(1);
  });

  it('prefers the game in a frame to a headless one that connected first, and still reaches either by name', async () => {
    await fakeGame('frame', 10, false);
    expect((await studio.call('game.run', { control: { op: 'state' } })).time).toBe(10);
    expect((await studio.call('game.moment')).time).toBe(10);
    expect((await studio.call('game.run', { control: { op: 'state' }, client: 'head' })).time).toBe(1);
    expect((await studio.call('game.moment', { client: 'head' })).time).toBe(1);
  });

  it('aims game.control at the named game only, and at all without a name', async () => {
    heard.get('head')!.length = 0; heard.get('frame')!.length = 0;
    await studio.call('game.control', { paused: false, client: 'frame' });
    await new Promise((r) => setTimeout(r, 100));
    expect(heard.get('frame')).toEqual([{ paused: false }]);
    expect(heard.get('head')).toEqual([]);
    await studio.call('game.control', { restart: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(heard.get('head')).toEqual([{ restart: true }]);
  });

  it('tags the Just now push with the game that did it', async () => {
    const ws = sockets.find((s) => s.url.includes('client=frame'))!;
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'game.events', params: { items: [{ at: 1, kind: 'sound', id: 'sound/a', label: 'A' }] } }));
    for (let i = 0; i < 100 && !studio.pushes.some((p) => p.method === 'game.recent'); i++) await new Promise((r) => setTimeout(r, 20));
    expect(studio.pushes.find((p) => p.method === 'game.recent')!.params).toMatchObject({ client: 'frame', items: [{ id: 'sound/a' }] });
  });
});
