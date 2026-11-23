/// <reference types="node" />
// connectDev against a fake socket: a character built before the studio connected is named when it does, and a pause is
// reported at once.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { config, defineGame, startGame } from '../index.ts';
import { Animator } from '../anim/index.ts';
import { exampleSources } from '../anim/examples/load.ts';
import { connectDev } from './runtime.ts';

class FakeSocket {
  static last: FakeSocket;
  static readonly OPEN = 1;
  readyState = 1;
  sent: { method: string; params: any }[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.last = this; }
  send(s: string): void { this.sent.push(JSON.parse(s)); }
  close(): void { this.readyState = 3; }
  say(method: string, params: unknown): void { this.onmessage?.({ data: JSON.stringify({ method, params }) }); }
}

beforeAll(() => { expect(config.load(exampleSources()).problems).toEqual([]); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('connectDev: the frame', () => {
  const setup = async (embedded: boolean, search = ''): Promise<{ conn: ReturnType<typeof connectDev>; fire(e: Partial<KeyboardEvent>): void; posted: unknown[]; game: Awaited<ReturnType<typeof startGame>> }> => {
    const listeners: ((e: KeyboardEvent) => void)[] = [];
    const posted: unknown[] = [];
    const win: any = { addEventListener: (t: string, f: any) => { if (t === 'keydown') listeners.push(f); }, removeEventListener: (t: string, f: any) => { if (t === 'keydown') listeners.splice(listeners.indexOf(f), 1); } };
    win.parent = embedded ? { postMessage: (m: unknown) => posted.push(m) } : win;
    vi.stubGlobal('window', win);
    vi.stubGlobal('location', { search });
    vi.stubGlobal('WebSocket', FakeSocket);
    const game = await startGame(defineGame({ ready() {} }), { seed: 1, stepRate: 60 });
    const conn = connectDev(game, { url: 'ws://x' });
    return { conn, game, posted, fire: (e) => listeners.slice().forEach((f) => f({ target: {}, ...e } as KeyboardEvent)) };
  };

  it('tells the page around it about N and Escape, and nothing else', async () => {
    const s = await setup(true);
    s.fire({ code: 'KeyN' }); s.fire({ code: 'Escape' }); s.fire({ code: 'KeyM' });
    s.fire({ code: 'KeyN', ctrlKey: true }); s.fire({ code: 'KeyN', target: { tagName: 'INPUT' } as never });
    expect(s.posted).toEqual([{ hull: 'note' }, { hull: 'resume' }]);
    s.conn.dispose(); s.game.dispose();
  });

  it('listens to nothing when the game is not in a frame, and stops on dispose', async () => {
    const alone = await setup(false);
    alone.fire({ code: 'KeyN' });
    expect(alone.posted).toEqual([]);
    alone.conn.dispose(); alone.game.dispose();
    const s = await setup(true);
    s.conn.dispose();
    s.fire({ code: 'KeyN' });
    expect(s.posted).toEqual([]);
    s.game.dispose();
  });

  it('connects under the name the page gives it, and says when it is headless', async () => {
    const a = await setup(true, '?hull-client=app1');
    expect(FakeSocket.last.url).toContain('client=app1');
    expect(FakeSocket.last.url).not.toContain('headless');
    a.conn.dispose(); a.game.dispose();
    const b = await setup(false, '?hull-paused&hull-headless&hull-client=link9');
    expect(FakeSocket.last.url).toContain('client=link9');
    expect(FakeSocket.last.url).toContain('headless=1');
    b.conn.dispose(); b.game.dispose();
  });
});

describe('connectDev', () => {
  it('names the characters already in the game when the studio connects, and reports pause and resume at once', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('location', { search: '' });
    vi.stubGlobal('WebSocket', FakeSocket);
    const game = await startGame(defineGame({ ready(g) { g.world.spawn('hero').add(Animator, { character: 'character/swordswoman' }); } }), { seed: 1, stepRate: 60 });
    game.step(3);
    const conn = connectDev(game, { url: 'ws://x' });
    const ws = FakeSocket.last;
    ws.onopen!();
    vi.advanceTimersByTime(150);
    const events = ws.sent.filter((m) => m.method === 'game.events').flatMap((m) => m.params.items);
    expect(events).toMatchObject([{ kind: 'actor', id: 'character/swordswoman', label: 'Swordswoman', node: 'hero' }]);

    // A second connect (the studio came back) names it again; nothing is sent per frame in between.
    ws.sent.length = 0;
    game.step(10);
    vi.advanceTimersByTime(150);
    expect(ws.sent.filter((m) => m.method === 'game.events')).toEqual([]);
    ws.onopen!();
    vi.advanceTimersByTime(150);
    expect(ws.sent.filter((m) => m.method === 'game.events')).toHaveLength(1);

    ws.sent.length = 0;
    ws.say('game.control', { paused: true });
    expect(game.paused).toBe(true);
    expect(ws.sent.at(-1)).toMatchObject({ method: 'game.report', params: { paused: true } });
    ws.say('game.control', { paused: false });
    expect(game.paused).toBe(false);
    expect(ws.sent.at(-1)).toMatchObject({ method: 'game.report', params: { paused: false } });
    conn.dispose();
    game.dispose();
  });
});
