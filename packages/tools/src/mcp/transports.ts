// MCP transports over one McpServer: newline-delimited JSON-RPC on stdio, and streamable HTTP (a POST per message,
// answered as application/json) bound to loopback. Hand-written, like the server, so the package has no MCP SDK dependency.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import type { JsonRpcRequest, JsonRpcResponse, McpServer } from './server.ts';

/** Serves one client on a pair of streams until the input closes. */
export function serveMcpStdio(server: McpServer, input: Readable, output: Writable, o: { author?: string } = {}): Promise<void> {
  const send = (m: JsonRpcResponse): void => { output.write(`${JSON.stringify(m)}\n`); };
  const session = server.newSession(o.author);
  return new Promise((resolve) => {
    const rl = createInterface({ input });
    const pending = new Set<Promise<void>>();
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let r: JsonRpcRequest;
      try { r = JSON.parse(line) as JsonRpcRequest; } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
      const p = server.handle(r, session).then((res) => { if (res) send(res); }).finally(() => pending.delete(p));
      pending.add(p);
    });
    rl.on('close', () => { void Promise.all(pending).then(async () => { await server.close(); resolve(); }); });
  });
}

export interface McpHttp {
  /** `http://127.0.0.1:<port>/mcp` */
  url: string;
  port: number;
  close(): Promise<void>;
}

export interface McpHttpOptions {
  /** 0 picks a free port. */
  port?: number;
  /** Loopback only: the server can change project files, so it is never offered to the network. */
  host?: '127.0.0.1' | 'localhost' | '::1';
  path?: string;
}

const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

const body = (req: IncomingMessage): Promise<string> => new Promise((res, rej) => {
  const chunks: Buffer[] = []; let n = 0;
  req.on('data', (c: Buffer) => { n += c.length; if (n > 8_000_000) { rej(new Error('body too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
  req.on('error', rej);
});

/** Streamable HTTP, JSON-response form: POST a message (or a batch) to `path`, get the answer back; 202 for notifications. */
export async function startMcpHttp(server: McpServer, o: McpHttpOptions = {}): Promise<McpHttp> {
  const path = o.path ?? '/mcp';
  const host = o.host ?? '127.0.0.1';
  const reply = (res: ServerResponse, status: number, data?: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...headers });
    res.end(data === undefined ? undefined : JSON.stringify(data));
  };
  const http: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== path) return reply(res, 404, { error: 'not found' });
      // A web page must not be able to drive the project through the user's browser (DNS rebinding, cross-site POST).
      const origin = req.headers.origin;
      if (origin && !LOCAL_ORIGIN.test(origin)) return reply(res, 403, { error: 'origin not allowed' });
      if (req.method === 'DELETE') return reply(res, 200);
      if (req.method !== 'POST') return reply(res, 405, { error: 'POST JSON-RPC messages here' }, { allow: 'POST, DELETE' });
      let msgs: JsonRpcRequest[]; let batch = false;
      try {
        const parsed = JSON.parse(await body(req)) as JsonRpcRequest | JsonRpcRequest[];
        batch = Array.isArray(parsed);
        msgs = batch ? (parsed as JsonRpcRequest[]) : [parsed as JsonRpcRequest];
      } catch { return reply(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
      let session = req.headers['mcp-session-id'] as string | undefined;
      const headers: Record<string, string> = {};
      if (msgs.some((m) => m.method === 'initialize')) { session = server.newSession(typeof req.headers['x-hull-author'] === 'string' ? req.headers['x-hull-author'] : undefined); headers['mcp-session-id'] = session; }
      const out = (await Promise.all(msgs.map((m) => server.handle(m, session)))).filter((r): r is JsonRpcResponse => r !== undefined);
      if (out.length === 0) return reply(res, 202, undefined, headers);
      reply(res, 200, batch ? out : out[0], headers);
    })().catch((e: unknown) => { if (!res.headersSent) reply(res, 500, { error: String(e) }); });
  });
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(o.port ?? 0, host, resolve); });
  const port = (http.address() as AddressInfo).port;
  return {
    url: `http://${host === '::1' ? '[::1]' : host}:${port}${path}`,
    port,
    close: () => new Promise<void>((resolve) => { http.closeAllConnections(); http.close(() => resolve()); }),
  };
}
