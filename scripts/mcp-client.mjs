// Maintainer script (never ships). A stand-in MCP client: it keeps ONE stdio session to Hull's MCP server open for a project and
// serves it on loopback, so scripts/mcp-call.mjs reaches the same session (and the same running game) on every call. This is
// how an agent that has only the MCP tools is tried out: give it mcp-call.mjs and nothing else (HANDOFF.md section 8).
//   node scripts/mcp-client.mjs <project folder> [port=5599] [folder for pictures=<project>/.hull/shots]
//   curl -s http://127.0.0.1:5599/stop      ends it (and the headless game page with it)
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(process.argv[2] ?? '.');
const port = process.argv[3] ?? '5599';
const outDir = resolve(process.argv[4] ?? root + '/.hull/shots');
mkdirSync(outDir, { recursive: true });
const p = spawn('node', [repo + '/packages/tools/bin/hull-mcp.js', root], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HULL_MCP_AUTHOR: process.env.HULL_MCP_AUTHOR ?? 'ai:mcp-client' } });
let err = ''; p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
const wait = new Map(); let id = 0; let shots = 0;
createInterface({ input: p.stdout }).on('line', (l) => { try { const m = JSON.parse(l); const w = wait.get(m.id); if (w) { wait.delete(m.id); w(m); } } catch {} });
const rpc = (method, params) => new Promise((res) => { const i = ++id; wait.set(i, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-client', version: '0' } });
const body = (req) => new Promise((res) => { let s = ''; req.on('data', (d) => { s += d; }); req.on('end', () => res(s)); });
const http = createServer(async (req, res) => {
  const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url === '/instructions') return send({ instructions: init.result?.instructions ?? '' });
  if (req.url === '/tools') return send((await rpc('tools/list', {})).result);
  if (req.url === '/stderr') return send({ err });
  if (req.url === '/stop') { send({ ok: true }); stop(); return; }
  if (req.url === '/call') {
    const { name, arguments: args } = JSON.parse(await body(req));
    const t = Date.now();
    const m = await rpc('tools/call', { name, arguments: args ?? {} });
    if (m.error) return send({ ms: Date.now() - t, protocolError: m.error });
    const parts = [];
    for (const c of m.result.content ?? []) {
      if (c.type === 'text') parts.push(c.text);
      else if (c.type === 'image') { const f = outDir + '/shot-' + (++shots) + '.png'; writeFileSync(f, Buffer.from(c.data, 'base64')); parts.push('[image saved: ' + f + ']'); }
      else parts.push('[' + c.type + ']');
    }
    return send({ ms: Date.now() - t, isError: !!m.result.isError, text: parts.join('\n') });
  }
  res.writeHead(404); res.end();
});
const stop = () => { try { p.stdin.end(); } catch {} setTimeout(() => { try { p.kill('SIGTERM'); } catch {} process.exit(0); }, 3000); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
http.listen(Number(port), '127.0.0.1', () => console.log('mcp-client up on ' + port + ' for ' + root));
