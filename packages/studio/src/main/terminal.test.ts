import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../shared/agentApi.ts';
import { createTerminals } from './terminal.ts';

// The pane runs a real program in a real pseudo-terminal in the project folder. `sh` stands in for `claude`.
describe('terminal', () => {
  const project = { root: process.cwd(), mcp: { url: 'http://127.0.0.1:5400/mcp', launcher: '/x' } };

  it('runs the program in the project folder, passes keys in and output out, and reports the exit', async () => {
    const events: AgentEvent[] = [];
    const t = createTerminals({ project: () => project, emit: (e) => events.push(e), command: 'sh' });
    const { tid, command } = await t.open(80, 24);
    expect(command).toMatch(/sh$/);
    t.write(tid, 'pwd; echo pty-$((40+2))\r');
    const until = async (f: () => boolean): Promise<void> => { const s = Date.now(); while (!f()) { if (Date.now() - s > 10000) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 30)); } };
    const out = (): string => events.filter((e): e is Extract<AgentEvent, { type: 'term-data' }> => e.type === 'term-data').map((e) => e.data).join('');
    await until(() => out().includes('pty-42'));
    expect(out()).toContain(process.cwd());
    t.resize(tid, 100, 30);
    t.write(tid, 'exit\r');
    await until(() => events.some((e) => e.type === 'term-exit'));
    expect(events.find((e) => e.type === 'term-exit')).toMatchObject({ code: 0 });
  });

  it('says how to install a program that is missing and gives the MCP line with the app\'s URL', () => {
    const t = createTerminals({ project: () => project, emit: () => {}, command: 'definitely-not-installed-xyz' });
    const info = t.claudeInfo();
    expect(info).toMatchObject({ installed: false, mcpAdd: 'claude mcp add --transport http hull http://127.0.0.1:5400/mcp' });
    expect(info.install).toMatch(/Install/);
    return expect(t.open(80, 24)).rejects.toThrow(/not found/);
  });
});
