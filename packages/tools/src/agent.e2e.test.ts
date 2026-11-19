import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectProject, type ProjectClient } from './control/client.ts';
import { compareImages } from './play/golden.ts';
import { decodePng, encodePng } from './play/png.ts';
import { createProject, startProjectServer, type ProjectServer } from './server/index.ts';
import { play } from './tools/play.ts';
import type { PlayScript } from './play/run.ts';

// The M3 agent loop on a temp copy of the arena: review notes set through the protocol and listed over MCP, and a step
// script whose golden image catches a changed runSpeed.
const bin = join(import.meta.dirname, '..', 'bin', 'hull-mcp.js');
const hasBrowser = spawnSync('agent-browser', ['--version']).status === 0;

let dir: string;
let server: ProjectServer;
let studio: ProjectClient;

beforeAll(async () => {
  dir = join(mkdtempSync(join(tmpdir(), 'hull-agent-')), 'game');
  await createProject({ template: 'arena', dir, title: 'Agent arena' });
  server = await startProjectServer({ root: dir, port: 0, historyQuietMs: 60_000 });
  studio = await connectProject(server.url);
}, 90_000);

afterAll(async () => {
  studio?.close();
  await server?.close();
  rmSync(join(dir, '..'), { recursive: true, force: true });
});

class Mcp {
  private n = 0;
  private waiting = new Map<number, (m: any) => void>();
  private proc = spawn(process.execPath, [bin, dir], { stdio: ['pipe', 'pipe', 'pipe'] });
  constructor() {
    createInterface({ input: this.proc.stdout }).on('line', (l) => { const m = JSON.parse(l); this.waiting.get(m.id)?.(m); });
  }
  call(method: string, params: unknown = {}): Promise<any> {
    const id = ++this.n;
    return new Promise((res) => {
      this.waiting.set(id, res);
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  notify(method: string): void { this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`); }
  close(): void { this.proc.stdin.end(); }
}

describe('png and golden compare', () => {
  it('round-trips a picture and counts only pixels over the tolerance', () => {
    const a = { width: 4, height: 2, data: new Uint8Array(32).fill(100) };
    const b = { width: 4, height: 2, data: new Uint8Array(a.data) };
    b.data[0] = 105; // within tolerance 8
    b.data[8] = 160; // not
    const back = decodePng(encodePng(a));
    expect(Array.from(back.data)).toEqual(Array.from(a.data));
    const c = compareImages(a, b, { channel: 8, pixels: 0 });
    expect(c.ok).toBe(false);
    expect(c.diffPixels).toBe(1);
    expect(c.maxDelta).toBe(60);
    expect(compareImages(a, b, { channel: 8, pixels: 1 }).ok).toBe(true);
  });
});

describe('review notes and MCP', () => {
  it('lists, over MCP, a note that was set through the protocol', async () => {
    const set = await studio.call('review.set', { key: 'tunables:player', state: 'needs-change', note: 'Feels slippery on the turn.', author: 'you' });
    expect(set.ok).toBe(true);
    const bad = await studio.call('review.set', { key: 'sound/no/such', state: 'approved' });
    expect(bad.ok).toBe(false);
    expect(bad.problems[0]!.message).toContain('sound/no/such');

    const mcp = new Mcp();
    try {
      const init = await mcp.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-agent', version: '1' } });
      expect(init.result.serverInfo.name).toBe('hull');
      mcp.notify('notifications/initialized');
      const list = await mcp.call('tools/list');
      const names = list.result.tools.map((t: { name: string }) => t.name);
      expect(names).toEqual(expect.arrayContaining(['check', 'review.list', 'review.set', 'review.note', 'play']));
      expect(names).not.toContain('dev');
      expect(list.result.tools.find((t: { name: string }) => t.name === 'review.set').inputSchema.required).toEqual(['key', 'state']);

      const got = await mcp.call('tools/call', { name: 'review.list', arguments: {} });
      expect(got.result.isError).toBe(false);
      expect(got.result.structuredContent.entries).toMatchObject([{ key: 'tunables:player', state: 'needs-change', note: 'Feels slippery on the turn.', by: 'you' }]);

      // A write over MCP is recorded with the agent's name, and a bad call is an error the agent can read.
      const note = await mcp.call('tools/call', { name: 'review.note', arguments: { key: 'tunables:camera', note: 'Too far back.' } });
      expect(note.result.structuredContent.entry.by).toBe('ai:test-agent');
      const err = await mcp.call('tools/call', { name: 'review.set', arguments: { key: 'tunables:player', state: 'maybe' } });
      expect(err.result.isError).toBe(true);
      const unknown = await mcp.call('tools/call', { name: 'nope', arguments: {} });
      expect(unknown.error.message).toContain('unknown tool');
    } finally { mcp.close(); }
  }, 60_000);

  it('a piece that changes after review falls back to unreviewed and keeps its note', async () => {
    await studio.call('review.set', { key: 'tunables:camera', state: 'approved' });
    await studio.call('tunables.set', { block: 'camera', key: 'distance', value: 10, author: 'you' });
    const e = (await studio.call('review.list', {})).find((x) => x.key === 'tunables:camera')!;
    expect(e).toMatchObject({ state: 'unreviewed', stale: true, was: 'approved', note: 'Too far back.' });
  });
});

describe.skipIf(!hasBrowser)('play tool', () => {
  const script: PlayScript = { steps: [{ hold: 'KeyW', steps: 60 }, { check: { node: 'player', axis: 'z', max: -3 } }, { screenshot: 'walk' }] };
  const ctx = () => ({ root: dir, author: 'ai:test', log: () => {}, signal: new AbortController().signal, server: { url: server.url, gameUrl: server.gameUrl } });

  it('walks the player, saves a golden, and a second run matches it exactly', async () => {
    const first = await play.run(ctx(), { script });
    expect(first.problems).toEqual([]);
    expect(first.steps.at(-1)?.golden?.status).toBe('new');
    const second = await play.run(ctx(), { script });
    expect(second.ok).toBe(true);
    expect(second.steps.at(-1)?.golden).toMatchObject({ status: 'match', diffPixels: 0 });
    expect(second.checksum).toBe(first.checksum);
  }, 90_000);

  it('a changed runSpeed fails the golden and the report names the step and the pixel difference', async () => {
    const r = await studio.call('tunables.set', { block: 'player', key: 'runSpeed', value: 10, author: 'you' });
    expect(r.ok).toBe(true);
    const out = await play.run(ctx(), { script });
    expect(out.ok).toBe(false);
    const failed = out.steps.find((s) => !s.ok)!;
    expect(failed.index).toBe(2);
    expect(failed.golden?.diffPixels).toBeGreaterThan(1000);
    expect(out.problems[0]!.message).toMatch(/^step 2 .*golden "walk" at tick 60: \d+ of 230400 pixels differ/);
    expect(readFileSync(join(dir, '.hull/play/walk.diff.png')).subarray(1, 4).toString()).toBe('PNG');
  }, 90_000);

  it('rejects a script with a bad step before starting a browser', async () => {
    const out = await play.run(ctx(), { script: { steps: [{ step: 5 }, { wait: 1000 } as never] } });
    expect(out.ok).toBe(false);
    expect(out.problems[0]).toMatchObject({ pointer: '/steps/1', rule: 'play' });
  });
});
