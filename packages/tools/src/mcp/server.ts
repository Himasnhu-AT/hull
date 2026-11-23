// The MCP server as a library: the tool registry behind JSON-RPC 2.0, so an AI agent reaches the same tools as the Hull app.
// Transport-free here (`createMcpServer`); stdio and streamable HTTP are in transports.ts. Implemented by hand:
// initialize, tools/list, tools/call, ping.
import { randomUUID } from 'node:crypto';
import type { Problem } from 'hull';
import { formatProblem, type ToolDef } from '../tool.ts';
import { validateInput } from '../validate.ts';
import { openProject, type ProjectLink } from '../server/link.ts';
import { tools as baseTools } from '../tools/index.ts';
import { projectTools } from '../tools/project.ts';

export const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
/** Tools that do not make sense behind a protocol call: `dev` never returns, `new` makes a project in a folder. */
const HIDDEN = new Set(['dev', 'new']);

export interface McpOptions {
  tools?: readonly ToolDef<unknown, unknown>[];
  /** The project methods (config.set, game.run, ...). Where a name is in both lists, the method wins: it goes through the server, so the open app hears it. */
  methods?: readonly ToolDef<unknown, unknown>[];
  /** Attaches to the project's server (or starts one in-process), once, on the first tool that needs it. Default: `openProject`. */
  link?: () => Promise<ProjectLink>;
  /** Where diagnostics go (never the protocol stream). */
  log?: (line: string) => void;
  /** Each tool call as it starts and ends, with who made it, so an app can show that an agent is at work. */
  onCall?: (e: { tool: string; author: string; phase: 'start' | 'end'; ok?: boolean }) => void;
}

export interface JsonRpcRequest { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> }
export interface JsonRpcResponse { jsonrpc: '2.0'; id: number | string | null; result?: unknown; error?: { code: number; message: string } }

export interface McpServer {
  projectRoot: string;
  /** Handles one JSON-RPC message. Resolves the response, or undefined for a notification. `session` keeps the client's name for the history. */
  handle(msg: JsonRpcRequest, session?: string): Promise<JsonRpcResponse | undefined>;
  /** Starts a client session (on `initialize`); returns its id. */
  /** `author` names who is on the other end when the transport knows (the x-hull-author header, HULL_MCP_AUTHOR); it wins over the client's own name. */
  newSession(author?: string): string;
  close(): Promise<void>;
}


/** What tools/list says about a tool: its summary, then what it returns when the output schema has a clause for it. */
const describe = (t: ToolDef<unknown, unknown>): string => {
  const ret = (t.output as { description?: unknown } | null)?.description;
  return typeof ret === 'string' && ret ? `${t.summary} Returns: ${ret}` : t.summary;
};

/** The input schema as listed: an empty `required` says nothing, so it is left out. */
const leanSchema = (input: unknown): object => JSON.parse(JSON.stringify(input && typeof input === 'object' ? { type: 'object', ...(input as object) } : { type: 'object' }), (k, v) => (k === 'required' && Array.isArray(v) && v.length === 0 ? undefined : v)) as object;

const DATA_IMAGE = /^data:(image\/[a-z]+);base64,(.+)$/s;

/**
 * Takes the pictures out of a tool's output: a field named png (base64 PNG) or a data:image/...;base64 string. Returns the
 * output with each replaced by "[image]" and the pictures as MCP image blocks, so a client sees a picture, not 30 KB of text.
 */
export function splitImages(v: unknown, images: { type: 'image'; data: string; mimeType: string }[] = []): { value: unknown; images: { type: 'image'; data: string; mimeType: string }[] } {
  const walk = (x: unknown, key?: string): unknown => {
    if (typeof x === 'string') {
      const m = DATA_IMAGE.exec(x);
      if (m) { images.push({ type: 'image', data: m[2]!, mimeType: m[1]! }); return '[image]'; }
      if (key === 'png' && x.length > 0) { images.push({ type: 'image', data: x, mimeType: 'image/png' }); return '[image]'; }
      return x;
    }
    if (Array.isArray(x)) return x.map((y) => walk(y));
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y, k)]));
    return x;
  };
  return { value: walk(v), images };
}

/** The registry as one MCP server for the project at `projectRoot`. */
export function createMcpServer(projectRoot: string, o: McpOptions = {}): McpServer {
  const log = o.log ?? (() => {});
  const methods = o.methods ?? projectTools;
  const methodNames = new Set(methods.map((t) => t.name));
  const tools = [...(o.tools ?? baseTools).filter((t) => !HIDDEN.has(t.name) && !methodNames.has(t.name)), ...methods];
  // These run in the server's process when there is one, so the history is flushed first and their writes are not raced.
  const viaServer = new Set(['check', 'test', 'build', 'package']);
  let linking: Promise<ProjectLink> | undefined;
  const linked = (): Promise<ProjectLink> => (linking ??= (o.link ?? (() => openProject({ root: projectRoot, log })))());
  const authors = new Map<string, string>();
  const pinned = new Set<string>();
  const abort = new AbortController();
  const fail = (id: JsonRpcRequest['id'], code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  const callTool = async (name: string, args: unknown, author: string): Promise<object> => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw Object.assign(new Error(`unknown tool "${name}" (have: ${tools.map((t) => t.name).join(', ')})`), { code: -32602 });
    const note = (phase: 'start' | 'end', ok?: boolean): void => { try { o.onCall?.({ tool: name, author, phase, ...(ok === undefined ? {} : { ok }) }); } catch { /* a listener never breaks a call */ } };
    note('start');
    try {
      const ctx = { root: projectRoot, author, log: (l: string) => log(`[${name}] ${l}`), signal: abort.signal };
      validateInput(name, tool.input, args);
      let out: unknown;
      if (methodNames.has(name) || name === 'play' || viaServer.has(name)) {
        const link = await linked();
        const project = { call: (m: string, p: unknown) => link.call(m, p) };
        if (viaServer.has(name)) out = ((await link.call('tool.call', { name, input: args ?? {} })) as { output: unknown }).output;
        else out = await tool.run({ ...ctx, project, server: { url: link.url, gameUrl: link.gameUrl } }, args ?? {});
      } else out = await tool.run(ctx, args ?? {});
      const problems = (out as { problems?: Problem[] } | null)?.problems ?? [];
      const bad = (out as { ok?: boolean } | null)?.ok === false || problems.length > 0;
      // A document (docs.read) is read as the document, not as a JSON string with its newlines escaped; the object is in structuredContent either way.
      const { value, images } = splitImages(out ?? {});
      const body = tool.plainText && tool.format && !bad ? tool.format(out) : [JSON.stringify(value)];
      const text = [...problems.map(formatProblem), ...body].join('\n');
      note('end', !bad);
      return { content: [{ type: 'text', text }, ...images], structuredContent: value, isError: bad };
    } catch (e) {
      note('end', false);
      // A tool that throws is a failed call the model can read and fix, not a broken connection.
      return { content: [{ type: 'text', text: ((m) => (m.startsWith(`${name}: `) ? m : `${name}: ${m}`))(e instanceof Error ? e.message : String(e)) }], isError: true };
    }
  };

  return {
    projectRoot,
    newSession: (named) => {
      const id = randomUUID();
      const clean = named?.replace(/[\x00-\x1f]/g, '').trim().slice(0, 60);
      authors.set(id, clean ? `ai:${clean}` : 'ai:mcp');
      if (clean) pinned.add(id);
      return id;
    },
    async handle(r, session) {
      const { id, method } = r;
      const isNote = id === undefined;
      const author = (session && authors.get(session)) || 'ai:mcp';
      try {
        switch (method) {
          case 'initialize': {
            const asked = String(r.params?.['protocolVersion'] ?? '');
            const info = r.params?.['clientInfo'] as { name?: string } | undefined;
            if (info?.name && session && !pinned.has(session)) authors.set(session, `ai:${info.name}`);
            return { jsonrpc: '2.0', id: id ?? null, result: {
              protocolVersion: (MCP_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_VERSIONS[0],
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'hull', version: '0.0.0' },
              instructions: 'Hull game project tools. `check` before and after every change; `tunables.list` / `tunables.set` and `config.read` / `config.set` to tune values (recorded under your name, and live in the open app); `game.run` {control:{op:"step",n:60}} then {op:"state",nodes:[...]} to run the game and read it; `history.list` for who changed what; `review.list` for what the person flagged; `brief.read` / `brief.write` for the game brief (GAME.md); `docs.list` / `docs.read` to learn the kits, config formats and engine API; `explain.write` to draw a flowchart, map or table for a rule or layout the person cannot see; `create.get` / `create.set` for the build stages; `game.recent` / `game.moment` for what the game just did; `play` to run a step script and compare screenshots.',
            } };
          }
          case 'ping': return { jsonrpc: '2.0', id: id ?? null, result: {} };
          case 'tools/list':
            return { jsonrpc: '2.0', id: id ?? null, result: { tools: tools.map((t) => ({ name: t.name, description: describe(t), inputSchema: leanSchema(t.input) })) } };
          case 'tools/call': return { jsonrpc: '2.0', id: id ?? null, result: await callTool(String(r.params?.['name'] ?? ''), r.params?.['arguments'], author) };
          default:
            if (isNote) return undefined; // notifications/initialized, notifications/cancelled: nothing to do
            return fail(id, -32601, `method not found: ${String(method)}`);
        }
      } catch (e) {
        return isNote ? undefined : fail(id, (e as { code?: number }).code ?? -32603, e instanceof Error ? e.message : String(e));
      }
    },
    async close() {
      abort.abort();
      await (linking?.then((l) => l.close()) ?? Promise.resolve()).catch(() => {});
    },
  };
}
