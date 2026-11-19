import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { createProject, startProjectServer, type ProjectServer } from '@hull/tools/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHullAgent } from './agent.ts';
import { fakeProvider, type FakeStep } from './fake.ts';
import type { Provider } from './types.ts';

// The agent over ACP against a real project server (the arena template), with a scripted model and no network.
let dir: string;
let server: ProjectServer;
const arena = (): string => join(dir, 'config', 'tuning', 'arena.json');
const thud = (): string => join(dir, 'config', 'sound', 'thud.json');
const read = (): Record<string, unknown> => JSON.parse(readFileSync(arena(), 'utf8'));

beforeAll(async () => {
  dir = join(mkdtempSync(join(tmpdir(), 'hull-agent-')), 'game');
  await createProject({ template: 'arena', dir, title: 'Agent arena' });
  writeFileSync(join(dir, 'GAME.md'), 'Rule of this game: crates are cover.\n');
  server = await startProjectServer({ root: dir, port: 0, historyQuietMs: 60_000 });
}, 90_000);

afterAll(async () => {
  await server?.close();
  rmSync(join(dir, '..'), { recursive: true, force: true });
});

interface Seen { updates: acp.SessionUpdate[]; asked: acp.RequestPermissionRequest[] }

/** Runs a client against an in-process agent; `decide` answers permission requests. */
async function session<T>(provider: Provider, decide: (r: acp.RequestPermissionRequest) => string | 'cancel', body: (c: { prompt(text: string): Promise<acp.PromptResponse>; cancel(): Promise<void>; seen: Seen }) => Promise<T>): Promise<T> {
  const up = new TransformStream<acp.AnyMessage>();
  const down = new TransformStream<acp.AnyMessage>();
  const agent = startHullAgent({ projectRoot: dir, provider, stream: { readable: up.readable, writable: down.writable }, log: () => {} });
  const seen: Seen = { updates: [], asked: [] };
  const app = acp.client({ name: 'test-client' })
    .onNotification(acp.methods.client.session.update, ({ params }) => { seen.updates.push(params.update); })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      seen.asked.push(params);
      const d = decide(params);
      return d === 'cancel' ? { outcome: { outcome: 'cancelled' as const } } : { outcome: { outcome: 'selected' as const, optionId: d } };
    });
  try {
    return await app.connectWith({ readable: down.readable, writable: up.writable }, async (ctx) => {
      const init = await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: 'test-client', version: '1' } });
      expect(init.agentInfo?.title).toBe('Hull agent');
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: dir, mcpServers: [] });
      return body({
        prompt: (text) => ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] }),
        cancel: () => ctx.notify(acp.methods.agent.session.cancel, { sessionId }),
        seen,
      });
    });
  } finally { agent.close(); await agent.closed.catch(() => {}); }
}

const kinds = (s: Seen): string[] => s.updates.map((u) => u.sessionUpdate);
const toolsStarted = (s: Seen): string[] => s.updates.filter((u): u is Extract<acp.SessionUpdate, { sessionUpdate: 'tool_call' }> => u.sessionUpdate === 'tool_call').map((u) => u.title);

describe('Hull agent over ACP', () => {
  it('plans, edits through Hull tools, checks, and is recorded under its own name', async () => {
    const script: FakeStep[] = [
      { text: 'I will raise the crate count.', tools: [{ name: 'update_plan', input: { entries: [{ content: 'Raise crateCount', status: 'in_progress' }, { content: 'Check', status: 'pending' }] } }, { name: 'config.read', input: { id: 'tuning/arena' } }] },
      { tools: [{ name: 'config.set', input: { id: 'tuning/arena', pointer: '/crateCount', value: 20 } }] },
      { tools: [{ name: 'check' }] },
      { text: 'Done: crateCount is 20 and check passes.' },
    ];
    const fake = fakeProvider(script);
    await session(fake, () => 'allow', async (c) => {
      const res = await c.prompt('More crates please');
      expect(res.stopReason).toBe('end_turn');
      expect(read()['crateCount']).toBe(20);
      const k = kinds(c.seen);
      expect(k).toContain('plan');
      expect(k).toContain('usage_update');
      expect(k.filter((x) => x === 'agent_message_chunk').length).toBe(2);
      expect(toolsStarted(c.seen)).toEqual(expect.arrayContaining(['config.read tuning/arena', 'config.set tuning/arena/crateCount', 'check']));
      const done = c.seen.updates.filter((u) => u.sessionUpdate === 'tool_call_update') as Extract<acp.SessionUpdate, { sessionUpdate: 'tool_call_update' }>[];
      const diff = done.flatMap((u) => u.content ?? []).find((x) => x.type === 'diff') as Extract<acp.ToolCallContent, { type: 'diff' }> | undefined;
      expect(diff?.newText).toContain('"crateCount": 20');
      expect(diff?.oldText).toContain('"crateCount": 14');
      expect(done.every((u) => u.status === 'completed')).toBe(true);
      expect(c.seen.asked).toHaveLength(0); // an ordinary edit does not ask
    });
    // The system prompt taught the loop and carried the project's GAME.md; the tool list carried Hull's tools only.
    const first = fake.calls[0]!;
    expect(first.system).toContain('crates are cover');
    expect(first.system).toContain('Run check after your edits');
    expect(first.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['check', 'config_set', 'tunables_set', 'game_run', 'update_plan']));
    // Recorded with its author.
    const hist = (await (await import('@hull/tools')).runTool(dir, 'history.list', { limit: 10 })) as { items: { by: string; message: string }[] };
    expect(hist.items.some((i) => i.by === 'ai:Hull agent')).toBe(true);
  }, 120_000);

  it('edits code end to end: writes src/, sees the type problem, fixes it, passes the gate; delete asks and can be refused', async () => {
    const extra = join(dir, 'src', 'extra.ts');
    const script: FakeStep[] = [
      { tools: [{ name: 'code.list' }, { name: 'code.write', input: { path: 'src/extra.ts', text: 'export const bonus = 1;\n' } }] },
      { tools: [{ name: 'code.edit', input: { path: 'src/extra.ts', old: 'bonus = 1', new: 'bonus: string = 1' } }] },
      { text: 'Added bonus.' }, // the gate runs check here and the type error fails it
      { tools: [{ name: 'code.edit', input: { path: 'src/extra.ts', old: 'bonus: string = 1', new: 'bonus: number = 2' } }] },
      { text: 'bonus is 2 and check passes.' },
    ];
    const fake = fakeProvider(script);
    await session(fake, () => 'allow', async (c) => {
      const res = await c.prompt('Add a bonus constant in code');
      expect(res.stopReason).toBe('end_turn');
      expect((res._meta as { checkFailed: boolean }).checkFailed).toBe(false);
      expect(readFileSync(extra, 'utf8')).toBe('export const bonus: number = 2;\n');
      // The type problem came back to the model at file:line:col and the write was kept.
      const seen = JSON.stringify(fake.calls[2]!.messages);
      expect(seen).toContain('src/extra.ts:1:14');
      expect(seen).toContain('TS2322');
      expect(c.seen.asked).toHaveLength(0); // code_edit and code_write do not ask
      const diff = c.seen.updates.filter((u) => u.sessionUpdate === 'tool_call_update').flatMap((u) => (u as { content?: acp.ToolCallContent[] }).content ?? []).find((x) => x.type === 'diff' && x.path.endsWith('src/extra.ts'));
      expect(diff).toBeTruthy();
      expect(toolsStarted(c.seen).filter((t) => t.startsWith('check'))).toEqual(['check (required after edits)', 'check (required after edits)']);
    });
    expect(fake.calls[0]!.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['code_list', 'code_read', 'code_search', 'code_edit', 'code_write', 'code_delete']));
    expect(fake.calls[0]!.system).toContain('code_edit');
    const hist = (await (await import('@hull/tools')).runTool(dir, 'history.list', { limit: 10 })) as { items: { by: string; details?: string[] }[] };
    expect(hist.items.some((i) => i.by === 'ai:Hull agent' && (i.details ?? []).join('\n').includes('src/extra.ts'))).toBe(true);
    // code.delete is risky: it asks, and a refusal leaves the file.
    await session(fakeProvider([{ tools: [{ name: 'code.delete', input: { path: 'src/extra.ts' } }] }, { text: 'Left it.' }]), (r) => (r.toolCall.title?.startsWith('code.delete') ? 'reject' : 'allow'), async (c) => {
      await c.prompt('Remove the bonus file');
      expect(c.seen.asked).toHaveLength(1);
      expect(existsSync(extra)).toBe(true);
    });
    await session(fakeProvider([{ tools: [{ name: 'code.delete', input: { path: 'src/extra.ts' } }] }, { tools: [{ name: 'check' }] }, { text: 'Removed.' }]), () => 'allow', async (c) => {
      await c.prompt('Remove the bonus file');
      expect(c.seen.asked).toHaveLength(1);
      expect(existsSync(extra)).toBe(false);
    });
  }, 180_000);

  it('cannot end a run while check fails, and ends once the model fixes it', async () => {
    const bad = readFileSync(thud(), 'utf8').replace('"level": -5', '"level": "loud"');
    const good = readFileSync(thud(), 'utf8');
    expect(bad).not.toBe(good);
    const script: FakeStep[] = [
      { tools: [{ name: 'config.set', input: { id: 'tuning/arena', pointer: '/crateCount', value: 16 } }] },
      { text: 'All done.' }, // the gate runs check here, and it fails (sound/thud is broken on disk)
      { tools: [{ name: 'config.set', input: { id: 'sound/thud', pointer: '/level', value: -5 } }] },
      { text: 'Fixed the thud level; check passes.' },
    ];
    const fake = fakeProvider(script);
    await session(fake, () => 'allow', async (c) => {
      // The sabotage lands after the first edit is on disk: write it between prompt start and the gate by pre-breaking now.
      writeFileSync(thud(), bad);
      const res = await c.prompt('Tune the arena');
      expect(res.stopReason).toBe('end_turn');
      expect((res._meta as { checkFailed: boolean }).checkFailed).toBe(false);
      expect(toolsStarted(c.seen).filter((t) => t.startsWith('check'))).toEqual(['check (required after edits)', 'check (required after edits)']);
      const failedChecks = c.seen.updates.filter((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'failed');
      expect(failedChecks.length).toBe(1);
    });
    // The model saw the problem text on its third call.
    const third = fake.calls[2]!.messages;
    expect(JSON.stringify(third)).toContain('check failed');
    expect(JSON.stringify(third)).toContain('sound/thud.json');
    expect(readFileSync(thud(), 'utf8')).toBe(good);
  }, 120_000);

  it('gives up after bounded retries and says so', async () => {
    const bad = readFileSync(thud(), 'utf8').replace('"level": -5', '"level": "loud"');
    const good = readFileSync(thud(), 'utf8');
    const script: FakeStep[] = [
      { tools: [{ name: 'config.set', input: { id: 'tuning/arena', pointer: '/crateCount', value: 15 } }] },
      ...Array.from({ length: 6 }, () => ({ text: 'I am done.' })),
    ];
        await session(fakeProvider(script), () => 'allow', async (c) => {
      writeFileSync(thud(), bad);
      const res = await c.prompt('Try');
      expect((res._meta as { checkFailed: boolean }).checkFailed).toBe(true);
      expect(toolsStarted(c.seen).filter((t) => t.startsWith('check')).length).toBe(4); // first gate + 3 fix rounds
      const said = c.seen.updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map((u) => (u as { content: { text: string } }).content.text).join('');
      expect(said).toContain('Stopping: the check still fails');
    });
    writeFileSync(thud(), good);
  }, 180_000);

  it('asks before a destructive step, accepts a denial, and runs it when allowed', async () => {
    const script: FakeStep[] = [
      { tools: [{ name: 'asset.duplicate', input: { id: 'sound/thud', to: 'sound/thud-copy' } }] },
      { tools: [{ name: 'asset.delete', input: { ids: ['sound/thud-copy'] } }] },
      { text: 'The person said no, so I left the copy.' },
    ];
    const fake = fakeProvider(script);
    await session(fake, (r) => (r.toolCall.title?.startsWith('asset.delete') ? 'reject' : 'allow'), async (c) => {
      const res = await c.prompt('Make a copy of the thud sound, then delete the copy');
      expect(res.stopReason).toBe('end_turn');
      expect(c.seen.asked).toHaveLength(1);
      expect(c.seen.asked[0]!.options.map((o) => o.kind)).toEqual(['allow_once', 'allow_always', 'reject_once']);
      expect(existsSync(join(dir, 'config', 'sound', 'thud-copy.json'))).toBe(true); // not deleted
    });
    expect(JSON.stringify(fake.calls[2]!.messages)).toContain('The person denied this step');

    await session(fakeProvider([{ tools: [{ name: 'asset.delete', input: { ids: ['sound/thud-copy'] } }] }, { text: 'Deleted.' }]), () => 'allow', async (c) => {
      await c.prompt('Delete the copy');
      expect(c.seen.asked).toHaveLength(1);
      expect(existsSync(join(dir, 'config', 'sound', 'thud-copy.json'))).toBe(false);
    });
    // A cancelled permission request counts as a refusal and the run reports cancelled.
    await session(fakeProvider([{ tools: [{ name: 'asset.delete', input: { ids: ['sound/thud'] } }] }, { text: 'unreachable' }]), () => 'cancel', async (c) => {
      const res = await c.prompt('Delete thud');
      expect(res.stopReason).toBe('end_turn');
      expect(existsSync(join(dir, 'config', 'sound', 'thud.json'))).toBe(true);
    });
  }, 180_000);

  it('compacts when the conversation outgrows the window and keeps going', async () => {
    const reads: FakeStep[] = Array.from({ length: 7 }, () => ({ tools: [{ name: 'config.read', input: { id: 'tuning/arena' } }, { name: 'config.read', input: { id: 'sound/thud' } }] }));
    const fake = fakeProvider([...reads, { text: 'Read it all.' }], { contextWindow: 2500 });
    await session(fake, () => 'allow', async (c) => {
      const res = await c.prompt('Study the arena and the thud');
      expect(res.stopReason).toBe('end_turn');
      const comp = c.seen.updates.filter((u) => u.sessionUpdate === 'compaction_update') as Extract<acp.SessionUpdate, { sessionUpdate: 'compaction_update' }>[];
      expect(comp.map((u) => u.status)).toEqual(expect.arrayContaining(['in_progress', 'completed']));
      expect(comp.find((u) => u.status === 'completed')?.summary?.[0]).toMatchObject({ type: 'text' });
    });
    // After compaction the model's view starts with the checkpoint.
    expect(JSON.stringify(fake.calls.at(-1)!.messages[0])).toContain('conversation-checkpoint');
  }, 120_000);

  it('stops a run on session/cancel', async () => {
    const hang: Provider = { name: 'hang', model: 'hang', contextWindow: 1000, complete: (req) => new Promise((_, rej) => req.signal.addEventListener('abort', () => rej(new Error('aborted')))) };
    await session(hang, () => 'allow', async (c) => {
      const p = c.prompt('Think forever');
      await new Promise((r) => setTimeout(r, 300));
      await c.cancel();
      expect((await p).stopReason).toBe('cancelled');
    });
  }, 60_000);

  it('answers with set-up help when there is no model', async () => {
    const up = new TransformStream<acp.AnyMessage>();
    const down = new TransformStream<acp.AnyMessage>();
    const agent = startHullAgent({ projectRoot: dir, env: {}, stream: { readable: up.readable, writable: down.writable }, log: () => {} });
    const texts: string[] = [];
    await acp.client({ name: 't' }).onNotification(acp.methods.client.session.update, ({ params }) => { if (params.update.sessionUpdate === 'agent_message_chunk' && params.update.content.type === 'text') texts.push(params.update.content.text); })
      .connectWith({ readable: down.readable, writable: up.writable }, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION });
        const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: dir, mcpServers: [] });
        await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
      });
    agent.close();
    expect(texts.join('')).toContain('ANTHROPIC_API_KEY');
  }, 60_000);
});

describe('hull-agent bin', () => {
  it('speaks ACP over stdio with a scripted model (--fake)', async () => {
    const scriptPath = join(dir, '..', 'fake.json');
    writeFileSync(scriptPath, JSON.stringify([{ tools: [{ name: 'project.info' }] }, { text: 'It is the arena.' }]));
    const bin = join(import.meta.dirname, '..', 'bin', 'hull-agent.js');
    const child = spawn(process.execPath, [bin, dir, '--fake', scriptPath], { stdio: ['pipe', 'pipe', 'inherit'] });
    const stream = acp.ndJsonStream(
      new WritableStream<Uint8Array>({ write: (b) => { child.stdin.write(b); }, close: () => { child.stdin.end(); } }),
      new ReadableStream<Uint8Array>({ start(ctl) { child.stdout.on('data', (b) => ctl.enqueue(new Uint8Array(b))); child.stdout.on('end', () => { try { ctl.close(); } catch { /* already closed */ } }); } }),
    );
    const texts: string[] = [];
    const titles: string[] = [];
    try {
      await acp.client({ name: 't' }).onNotification(acp.methods.client.session.update, ({ params }) => {
        const u = params.update;
        if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') texts.push(u.content.text);
        if (u.sessionUpdate === 'tool_call') titles.push(u.title);
      }).connectWith(stream, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION });
        const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: dir, mcpServers: [] });
        const r = await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'what is this?' }] });
        expect(r.stopReason).toBe('end_turn');
      });
    } finally { child.kill(); }
    expect(titles).toEqual(['project.info']);
    expect(texts.join('')).toBe('It is the arena.');
  }, 60_000);
});
