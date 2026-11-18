import { describe, expect, it, vi } from 'vitest';
import { RpcClient, RpcError, studioUrl, type SocketLike } from './rpc.ts';

class FakeSocket implements SocketLike {
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  send(d: string): void { this.sent.push(d); }
  close(): void { this.closed = true; this.onclose?.({}); }
  open(): void { this.onopen?.({}); }
  say(o: unknown): void { this.onmessage?.({ data: JSON.stringify(o) }); }
}

function setup(opts: { timeoutMs?: number; backoff?: (n: number) => number } = {}) {
  const sockets: FakeSocket[] = [];
  const client = new RpcClient('ws://x/', { ...opts, socket: () => { const s = new FakeSocket(); sockets.push(s); return s; } });
  return { client, sockets };
}

describe('RpcClient', () => {
  it('queues calls until the socket opens, then answers by id', async () => {
    const { client, sockets } = setup();
    const p = client.call('library.list', {});
    expect(sockets[0]!.sent).toEqual([]);
    sockets[0]!.open();
    const msg = JSON.parse(sockets[0]!.sent[0]!);
    expect(msg).toMatchObject({ jsonrpc: '2.0', method: 'library.list', params: {} });
    sockets[0]!.say({ jsonrpc: '2.0', id: msg.id, result: [{ id: 'a' }] });
    await expect(p).resolves.toEqual([{ id: 'a' }]);
    client.close();
  });

  it('rejects with the method name when the server returns an error', async () => {
    const { client, sockets } = setup();
    sockets[0]!.open();
    const p = client.call('config.read', { id: 'nope' });
    const id = JSON.parse(sockets[0]!.sent[0]!).id;
    sockets[0]!.say({ id, error: { code: -32000, message: 'no such file' } });
    await expect(p).rejects.toMatchObject({ name: 'RpcError', method: 'config.read', code: -32000 });
    await expect(p).rejects.toThrow('config.read: no such file');
    client.close();
  });

  it('delivers pushes by name and stops after unsubscribe', () => {
    const { client, sockets } = setup();
    sockets[0]!.open();
    const fn = vi.fn();
    const off = client.on('log', fn);
    sockets[0]!.say({ method: 'log', params: { level: 'info', message: 'hi', source: 'server' } });
    off();
    sockets[0]!.say({ method: 'log', params: { level: 'info', message: 'again', source: 'server' } });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0]![0]).toMatchObject({ message: 'hi' });
    client.close();
  });

  it('times out a call that is never answered', async () => {
    vi.useFakeTimers();
    const { client, sockets } = setup({ timeoutMs: 100 });
    sockets[0]!.open();
    const p = client.call('project.info', {});
    const assertion = expect(p).rejects.toBeInstanceOf(RpcError);
    await vi.advanceTimersByTimeAsync(150);
    await assertion;
    client.close();
    vi.useRealTimers();
  });

  it('fails in-flight calls on close and reconnects with backoff', async () => {
    vi.useFakeTimers();
    const { client, sockets } = setup({ backoff: () => 50 });
    sockets[0]!.open();
    const statuses: string[] = [];
    client.onStatus((s) => statuses.push(s));
    const p = client.call('project.info', {});
    const assertion = expect(p).rejects.toThrow('closed');
    sockets[0]!.onclose?.({});
    await assertion;
    expect(client.status).toBe('closed');
    await vi.advanceTimersByTimeAsync(60);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(statuses).toEqual(['closed', 'connecting', 'open']);
    client.close();
    vi.useRealTimers();
  });

  it('does not reconnect when told to stop', async () => {
    vi.useFakeTimers();
    const { client, sockets } = setup({ backoff: () => -1 });
    sockets[0]!.open();
    sockets[0]!.onclose?.({});
    await vi.advanceTimersByTimeAsync(10000);
    expect(sockets).toHaveLength(1);
    client.close();
    vi.useRealTimers();
  });

  it('ignores garbage and answers for unknown ids', () => {
    const { client, sockets } = setup();
    sockets[0]!.open();
    expect(() => sockets[0]!.onmessage?.({ data: 'not json' })).not.toThrow();
    expect(() => sockets[0]!.say({ id: 999, result: 1 })).not.toThrow();
    client.close();
  });
});

describe('studioUrl', () => {
  it('adds the role the server expects', () => {
    expect(studioUrl('ws://127.0.0.1:5000')).toBe('ws://127.0.0.1:5000/?role=studio');
    expect(studioUrl('ws://127.0.0.1:5000/')).toBe('ws://127.0.0.1:5000/?role=studio');
    expect(studioUrl('ws://h/?x=1')).toBe('ws://h/?x=1&role=studio');
  });
});
