// game.run across a hot reload: the page's socket closes and a new one opens a moment later. The op waits for it (bounded)
// instead of failing, and a reload during the request is said in the result. Real project server, fake games.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createProject, startProjectServer, type ProjectServer } from './index.ts';

let dir: string;
let server: ProjectServer;
const sockets: WebSocket[] = [];
const wsOpen = (url: string): Promise<WebSocket> => new Promise((res, rej) => { const ws = new WebSocket(url); sockets.push(ws); ws.on('open', () => res(ws)); ws.on('error', rej); });

/** A game answering every op with tick 60 unless `dropFirst`, which closes the socket on the first op without answering (a reload mid-request). */
async function fakeGame(client: string, dropFirst = false): Promise<WebSocket> {
  const ws = await wsOpen(`${server.url}?role=game&client=${client}`);
  let dropped = !dropFirst;
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.method !== 'game.rpc') return;
    if (!dropped) { dropped = true; ws.close(); return; }
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'game.result', params: { id: m.params.id, ok: true, result: { tick: 60, time: 1, checksum: 'x', paused: true, nodes: {}, held: [] } } }));
  });
  return ws;
}

class Studio {
  private n = 1;
  private waiting = new Map<number, (m: { result?: any; error?: { message: string } }) => void>();
  constructor(readonly ws: WebSocket) { ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.id !== undefined) this.waiting.get(m.id)?.(m); }); }
  call(method: string, params: unknown = {}): Promise<any> {
    const id = this.n++;
    return new Promise((res, rej) => { this.waiting.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let studio: Studio;

beforeAll(async () => {
  dir = join(mkdtempSync(join(tmpdir(), 'hull-reloadrun-')), 'game');
  await createProject({ template: 'cube', dir, title: 'Reload run' });
  server = await startProjectServer({ root: dir, port: 0, historyQuietMs: 0 });
  studio = new Studio(await wsOpen(`${server.url}?role=studio`));
}, 60_000);

afterAll(async () => {
  for (const s of sockets) s.close();
  await server?.close();
  rmSync(join(dir, '..'), { recursive: true, force: true });
});

describe('game.run through a reload', () => {
  it('waits for the page to reconnect instead of failing', async () => {
    const g = await fakeGame('pageA');
    expect((await studio.call('game.run', { control: { op: 'state' }, client: 'pageA' })).tick).toBe(60);
    g.close();
    await sleep(100);
    setTimeout(() => void fakeGame('pageA'), 600);
    const r = await studio.call('game.run', { control: { op: 'state' }, client: 'pageA' });
    expect(r.tick).toBe(60);
  });

  it('retries once on the new page when the old one went away mid-request, and says it reloaded', async () => {
    await fakeGame('pageB', true);
    setTimeout(() => void fakeGame('pageB'), 400);
    const r = await studio.call('game.run', { control: { op: 'step', n: 150 }, client: 'pageB' });
    expect(r).toMatchObject({ tick: 60, reloaded: true });
  });

  it('still fails at once when no game was ever connected under that name', async () => {
    const t0 = Date.now();
    await expect(studio.call('game.run', { control: { op: 'state' }, client: 'never' })).rejects.toThrow(/no game "never" is connected/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
