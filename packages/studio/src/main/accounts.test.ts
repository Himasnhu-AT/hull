import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claudeVia, codexVia, createAccounts, type Runner } from './accounts.ts';

// Fake `claude`, `codex` and `node` on a private PATH: the runner never really runs them, but `which` must find them.
const bin = mkdtempSync(join(tmpdir(), 'hull-acc-'));
for (const b of ['claude', 'codex', 'node']) { writeFileSync(join(bin, b), '#!/bin/sh\n'); chmodSync(join(bin, b), 0o755); }
afterAll(() => rmSync(bin, { recursive: true, force: true }));
const env = { PATH: bin, HOME: bin };
const project = { root: '/games/ironleaf', mcp: { url: 'http://127.0.0.1:5412/mcp', launcher: '/app/hull-mcp.js' } };

/** Answers by the command line; records every call. */
function fake(answers: Record<string, { code: number; out: string }>): { run: Runner; calls: string[] } {
  const calls: string[] = [];
  const run: Runner = async (file, args) => {
    const line = [file.split('/').pop(), ...args].join(' ');
    calls.push(line);
    return answers[line] ?? { code: 1, out: 'unknown' };
  };
  return { run, calls };
}

describe('accounts', () => {
  it('reads sign-in and connection from the programs, and never passes on what names the person', async () => {
    const { run } = fake({
      'claude --version': { code: 0, out: '2.1.327 (Claude Code)' },
      'claude auth status --json': { code: 0, out: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'someone@example.com' }) },
      'claude mcp get hull': { code: 0, out: `hull:\n  Type: http\n  URL: ${project.mcp.url}` },
      'codex --version': { code: 0, out: 'codex-cli 0.170.0' },
      'codex login status': { code: 0, out: 'Logged in using an API key - sk-proj-***abc' },
      'codex mcp get hull': { code: 0, out: 'hull\n  command: node /app/hull-mcp.js /games/other' },
    });
    const [claude, codex] = await createAccounts({ project: () => project, env, run }).status();
    expect(claude).toMatchObject({ id: 'claude', installed: true, version: '2.1.327', signedIn: true, via: 'Claude Max', connected: true });
    expect(JSON.stringify(claude)).not.toContain('someone@example.com');
    // Codex points at another project, so this one is not connected; the key fragment never leaves.
    expect(codex).toMatchObject({ id: 'codex', version: '0.170.0', signedIn: true, via: 'API key', connected: false });
    expect(JSON.stringify(codex)).not.toContain('sk-proj');
  });

  it('says what is missing when a program is not installed or no project is open', async () => {
    const { run, calls } = fake({ 'codex login status': { code: 1, out: 'Not logged in' } });
    const acc = createAccounts({ project: () => null, env, run, find: () => null });
    const [claude] = await acc.status();
    expect(claude).toMatchObject({ installed: false, signedIn: null, connected: null });
    expect(claude!.install).toContain('npm install');
    expect(calls).toEqual([]);
    await expect(createAccounts({ project: () => null, env, run }).run('codex', 'connect')).rejects.toThrow(/Open a project/);
  });

  it('connects each program with its own command, replacing an old entry', async () => {
    const { run, calls } = fake({
      'claude mcp remove hull -s local': { code: 1, out: 'No MCP server found' },
      [`claude mcp add --transport http hull ${project.mcp.url}`]: { code: 0, out: 'Added' },
      'codex mcp remove hull': { code: 0, out: 'Removed' },
      [`codex mcp add hull -- ${join(bin, 'node')} /app/hull-mcp.js /games/ironleaf`]: { code: 0, out: 'Added' },
      'codex logout': { code: 0, out: 'Logged out' },
    });
    const acc = createAccounts({ project: () => project, env, run });
    expect(await acc.run('claude', 'connect')).toMatch(/can use this project/);
    expect(await acc.run('codex', 'connect')).toMatch(/can use this project/);
    expect(await acc.run('codex', 'logout')).toMatch(/Signed out of Codex/);
    // Hull never handles Claude accounts (PLAN D15).
    await expect(acc.run('claude', 'logout')).rejects.toThrow(/inside Claude Code/);
    expect(calls).toEqual([
      'claude mcp remove hull -s local', `claude mcp add --transport http hull ${project.mcp.url}`,
      'codex mcp remove hull', `codex mcp add hull -- ${join(bin, 'node')} /app/hull-mcp.js /games/ironleaf`,
      'codex logout',
    ]);
  });

  it('reports a failed command with the program\'s own words', async () => {
    const { run } = fake({ [`claude mcp add --transport http hull ${project.mcp.url}`]: { code: 1, out: 'Error: config is read-only' } });
    await expect(createAccounts({ project: () => project, env, run }).run('claude', 'connect')).rejects.toThrow('Claude Code could not add Hull: Error: config is read-only');
  });

  it('names how a program is signed in in a few plain words', () => {
    expect(claudeVia({ subscriptionType: 'pro' })).toBe('Claude Pro');
    expect(claudeVia({ authMethod: 'api_key' })).toBe('API key');
    expect(claudeVia({ authMethod: 'claude.ai' })).toBe('Claude account');
    expect(codexVia('Logged in using ChatGPT')).toBe('ChatGPT');
    expect(codexVia('Not logged in')).toBeNull();
  });
});
