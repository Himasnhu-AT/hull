import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectProject } from './control/client.ts';
import { findServer } from './server/link.ts';
import { createProject, startProjectServer } from './server/index.ts';

// Project methods over MCP on a temp arena: with no server the MCP process starts one in-process; with one running
// (the app) it attaches to it, so there is only ever one.
const bin = join(import.meta.dirname, '..', 'bin', 'hull-mcp.js');
const hasBrowser = spawnSync('agent-browser', ['--version']).status === 0;

class Mcp {
  private n = 0;
  private waiting = new Map<number, (m: any) => void>();
  private proc;
  constructor(dir: string, readonly name = 'probe') {
    this.proc = spawn(process.execPath, [bin, dir], { stdio: ['pipe', 'pipe', 'ignore'] });
    createInterface({ input: this.proc.stdout }).on('line', (l) => { const m = JSON.parse(l); this.waiting.get(m.id)?.(m); });
  }
  rpc(method: string, params: unknown = {}): Promise<any> {
    const id = ++this.n;
    return new Promise((res) => { this.waiting.set(id, res); this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  }
  async init(): Promise<void> {
    await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: this.name, version: '1' } });
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }
  async tool(name: string, args: unknown = {}): Promise<any> {
    const r = await this.rpc('tools/call', { name, arguments: args });
    return r.result;
  }
  close(): Promise<void> {
    return new Promise((done) => { this.proc.on('exit', () => done()); this.proc.stdin.end(); });
  }
}

const fresh = async (): Promise<string> => {
  const dir = join(mkdtempSync(join(tmpdir(), 'hull-mcp-')), 'game');
  await createProject({ template: 'arena', dir, title: 'MCP arena' });
  return dir;
};

describe('project methods over MCP, no server running', () => {
  let dir: string;
  beforeAll(async () => { dir = await fresh(); }, 90_000);
  afterAll(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

  it('lists the methods with input and output schemas, tunes a value as ai:<client>, and removes server.json on exit', async () => {
    const mcp = new Mcp(dir, 'probe');
    try {
      await mcp.init();
      const list = (await mcp.rpc('tools/list')).result.tools as { name: string; inputSchema: any; outputSchema?: any }[];
      const names = list.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(['check', 'config.read', 'config.set', 'tunables.list', 'tunables.set', 'library.list', 'history.list', 'history.diff', 'history.restore', 'exp.start', 'exp.adopt', 'game.run', 'game.control', 'problems.list']));
      for (const t of list) expect(t.inputSchema.type, t.name).toBe('object');
      expect(list.find((t) => t.name === 'tunables.set')!.inputSchema.required).toEqual(['block', 'key', 'value']);
      expect(list.find((t) => t.name === 'game.run')!.outputSchema.type).toBe('object');
      expect(existsSync(join(dir, '.hull', 'server.json'))).toBe(false); // nothing started yet: the server starts on first use

      const set = await mcp.tool('tunables.set', { block: 'player', key: 'runSpeed', value: 12 });
      expect(set.isError).toBe(false);
      expect(set.structuredContent.ok).toBe(true);
      expect(readFileSync(join(dir, 'src/tuning.ts'), 'utf8')).toMatch(/runSpeed: num\(12,/);
      const info = JSON.parse(readFileSync(join(dir, '.hull', 'server.json'), 'utf8')) as { pid: number; url: string };
      expect(info.url).toMatch(/^ws:\/\//);

      const read = await mcp.tool('config.read', { id: 'hull.json' });
      expect(read.structuredContent.path).toBe('hull.json');
      const bad = await mcp.tool('tunables.set', { block: 'player', key: 'nope', value: 1 });
      expect(bad.isError).toBe(true);

      // history.list sees the edit, authored by the client; `check` flushes what is waiting first.
      const checked = await mcp.tool('check');
      expect(checked.structuredContent.ok).toBeDefined();
      const hist = await mcp.tool('history.list', { limit: 5 });
      expect(hist.structuredContent.items[0]).toMatchObject({ by: 'ai:probe' });
      expect(hist.structuredContent.items[0].message).toMatch(/runSpeed/);

      // The app's way of asking for problems: authorship is part of the state.
      const probs = await mcp.tool('problems.list');
      expect(probs.structuredContent.problems).toEqual(expect.any(Array));
    } finally { await mcp.close(); }
    expect(existsSync(join(dir, '.hull', 'server.json'))).toBe(false);
  }, 120_000);

  it.skipIf(!hasBrowser)('steps the game and reads the player, opening a headless page itself', async () => {
    const mcp = new Mcp(dir, 'probe');
    try {
      await mcp.init();
      const r0 = await mcp.tool('game.run', { control: { op: 'state', nodes: ['player'] } });
      const before = r0.structuredContent;
      expect(before.nodes.player.found).toBe(true);
      await mcp.tool('game.run', { control: { op: 'press', key: 'KeyW' } });
      const stepped = (await mcp.tool('game.run', { control: { op: 'step', n: 60 } })).structuredContent;
      expect(stepped.tick).toBeGreaterThanOrEqual(60);
      const after = (await mcp.tool('game.run', { control: { op: 'state', nodes: ['player'] } })).structuredContent;
      expect(after.nodes.player.z).toBeLessThan(before.nodes.player.z - 1);
    } finally { await mcp.close(); }
  }, 150_000);
});

describe('attaching to a running server', () => {
  let dir: string;
  beforeAll(async () => { dir = await fresh(); }, 90_000);
  afterAll(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

  it('uses the server that is already running, and its edits reach that server\'s clients live', async () => {
    const server = await startProjectServer({ root: dir, port: 0, historyQuietMs: 60_000 });
    const file = JSON.parse(readFileSync(join(dir, '.hull', 'server.json'), 'utf8')) as { pid: number; url: string; gameUrl: string };
    expect(file).toMatchObject({ pid: process.pid, url: server.url, gameUrl: server.gameUrl });
    const app = await connectProject(server.url);
    const pushes: unknown[] = [];
    // A second studio-role socket, to see what the MCP edit pushes to the app.
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(`${server.url}?role=studio`);
    await new Promise((r) => ws.on('open', r));
    ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.method) pushes.push(m); });
    const mcp = new Mcp(dir, 'claude-code');
    try {
      await mcp.init();
      const r = await mcp.tool('tunables.set', { block: 'player', key: 'runSpeed', value: 9 });
      expect(r.structuredContent.ok).toBe(true);
      expect(pushes).toContainEqual(expect.objectContaining({ method: 'journal.added', params: expect.objectContaining({ by: 'ai:claude-code', to: 9 }) }));
      // Still one server: the file still names this process, and the app's own call sees the MCP edit.
      expect(JSON.parse(readFileSync(join(dir, '.hull', 'server.json'), 'utf8')).pid).toBe(process.pid);
      expect((await app.call('journal.list', {})).at(-1)).toMatchObject({ by: 'ai:claude-code' });
    } finally {
      await mcp.close();
      ws.close();
      app.close();
    }
    // The MCP process attached, so it did not own the file and leaves it be.
    expect(existsSync(join(dir, '.hull', 'server.json'))).toBe(true);
    await server.close();
    expect(existsSync(join(dir, '.hull', 'server.json'))).toBe(false);
  }, 120_000);

  it('a leftover server.json from a dead process or a dead address is stale and is removed', async () => {
    const f = join(dir, '.hull', 'server.json');
    writeFileSync(f, JSON.stringify({ url: 'ws://127.0.0.1:1/', gameUrl: 'http://127.0.0.1:1/', pid: 2_000_000_000 }));
    expect(await findServer(dir)).toBeUndefined();
    expect(existsSync(f)).toBe(false);
    // The pid is alive (this process) but nothing answers at the address: still stale.
    writeFileSync(f, JSON.stringify({ url: 'ws://127.0.0.1:1/', gameUrl: 'http://127.0.0.1:1/', pid: process.pid }));
    expect(await findServer(dir)).toBeUndefined();
    expect(existsSync(f)).toBe(false);
    writeFileSync(f, 'not json');
    expect(await findServer(dir)).toBeUndefined();
  });

  it('pushes authorship problems with the problem state, without a `check`', async () => {
    const server = await startProjectServer({ root: dir, port: 0, historyQuietMs: 0 });
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(`${server.url}?role=studio`);
    await new Promise((r) => ws.on('open', r));
    const problemPushes: { problems: { rule: string }[] }[] = [];
    ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.method === 'problems') problemPushes.push(m.params); });
    const app = await connectProject(server.url);
    try {
      await app.call('tunables.set', { block: 'player', key: 'runSpeed', value: 8, author: 'you' });
      await new Promise((r) => setTimeout(r, 400));
      await app.call('tunables.set', { block: 'player', key: 'runSpeed', value: 15, author: 'ai:claude-code' });
      const end = Date.now() + 8000;
      while (Date.now() < end && !problemPushes.some((p) => p.problems.some((x) => x.rule === 'authorship'))) await new Promise((r) => setTimeout(r, 50));
      expect(problemPushes.some((p) => p.problems.some((x) => x.rule === 'authorship'))).toBe(true);
      expect(((await app.call('problems.list', {})) as { rule: string }[]).some((x) => x.rule === 'authorship')).toBe(true);
    } finally { ws.close(); app.close(); await server.close(); }
  }, 60_000);
});
