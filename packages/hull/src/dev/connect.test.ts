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
