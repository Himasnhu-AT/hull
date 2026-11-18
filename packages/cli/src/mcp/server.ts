// The MCP server: the tool registry over stdio, so an AI agent reaches the same tools as the command line and the app.
// Newline-delimited JSON-RPC 2.0 (the MCP stdio transport). Implemented by hand: initialize, tools/list, tools/call, ping.
import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import type { Problem } from 'hull';
import { formatProblem, type ToolDef } from '../tool.ts';
import type { ProjectLink } from '../server/link.ts';

export const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
/** Tools that do not make sense behind a protocol call: `dev` never returns, `new` makes a project in a folder. */
const HIDDEN = new Set(['dev', 'new']);

export interface McpOptions {
  root: string;
  tools: readonly ToolDef<unknown, unknown>[];
  /** The project methods (config.set, game.run, ...). Where a name is in both lists, the method wins: it goes through the server, so the open app hears it. */
  methods?: readonly ToolDef<unknown, unknown>[];
  /** Attaches to the project's server (or starts one in-process), once, on the first tool that needs it. */
  link?: () => Promise<ProjectLink>;
  input: Readable;
  output: Writable;
  /** Where diagnostics go (never the protocol stream). */
  log?: (line: string) => void;
}

const isObjectSchema = (s: unknown): boolean => typeof s === 'object' && s !== null && (s as { type?: unknown }).type === 'object';

interface Req { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> }

export function serveMcp(o: McpOptions): Promise<void> {
  const log = o.log ?? (() => {});
  const methodNames = new Set((o.methods ?? []).map((t) => t.name));
  const tools = [...o.tools.filter((t) => !HIDDEN.has(t.name) && !methodNames.has(t.name)), ...(o.methods ?? [])];
  // These run in the server's process when there is one, so the history is flushed first and their writes are not raced.
  const viaServer = new Set(['check', 'test', 'build', 'package']);
  let linking: Promise<ProjectLink> | undefined;
  const linked = (): Promise<ProjectLink> => {
    if (!o.link) throw new Error('no project server is available');
    return (linking ??= o.link());
  };
  let author = 'ai:mcp';
  const abort = new AbortController();
  const send = (body: object): void => { o.output.write(`${JSON.stringify({ jsonrpc: '2.0', ...body })}\n`); };
  const fail = (id: Req['id'], code: number, message: string): void => send({ id: id ?? null, error: { code, message } });

  const callTool = async (name: string, args: unknown): Promise<object> => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw Object.assign(new Error(`unknown tool "${name}" (have: ${tools.map((t) => t.name).join(', ')})`), { code: -32602 });
    try {
      const ctx = { root: o.root, author, log: (l: string) => log(`[${name}] ${l}`), signal: abort.signal };
      let out: unknown;
      if (methodNames.has(name) || name === 'play' || viaServer.has(name)) {
        const link = await linked();
        const project = { call: (m: string, p: unknown) => link.call(m, p) };
        if (viaServer.has(name)) out = ((await link.call('tool.call', { name, input: args ?? {} })) as { output: unknown }).output;
        else out = await tool.run({ ...ctx, project, server: { url: link.url, gameUrl: link.gameUrl } }, args ?? {});
      } else out = await tool.run(ctx, args ?? {});
      const problems = (out as { problems?: Problem[] } | null)?.problems ?? [];
      const bad = (out as { ok?: boolean } | null)?.ok === false || problems.length > 0;
      const text = [...problems.map(formatProblem), JSON.stringify(out, null, 2)].join('\n');
      return { content: [{ type: 'text', text }], structuredContent: out ?? {}, isError: bad };
    } catch (e) {
      // A tool that throws is a failed call the model can read and fix, not a broken connection.
      return { content: [{ type: 'text', text: `${name}: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  };

  const handle = async (r: Req): Promise<void> => {
    const { id, method } = r;
    const isNote = id === undefined;
    try {
      switch (method) {
        case 'initialize': {
          const asked = String(r.params?.['protocolVersion'] ?? '');
          const info = r.params?.['clientInfo'] as { name?: string } | undefined;
          if (info?.name) author = `ai:${info.name}`;
          send({ id, result: {
            protocolVersion: (MCP_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'hull', version: '0.0.0' },
            instructions: 'Hull game project tools. `check` before and after every change; `tunables.list` / `tunables.set` and `config.read` / `config.set` to tune values (recorded under your name, and live in the open app); `game.run` {control:{op:"step",n:60}} then {op:"state",nodes:[...]} to run the game and read it; `history.list` for who changed what; `review.list` for what the person flagged; `play` to run a step script and compare screenshots.',
          } });
          return;
        }
        case 'ping': send({ id, result: {} }); return;
        case 'tools/list':
          send({ id, result: { tools: tools.map((t) => ({ name: t.name, description: t.summary, inputSchema: t.input && typeof t.input === 'object' ? { type: 'object', ...(t.input as object) } : { type: 'object' }, ...(isObjectSchema(t.output) ? { outputSchema: t.output } : {}) })) } });
          return;
        case 'tools/call': send({ id, result: await callTool(String(r.params?.['name'] ?? ''), r.params?.['arguments']) }); return;
        default:
          if (isNote) return; // notifications/initialized, notifications/cancelled: nothing to do
          fail(id, -32601, `method not found: ${String(method)}`);
      }
    } catch (e) {
      if (!isNote) fail(id, (e as { code?: number }).code ?? -32603, e instanceof Error ? e.message : String(e));
    }
  };

  return new Promise((resolve) => {
    const rl = createInterface({ input: o.input });
    const pending = new Set<Promise<void>>();
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let r: Req;
      try { r = JSON.parse(line) as Req; } catch { fail(null, -32700, 'parse error'); return; }
      const p = handle(r).finally(() => pending.delete(p));
      pending.add(p);
    });
    rl.on('close', () => { void Promise.all(pending).then(async () => { abort.abort(); await (linking?.then((l) => l.close()) ?? Promise.resolve()).catch(() => {}); resolve(); }); });
  });
}
