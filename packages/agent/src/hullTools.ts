// Hull's tools, called in-process through the MCP server object from @hull/tools: the same list, schemas and validation
// the app and every external agent get, and the same history author. The agent has no file tools of its own, so every
// write goes through a validated, recorded Hull edit.
import { createMcpServer, type McpServer } from '@hull/tools/mcp';
import type { ToolSpec } from './types.ts';

/** Tools that change the project. Everything else only reads or runs the game. */
const WRITES = new Set(['config.set', 'tunables.set', 'asset.new', 'asset.duplicate', 'asset.rename', 'asset.move', 'asset.delete', 'folder.new', 'history.restore', 'history.revert', 'exp.adopt']);
/** Writes that are hard to see through or to undo by hand: they ask the person first. */
const RISKY = new Set(['asset.rename', 'asset.move', 'asset.delete', 'history.restore', 'history.revert', 'exp.adopt']);
/** The tools the model is told about: no new/dev (hidden by the MCP server already) and nothing that only the person should do. */
const WITHHELD = new Set(['exp.discard', 'community.open']);

export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'execute' | 'other';

export interface HullToolResult { text: string; ok: boolean; value: unknown; images: { mime: string; data: string }[] }

/** Wire names: Anthropic and OpenAI only allow [a-zA-Z0-9_-], so 'config.set' is sent as 'config_set'. */
export const wireName = (name: string): string => name.replace(/\./g, '_');

export class HullTools {
  readonly specs: ToolSpec[] = [];
  private names = new Map<string, string>();
  private server: McpServer;
  private session: string;
  private id = 0;

  constructor(readonly root: string, opts: { clientName?: string; log?: (l: string) => void } = {}) {
    this.server = createMcpServer(root, { log: opts.log ?? (() => {}) });
    this.session = this.server.newSession();
    this.clientName = opts.clientName ?? 'Hull agent';
  }
  private clientName: string;

  /** Opens the in-process session under the author's name ('ai:Hull agent' in the history) and lists the tools. */
  async open(): Promise<void> {
    await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: this.clientName, version: '0.0.0' } });
    const list = (await this.rpc('tools/list', {})) as { tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] };
    for (const t of list.tools) {
      if (WITHHELD.has(t.name)) continue;
      this.names.set(wireName(t.name), t.name);
      this.specs.push({ name: wireName(t.name), description: t.description, schema: t.inputSchema });
    }
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const r = await this.server.handle({ jsonrpc: '2.0', id: ++this.id, method, params }, this.session);
    if (r?.error) throw new Error(r.error.message);
    return r?.result;
  }

  /** The Hull name for a wire name, or undefined for a tool the model invented. */
  hullName(wire: string): string | undefined { return this.names.get(wire); }
  isWrite(name: string): boolean { return WRITES.has(name); }
  isRisky(name: string): boolean { return RISKY.has(name); }
  kind(name: string): ToolKind {
    if (name === 'asset.delete') return 'delete';
    if (name === 'asset.rename' || name === 'asset.move') return 'move';
    if (WRITES.has(name)) return 'edit';
    if (name === 'check' || name === 'test' || name === 'build' || name === 'play' || name.startsWith('game.')) return 'execute';
    if (/\.(list|read|diff|patch|refs)$/.test(name) || name === 'project.info') return 'read';
    return 'other';
  }

  async call(name: string, input: unknown): Promise<HullToolResult> {
    const res = (await this.rpc('tools/call', { name, arguments: input ?? {} })) as { content: { text: string }[]; structuredContent?: unknown; isError?: boolean };
    const images: { mime: string; data: string }[] = [];
    const value = stripImages(res.structuredContent, images);
    const raw = res.content.map((c) => c.text).join('\n');
    // The server's text repeats the structured JSON; with pictures taken out it is far smaller.
    const text = images.length ? `${JSON.stringify(value, null, 2)}\n(${images.length} image${images.length === 1 ? '' : 's'} attached)` : raw;
    return { text: text.length > 40_000 ? `${text.slice(0, 40_000)}\n... (cut: ${text.length} characters)` : text, ok: !res.isError, value, images };
  }

  async close(): Promise<void> { await this.server.close(); }
}

/** Takes base64 PNG/JPEG strings out of a result so the model gets them as pictures, not as 100 KB of text. */
export function stripImages(v: unknown, out: { mime: string; data: string }[]): unknown {
  if (typeof v === 'string') {
    const m = /^data:(image\/[a-z]+);base64,(.+)$/s.exec(v);
    if (m) { out.push({ mime: m[1]!, data: m[2]! }); return '[image]'; }
    if (v.length > 2000 && (v.startsWith('iVBOR') || v.startsWith('/9j/'))) { out.push({ mime: v.startsWith('iVBOR') ? 'image/png' : 'image/jpeg', data: v }); return '[image]'; }
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => stripImages(x, out));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stripImages(x, out)]));
  return v;
}
