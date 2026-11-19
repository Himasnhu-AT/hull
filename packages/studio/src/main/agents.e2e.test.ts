import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProject } from '@hull/tools/server';
import type { AgentEvent } from '../shared/agentApi.ts';
import { createHost, type Host } from './host.ts';

// The agent hub against a scripted ACP agent (fixtures/fake-acp-agent.mjs) and a real project: the agent is started as a
// child process, handed Hull's MCP server in session/new, and its change comes back authored by it in the history.
const fixture = join(import.meta.dirname, 'fixtures', 'fake-acp-agent.mjs');
let dir = ''; let data = ''; let host: Host; let root = ''; let mcpUrl = '';
const events: AgentEvent[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hull-acp-'));
  data = join(dir, 'data');
  root = join(dir, 'game');
  await createProject({ template: 'arena', dir: root, title: 'ACP arena' });
  const fake = join(dir, 'hull-fake.json');
  writeFileSync(fake, JSON.stringify([
    { text: 'Checking first.', tools: [{ name: 'check', input: {} }] },
    { tools: [{ name: 'tunables.set', input: { block: 'player', key: 'runSpeed', value: 8 } }] },
    { text: 'Raised the run speed to 8.' },
  ]));
  host = createHost({ dataDir: data, env: { ...process.env, HULL_AGENT_FAKE: fake, HULL_ACP_AGENTS: JSON.stringify([{ id: 'fake', name: 'Fake agent', command: process.execPath, args: [fixture] }]) } });
  host.onAgentEvent((e) => events.push(e));
  mcpUrl = (await host.openProject(root)).mcp.url;
}, 120_000);
afterAll(async () => { await host.closeProject(); rmSync(dir, { recursive: true, force: true }); });

const waitFor = async (pred: () => boolean, ms = 60_000): Promise<void> => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error('timed out waiting for events: ' + JSON.stringify(events.slice(-6))); await new Promise((r) => setTimeout(r, 40)); } };
async function mcpCall(name: string, args: unknown): Promise<{ structuredContent: unknown }> {
  const post = (body: unknown, h: Record<string, string> = {}): Promise<Response> => fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body) });
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  const session = init.headers.get('mcp-session-id')!;
  return ((await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }, { 'mcp-session-id': session })).json()) as { result: { structuredContent: unknown } }).result;
}
const types = (sid: string): string[] => events.filter((e) => 'sid' in e && e.sid === sid).map((e) => e.type);

describe('agent hub', () => {
  it('lists Hull agent, the added agent and the ones that are missing with how to install them', async () => {
    const list = await host.agents.list();
    expect(list.map((a) => a.id)).toEqual(expect.arrayContaining(['hull', 'codex', 'gemini', 'opencode', 'fake']));
    expect(list.find((a) => a.id === 'fake')).toMatchObject({ installed: true });
    const codex = list.find((a) => a.id === 'codex')!;
    if (!codex.installed) expect(codex.install).toContain('codex-acp');
    expect(() => JSON.stringify(list)).not.toThrow();
  });

  it('runs a prompt: plan, tool calls, a permission card that is approved, a diff, and the change in the history under the agent', async () => {
    events.length = 0;
    const sid = await host.agents.start('fake');
    await host.agents.prompt(sid, 'raise the speed');
    await waitFor(() => events.some((e) => e.type === 'permission'));
    const perm = events.find((e): e is Extract<AgentEvent, { type: 'permission' }> => e.type === 'permission')!;
    expect(perm.tool.content[0]).toMatchObject({ kind: 'diff', path: 'config/tuning/player.json' });
    expect(perm.options.map((o) => o.kind)).toEqual(['allow_once', 'reject_once']);
    await host.agents.answer(sid, perm.reqId, 'allow');
    await waitFor(() => events.some((e) => e.type === 'done'));
    const t = types(sid);
    expect(t).toEqual(expect.arrayContaining(['status', 'plan', 'message', 'tool', 'permission', 'permission-done', 'done']));
    const lastPlan = [...events].reverse().find((e): e is Extract<AgentEvent, { type: 'plan' }> => e.type === 'plan')!;
    expect(lastPlan.entries.map((x) => x.status)).toEqual(['completed', 'completed', 'completed']);
    expect(events.find((e) => e.type === 'done')).toMatchObject({ stopReason: 'end_turn' });
    const tools = events.filter((e): e is Extract<AgentEvent, { type: 'tool' }> => e.type === 'tool');
    expect(tools.some((x) => x.tool.id === 'c2' && x.tool.status === 'completed' && x.tool.content[0]?.kind === 'diff')).toBe(true);

    // The change is in the project's history, authored by the agent's name, not "mcp".
    const list = await mcpCall('history.list', { limit: 5 });
    const items = (list.structuredContent as { items: { by: string; message: string }[] }).items;
    expect(items[0]).toMatchObject({ by: 'ai:Fake agent' });
    expect(items[0]!.message).toMatch(/runSpeed/i);
    await host.agents.stop(sid);
  }, 120_000);

  it("runs Hull's own agent (packages/agent) with its scripted model, and the history names it", async () => {
    events.length = 0;
    const list = await host.agents.list();
    expect(list.find((a) => a.id === 'hull')).toMatchObject({ installed: true });
    expect(list.find((a) => a.id === 'hull')!.needs).toBeUndefined();
    const sid = await host.agents.start('hull');
    await host.agents.prompt(sid, 'Raise the run speed to 8');
    await waitFor(() => events.some((e) => e.type === 'done'), 90_000);
    expect(events.find((e) => e.type === 'done')).toMatchObject({ stopReason: 'end_turn' });
    const tools = events.filter((e): e is Extract<AgentEvent, { type: 'tool' }> => e.type === 'tool');
    expect(tools.length).toBeGreaterThan(1);
    const items = ((await mcpCall('history.list', { limit: 3 })).structuredContent as { items: { by: string }[] }).items;
    expect(items[0]!.by).toBe('ai:Hull agent');
    await host.agents.stop(sid);
  }, 150_000);

  it('a denied permission leaves the project alone and ends the run', async () => {
    events.length = 0;
    const sid = await host.agents.start('fake');
    await host.agents.prompt(sid, 'raise the speed again');
    await waitFor(() => events.some((e) => e.type === 'permission'));
    const perm = events.find((e): e is Extract<AgentEvent, { type: 'permission' }> => e.type === 'permission')!;
    await host.agents.answer(sid, perm.reqId, null);
    await waitFor(() => events.some((e) => e.type === 'done'));
    expect(events.find((e) => e.type === 'permission-done')).toMatchObject({ optionId: null });
    expect(events.some((e) => e.type === 'tool' && e.tool.id === 'c2')).toBe(false);
    await host.agents.stop(sid);
  }, 120_000);

  it('cancel ends a run that is waiting', async () => {
    events.length = 0;
    const sid = await host.agents.start('fake');
    await host.agents.prompt(sid, 'wait for me');
    await waitFor(() => events.some((e) => e.type === 'message'));
    await host.agents.cancel(sid);
    await waitFor(() => events.some((e) => e.type === 'done'));
    expect(events.find((e) => e.type === 'done')).toMatchObject({ stopReason: 'cancelled' });
    await host.agents.stop(sid);
  }, 60_000);

  it('says why an agent that is not installed cannot start', async () => {
    await expect(host.agents.start('opencode')).rejects.toThrow(/not installed|opencode/i);
  });
});
