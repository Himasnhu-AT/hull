#!/usr/bin/env node
// A scripted ACP agent for tests and screenshots: no model, no network. On a prompt it checks the project through the
// MCP server it was handed, shows a plan, asks permission to change runSpeed, and (if allowed) changes it through the
// same MCP server, so the change lands in the history under the author the app named. A prompt containing "wait"
// holds until cancelled. Not part of a ship build: it lives under fixtures/ and only HULL_ACP_AGENTS points at it.
import { Readable, Writable } from 'node:stream';
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

const sessions = new Map();
const cancelled = new Set();
let nextId = 1;

async function mcp(server, name, args) {
  const headers = { 'content-type': 'application/json', accept: 'application/json', ...Object.fromEntries((server.headers ?? []).map((h) => [h.name, h.value])) };
  const post = (body, extra = {}) => fetch(server.url, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-acp-agent', version: '1' } } });
  const session = init.headers.get('mcp-session-id');
  await init.json();
  const r = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }, { 'mcp-session-id': session })).json();
  return r.result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = agent({ name: 'fake-acp-agent' })
  .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: { mcpCapabilities: { http: true, sse: false } }, agentInfo: { name: 'fake-acp-agent', version: '1.0.0' } }))
  .onRequest(methods.agent.session.new, ({ params }) => {
    const sessionId = `fake-${nextId++}`;
    sessions.set(sessionId, params.mcpServers);
    return { sessionId };
  })
  .onNotification(methods.agent.session.cancel, ({ params }) => { cancelled.add(params.sessionId); })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const sessionId = params.sessionId;
    const servers = sessions.get(sessionId) ?? [];
    const hull = servers.find((s) => s.name === 'hull');
    const say = (update) => client.notify(methods.client.session.update, { sessionId, update });
    const text = params.prompt.map((b) => (b.type === 'text' ? b.text : '')).join(' ');
    const plan = (a, b, c) => say({ sessionUpdate: 'plan', entries: [
      { content: 'Check the project', status: a, priority: 'high' },
      { content: 'Raise the run speed', status: b, priority: 'high' },
      { content: 'Check again', status: c, priority: 'medium' },
    ] });
    cancelled.delete(sessionId);
    await plan('in_progress', 'pending', 'pending');
    await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Checking the project first. ' } });
    await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `I was handed ${servers.length} tool server(s).` } });
    if (/wait/.test(text)) { for (let i = 0; i < 200 && !cancelled.has(sessionId); i++) await sleep(50); return { stopReason: cancelled.has(sessionId) ? 'cancelled' : 'end_turn' }; }
    await say({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'check', kind: 'read', status: 'in_progress' });
    const checked = hull ? await mcp(hull, 'check', {}) : { isError: true, content: [{ type: 'text', text: 'no tool server' }] };
    await say({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: checked.isError ? 'failed' : 'completed', content: [{ type: 'content', content: { type: 'text', text: checked.isError ? 'check failed' : 'check: no problems' } }] });
    await plan('completed', 'in_progress', 'pending');
    const asked = await client.request(methods.client.session.requestPermission, {
      sessionId,
      toolCall: { toolCallId: 'c2', title: 'Set player.runSpeed to 9', kind: 'edit', status: 'pending', content: [{ type: 'diff', path: 'config/tuning/player.json', oldText: '{\n  "runSpeed": 6\n}', newText: '{\n  "runSpeed": 9\n}' }] },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Reject', kind: 'reject_once' }],
    });
    if (asked.outcome.outcome !== 'selected' || asked.outcome.optionId !== 'allow') {
      await plan('completed', 'pending', 'pending');
      await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' Understood, I will leave the speed as it is.' } });
      return { stopReason: asked.outcome.outcome === 'cancelled' && cancelled.has(sessionId) ? 'cancelled' : 'end_turn' };
    }
    await say({ sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'Set player.runSpeed to 9', kind: 'edit', status: 'in_progress' });
    const set = hull ? await mcp(hull, 'tunables.set', { block: 'player', key: 'runSpeed', value: 9 }) : { isError: true, content: [] };
    await say({ sessionUpdate: 'tool_call_update', toolCallId: 'c2', status: set.isError ? 'failed' : 'completed', content: [{ type: 'diff', path: 'config/tuning/player.json', oldText: '{\n  "runSpeed": 6\n}', newText: '{\n  "runSpeed": 9\n}' }] });
    await plan('completed', 'completed', 'in_progress');
    const again = hull ? await mcp(hull, 'check', {}) : { isError: true };
    await plan('completed', 'completed', again.isError ? 'pending' : 'completed');
    await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' Done: run speed is 9 and the project checks clean.' } });
    return { stopReason: 'end_turn' };
  });

app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
