#!/usr/bin/env node
// Maintainer script (never ships). One MCP tool call through scripts/mcp-client.mjs:
//   node scripts/mcp-call.mjs <tool> ['<json arguments>' | '@file.json']   |   --tools [name]   |   --instructions
// A picture in a result is saved by the client and printed as "[image saved: <path>]".
const port = process.env.HULL_MCPD_PORT || '5599';
const [tool, json] = process.argv.slice(2);
const get = async (p, init) => (await fetch('http://127.0.0.1:' + port + p, init)).json();
if (tool === '--instructions') { console.log((await get('/instructions')).instructions); process.exit(0); }
if (tool === '--tools') {
  const { tools } = await get('/tools');
  if (json) { const t = tools.find((x) => x.name === json); console.log(t ? JSON.stringify(t, null, 1) : 'no such tool'); }
  else for (const t of tools) console.log(t.name + ': ' + t.description);
  process.exit(0);
}
let args = {};
if (json) { try { args = JSON.parse(json.startsWith('@') ? (await import('node:fs')).readFileSync(json.slice(1), 'utf8') : json); } catch (e) { console.error('arguments are not JSON: ' + e.message); process.exit(2); } }
const r = await get('/call', { method: 'POST', body: JSON.stringify({ name: tool, arguments: args }) });
if (r.protocolError) { console.log('PROTOCOL ERROR ' + JSON.stringify(r.protocolError)); process.exit(1); }
console.log((r.isError ? '[tool error] ' : '') + r.text + '\n(' + r.ms + ' ms)');
