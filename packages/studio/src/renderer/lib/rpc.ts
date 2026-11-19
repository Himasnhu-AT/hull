// A small typed JSON-RPC 2.0 client for the project protocol (hull/dev/protocol). One WebSocket, calls with
// timeouts, pushes by name, and reconnection with backoff so a restarted server does not need an app restart.

import type { MethodName, Methods, PushName, Pushes } from 'hull/dev/protocol';

export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type Status = 'connecting' | 'open' | 'closed';

export interface RpcOptions {
  /** Defaults to the browser WebSocket. Tests pass a fake. */
  socket?: (url: string) => SocketLike;
  timeoutMs?: number;
  /** Delay before reconnect attempt n (0-based). Return a negative number to stop trying. */
  backoff?: (attempt: number) => number;
}

interface Pending { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout>; method: string }

export class RpcError extends Error {
  readonly method: string;
  readonly code: number | undefined;
  constructor(method: string, message: string, code?: number) {
    super(`${method}: ${message}`);
    this.name = 'RpcError';
    this.method = method;
    this.code = code;
  }
}

type PushFn<K extends PushName> = (params: Pushes[K]) => void;

let nextClientId = 1;

export class RpcClient {
  private ws: SocketLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly queue: string[] = [];
  private readonly pushes = new Map<string, Set<(p: never) => void>>();
  private readonly statusFns = new Set<(s: Status) => void>();
  private attempt = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private current: Status = 'connecting';
  private readonly url: string;
  private readonly opts: RpcOptions;

  constructor(url: string, opts: RpcOptions = {}) {
    this.url = url;
    this.opts = opts;
    this.open();
  }

  /** Distinct per client, so a view can restart cleanly when the client is replaced. */
  readonly id = nextClientId++;

  get status(): Status { return this.current; }

  private setStatus(s: Status): void {
    if (this.current === s) return;
    this.current = s;
    for (const fn of this.statusFns) fn(s);
  }

  private open(): void {
    const make = this.opts.socket ?? ((u: string) => new WebSocket(u) as unknown as SocketLike);
    const ws = make(this.url);
    this.ws = ws;
    this.setStatus('connecting');
    ws.onopen = () => {
      this.attempt = 0;
      this.setStatus('open');
      for (const m of this.queue.splice(0)) ws.send(m);
    };
    ws.onmessage = (ev) => this.receive(String(ev.data));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.failAll('the connection to the project closed');
      this.setStatus('closed');
      this.scheduleReconnect();
    };
    ws.onerror = () => { /* onclose follows; nothing to add */ };
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    const wait = (this.opts.backoff ?? ((n) => Math.min(250 * 2 ** n, 4000)))(this.attempt++);
    if (wait < 0) return;
    this.retry = setTimeout(() => { this.retry = null; if (!this.disposed) this.open(); }, wait);
  }

  private failAll(message: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new RpcError(p.method, message));
      this.pending.delete(id);
    }
    this.queue.length = 0;
  }

  private receive(text: string): void {
    let msg: { id?: number; result?: unknown; error?: { code?: number; message?: string }; method?: string; params?: unknown };
    try { msg = JSON.parse(text); } catch { return; }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcError(p.method, msg.error.message ?? 'failed', msg.error.code));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === 'string') {
      const set = this.pushes.get(msg.method);
      if (set) for (const fn of [...set]) (fn as (p: unknown) => void)(msg.params);
    }
  }

  /** `timeoutMs` overrides the default for one slow call (a build of a big game takes longer than 15 s). */
  call<M extends MethodName>(method: M, params: Methods[M]['params'], o?: { timeoutMs?: number }): Promise<Methods[M]['result']> {
    if (this.disposed) return Promise.reject(new RpcError(method, 'the client is closed'));
    const id = this.nextId++;
    const text = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timeout = o?.timeoutMs ?? this.opts.timeoutMs ?? 15000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(method, `no answer after ${timeout / 1000} s`));
      }, timeout);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
      if (this.current === 'open' && this.ws) this.ws.send(text);
      else this.queue.push(text);
    });
  }

  /** Subscribes to a push. Returns the unsubscribe. */
  on<K extends PushName>(name: K, fn: PushFn<K>): () => void {
    let set = this.pushes.get(name);
    if (!set) this.pushes.set(name, (set = new Set()));
    const f = fn as (p: never) => void;
    set.add(f);
    return () => { set.delete(f); };
  }

  onStatus(fn: (s: Status) => void): () => void {
    this.statusFns.add(fn);
    return () => { this.statusFns.delete(fn); };
  }

  close(): void {
    this.disposed = true;
    if (this.retry) clearTimeout(this.retry);
    this.failAll('the client is closed');
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setStatus('closed');
  }
}

/** Studio clients say who they are in the URL. */
export const studioUrl = (url: string): string => (url.includes('?') ? `${url}&role=studio` : `${url.replace(/\/?$/, '/')}?role=studio`);
