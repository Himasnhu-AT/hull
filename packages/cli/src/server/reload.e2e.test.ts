import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createProject, startProjectServer, type ProjectServer } from './index.ts';

// A tunable write is applied live; Vite must not reload the page for it. This broke when the project was opened
// through a symlink (macOS temp dirs live under /var, which is /private/var), because the server keyed its own
// writes by the path it was given while Vite reports real paths.
describe('tunable writes do not reload the game page', () => {
  let srv: ProjectServer;
  const vite: string[] = [];
  let rpc: WebSocket;

  beforeAll(async () => {
    const base = mkdtempSync(join(tmpdir(), 'hull-reload-'));
    const { root } = await createProject({ template: 'cube', dir: join(base, 'real'), title: 'Reload' });
    const link = join(base, 'link');
    symlinkSync(root, link);
    srv = await startProjectServer({ root: link, historyQuietMs: 0 });
    // Load the page's modules so Vite's module graph knows the tuning file.
    for (const p of ['/', '/@id/virtual:hull-boot', '/src/main.ts', '/src/tuning.ts']) await (await fetch(new URL(p, srv.gameUrl))).text();
    const client = await (await fetch(new URL('/@vite/client', srv.gameUrl))).text();
    const token = /wsToken\s*=\s*"([^"]+)"/.exec(client)?.[1];
    const origin = new URL(srv.gameUrl).origin;
    const hmr = new WebSocket(`${srv.url}?token=${token}`, 'vite-hmr', { origin });
    hmr.on('message', (d) => vite.push(String(d)));
    await new Promise((r) => hmr.on('open', r));
    rpc = new WebSocket(`${srv.url}?role=studio`, { origin });
    await new Promise((r) => rpc.on('open', r));
  }, 60_000);
  afterAll(async () => { rpc?.close(); await srv?.close(); });

  it('sends no full-reload for the server’s own write through a symlinked root', async () => {
    const reply = new Promise<{ result?: { ok: boolean } }>((res) => rpc.on('message', (d) => { const m = JSON.parse(String(d)); if (m.id === 1) res(m); }));
    rpc.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tunables.set', params: { block: 'cube', key: 'spin', value: 4 } }));
    expect((await reply).result?.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 1500));
    expect(vite.filter((m) => m.includes('full-reload'))).toEqual([]);
  }, 30_000);
});
