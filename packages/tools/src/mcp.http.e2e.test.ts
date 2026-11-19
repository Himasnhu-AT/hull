import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProject } from './server/index.ts';
import { createMcpServer, startMcpHttp, type McpHttp, type McpServer } from './mcp/index.ts';

// The streamable-HTTP transport and the stdio launcher answer the same questions about the same project.
let fixture = '';
beforeAll(async () => { fixture = join(mkdtempSync(join(tmpdir(), 'hull-mcp-http-')), 'game'); await createProject({ template: 'arena', dir: fixture, title: 'MCP http' }); }, 90_000);
afterAll(() => rmSync(join(fixture, '..'), { recursive: true, force: true }));

describe('MCP over streamable HTTP', () => {
  let server: McpServer; let http: McpHttp;
  beforeAll(async () => { server = createMcpServer(fixture); http = await startMcpHttp(server, { port: 0 }); });
  afterAll(async () => { await http.close(); await server.close(); });

  const post = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(http.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });

  it('binds to loopback', () => { expect(http.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/); });

  it('initializes with a session, lists the tools and runs check', async () => {
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } });
    const session = init.headers.get('mcp-session-id')!;
    expect(session).toBeTruthy();
    expect((await init.json() as any).result.serverInfo.name).toBe('hull');
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': session })).status).toBe(202);
    const list = ((await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-session-id': session })).json()) as any).result.tools as { name: string }[];
    expect(list.map((t) => t.name)).toEqual(expect.arrayContaining(['check', 'build', 'config.set', 'game.run']));
    const call = ((await (await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'check', arguments: {} } }, { 'mcp-session-id': session })).json()) as any).result;
    expect(call.isError).toBe(false);
    expect(call.structuredContent).toMatchObject({ ok: true, problems: [] });
  }, 120_000);

  it('names the author from the x-hull-author header, over the client name', async () => {
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } }, { 'x-hull-author': 'Fake agent' });
    const session = init.headers.get('mcp-session-id')!;
    await init.json();
    const r = ((await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'review.note', arguments: { key: 'tunables:player', note: 'who am I' } } }, { 'mcp-session-id': session })).json()) as any).result;
    expect(JSON.stringify(r.structuredContent)).toContain('ai:Fake agent');
  }, 60_000);

  it('refuses a web page from another origin and a GET', async () => {
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await fetch(http.url)).status).toBe(405);
  });
});

describe('the stdio launcher', () => {
  it('lists the same tools and runs check', async () => {
    const proc = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'hull-mcp.js'), fixture], { stdio: ['pipe', 'pipe', 'ignore'] });
    const waiting = new Map<number, (m: any) => void>();
    createInterface({ input: proc.stdout }).on('line', (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m); });
    const rpc = (id: number, method: string, params: unknown = {}): Promise<any> => new Promise((res) => { waiting.set(id, res); proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
    try {
      await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } });
      const names = ((await rpc(2, 'tools/list')).result.tools as { name: string }[]).map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(['check', 'build', 'config.set']));
      const call = (await rpc(3, 'tools/call', { name: 'check', arguments: {} })).result;
      expect(call.structuredContent).toMatchObject({ ok: true, problems: [] });
    } finally { proc.stdin.end(); await new Promise((r) => proc.on('exit', r)); }
  }, 120_000);
});
