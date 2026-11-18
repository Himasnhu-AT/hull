// A studio-role client of the project protocol, for tools that run outside the app (play, tests). The app's own
// front end speaks the same protocol; this is the same wire seen from node.
import { WebSocket } from 'ws';
import type { MethodName, Methods } from 'hull/dev/protocol';

export interface ProjectClient {
  call<M extends MethodName>(method: M, params: Methods[M]['params']): Promise<Methods[M]['result']>;
  close(): void;
}

export function connectProject(wsUrl: string, timeoutMs = 60_000): Promise<ProjectClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl}${wsUrl.includes('?') ? '&' : '?'}role=studio`);
    let n = 0;
    const pending = new Map<number, { ok(v: unknown): void; fail(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (msg.id === undefined) return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.fail(new Error(msg.error.message)); else p.ok(msg.result);
    });
    ws.on('close', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.fail(new Error('the project server closed the connection')); } pending.clear(); });
    ws.on('error', reject);
    ws.on('open', () => resolve({
      call: (method, params) => new Promise((ok, fail) => {
        const id = ++n;
        const timer = setTimeout(() => { pending.delete(id); fail(new Error(`${method} timed out after ${timeoutMs} ms`)); }, timeoutMs);
        pending.set(id, { ok: ok as (v: unknown) => void, fail, timer });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      }),
      close: () => ws.close(),
    }));
  });
}
