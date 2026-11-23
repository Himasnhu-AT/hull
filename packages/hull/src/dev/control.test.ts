/// <reference types="node" />
// The control port's reading ops against a fake socket: inspect, tree, until, errors, probes, perf, restart, and a throw in a step.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Behaviour, clearProbes, defineGame, probe, startGame } from '../index.ts';
import { createErrorRing } from './errors.ts';
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
}

class Walker extends Behaviour {
  static override state = ['steps', 'mood'];
  steps = 0;
  mood = 'calm';
  speed = 2.123456;
  hidden = { a: 1 };
  override fixedUpdate(): void { this.steps++; if (this.steps === 3) this.node.position.x = 5; }
}
class Bomb extends Behaviour {
  armed = false;
  override fixedUpdate(): void { if (this.armed) throw new Error('boom'); }
}

let id = 0;
const setup = async () => {
  const win: any = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
  win.parent = win;
  vi.stubGlobal('window', win);
  vi.stubGlobal('location', { search: '' });
  vi.stubGlobal('WebSocket', FakeSocket);
  clearProbes();
  const game = await startGame(defineGame({
    ready(g) {
      const p = g.world.spawn('player');
      p.add(Walker);
      p.addTo('heroes');
      g.world.spawn('hat', p);
      g.world.spawn('bomb').add(Bomb);
      probe('steps', () => p.behaviours[0] instanceof Walker ? (p.behaviours[0] as Walker).steps : -1);
      probe('bad', () => { throw new Error('probe broke'); });
    },
  }), { seed: 1 });
  const conn = connectDev(game, { url: 'ws://x' });
  const ws = FakeSocket.last;
  const call = async (control: unknown): Promise<any> => {
    const n = ++id;
    ws.onmessage?.({ data: JSON.stringify({ method: 'game.rpc', params: { id: n, control } }) });
    for (let i = 0; i < 50; i++) {
      const r = ws.sent.find((m) => m.method === 'game.result' && m.params.id === n);
      if (r) return r.params;
      await new Promise((res) => setTimeout(res, 2));
    }
    throw new Error('no answer');
  };
  return { game, conn, ws, call };
};
afterEach(() => { vi.unstubAllGlobals(); });

describe('control port reading ops', () => {
  it('state carries probes and the unread error count; a throwing probe reads as an error string', async () => {
    const s = await setup();
    const r = (await s.call({ op: 'state' })).result;
    expect(r.probes).toEqual({ steps: 0, bad: 'error: probe broke' });
    expect(r.errors).toBe(0);
    s.conn.dispose();
  });

  it('inspect gives transform, groups, children and each behaviour\'s state (listed fields, then plain own fields, rounded)', async () => {
    const s = await setup();
    const r = (await s.call({ op: 'inspect', node: 'player' })).result;
    expect(r).toMatchObject({ found: true, path: 'player', position: [0, 0, 0], scale: [1, 1, 1], groups: ['heroes'], children: ['hat'] });
    expect(r.behaviours).toEqual([{ name: 'Walker', state: { steps: 0, mood: 'calm', speed: 2.1235 } }]);
    expect((await s.call({ op: 'inspect', node: 'nobody' })).result).toEqual({ found: false, path: 'nobody' });
    s.conn.dispose();
  });

  it('tree turns repeated siblings into one line with a count', async () => {
    const s = await setup();
    for (let i = 0; i < 14; i++) s.game.world.spawn('crate').add(Walker);
    s.game.world.spawn('crate');
    const lines = (await s.call({ op: 'tree', depth: 1 })).result.lines as string[];
    expect(lines).toContain('crate x14  [Walker]');
    expect(lines).toContain('crate');
    expect(lines.filter((l) => l.startsWith('crate'))).toHaveLength(2);
    s.conn.dispose();
  });
  it('tree lists paths with behaviour names, cut by depth', async () => {
    const s = await setup();
    expect((await s.call({ op: 'tree' })).result).toEqual({ lines: ['player  [Walker]', 'player/hat', 'bomb  [Bomb]'], more: 0 });
    expect((await s.call({ op: 'tree', depth: 1 })).result.lines).toEqual(['player  [Walker] (+1 below)', 'bomb  [Bomb]']);
    expect((await s.call({ op: 'tree', root: 'player' })).result.lines[0]).toBe('player  [Walker]');
    s.conn.dispose();
  });

  it('until steps one tick at a time and reports met and steps, for fields, behaviour fields and probes', async () => {
    const s = await setup();
    let r = (await s.call({ op: 'until', when: { node: 'player', field: 'x', cmp: '>=', value: 5 }, max: 100 })).result;
    expect(r).toMatchObject({ met: true, steps: 3, tick: 3 });
    r = (await s.call({ op: 'until', when: { node: 'player', field: 'Walker.steps', cmp: '==', value: 10 }, max: 100 })).result;
    expect(r).toMatchObject({ met: true, steps: 7, tick: 10 });
    r = (await s.call({ op: 'until', when: { probe: 'steps', cmp: '>', value: 1000 }, max: 5 })).result;
    expect(r).toMatchObject({ met: false, steps: 5 });
    const bad = await s.call({ op: 'until', when: { node: 'player', field: 'x', cmp: 'near', value: 1 }, max: 5 });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/cmp/);
    s.conn.dispose();
  });

  it('until waits for a trace event', async () => {
    const s = await setup();
    const { trace } = await import('../core/trace.ts');
    s.game.world.after(0.1, () => trace('sound', 'sound/thud'));
    const r = (await s.call({ op: 'until', when: { event: 'sound/thud' }, max: 60 })).result;
    expect(r).toMatchObject({ met: true, steps: 6 });
    s.conn.dispose();
  });

  it('a throw in a step fails with the error text and stack, is kept in the ring, and counts', async () => {
    const s = await setup();
    (s.game.world.find('bomb')!.behaviours[0] as Bomb).armed = true;
    const r = await s.call({ op: 'step', n: 2 });
    expect(r).toMatchObject({ ok: false, error: 'Error: boom', partStepped: true });
    expect(r.stack).toMatch(/at /);
    expect((await s.call({ op: 'state' })).result.errors).toBe(1);
    const errs = (await s.call({ op: 'errors' })).result.items;
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ level: 'error', message: 'Error: boom', count: 1 });
    expect((await s.call({ op: 'state' })).result.errors).toBe(0);
    await s.call({ op: 'step', n: 1 });
    expect((await s.call({ op: 'errors', clear: true })).result.items[0].count).toBe(2);
    expect((await s.call({ op: 'errors' })).result.items).toEqual([]);
    s.conn.dispose();
  });

  it('console.warn and console.error land in the ring, repeats counted, and dispose gives the console back', async () => {
    const before = console.warn;
    const s = await setup();
    expect(console.warn).not.toBe(before);
    const warn = vi.spyOn(console, 'warn');
    console.warn('material/playr does not exist');
    console.warn('material/playr does not exist');
    console.error(new Error('kaput'));
    const items = (await s.call({ op: 'errors' })).result.items;
    expect(items).toMatchObject([{ level: 'warn', message: 'material/playr does not exist', count: 2 }, { level: 'error', message: 'Error: kaput', count: 1 }]);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
    s.conn.dispose();
    expect(console.warn).toBe(before);
  });

  it('restart answers, then restarts through onRestart; look and perf validate their input', async () => {
    const win: any = { addEventListener() {}, removeEventListener() {} };
    win.parent = win;
    vi.stubGlobal('window', win);
    vi.stubGlobal('location', { search: '' });
    vi.stubGlobal('WebSocket', FakeSocket);
    const game = await startGame(defineGame({ ready() {} }), { seed: 1 });
    let restarted = 0;
    const conn = connectDev(game, { url: 'ws://x', onRestart: () => { restarted++; } });
    const ws = FakeSocket.last;
    ws.onmessage?.({ data: JSON.stringify({ method: 'game.rpc', params: { id: 900, control: { op: 'restart' } } }) });
    await new Promise((r) => setTimeout(r, 80));
    expect(restarted).toBe(1);
    expect(ws.sent.find((m) => m.method === 'game.result' && m.params.id === 900)!.params.ok).toBe(true);
    ws.onmessage?.({ data: JSON.stringify({ method: 'game.rpc', params: { id: 901, control: { op: 'perf', steps: 0 } } }) });
    await new Promise((r) => setTimeout(r, 10));
    expect(ws.sent.find((m) => m.method === 'game.result' && m.params.id === 901)!.params.error).toMatch(/steps/);
    conn.dispose();
  });

  it('perf steps and times, then times frames', async () => {
    const s = await setup();
    (s.game.world.find('bomb')!.behaviours[0] as Bomb).armed = false;
    const r = (await s.call({ op: 'perf', steps: 20 })).result;
    expect(r.stepMs.max).toBeGreaterThanOrEqual(r.stepMs.avg);
    expect(r.nodes).toBe(4);
    expect(s.game.world.tick).toBe(20);
    s.conn.dispose();
  });
});

class Body extends Behaviour {
  walk = { vx: 4, vy: 1, vz: -3, grounded: true, coyote: 0.1, stride: 0.5 };
  yaw = 0;
  speed = 2;
  label = 'calm';
  armed = false;
  items = [1, 2];
}

describe('arranging a test: teleport, set and until near (dev only)', () => {
  it('teleport moves the node, turns it, and clears the walker velocity', async () => {
    const s = await setup();
    const p = s.game.world.find('player')!;
    p.add(Body);
    const r = (await s.call({ op: 'teleport', node: 'player', to: [3, 1, -4], yaw: 1.5 })).result;
    expect(r).toMatchObject({ node: 'player', position: [3, 1, -4], yaw: 1.5 });
    expect([p.position.x, p.position.y, p.position.z]).toEqual([3, 1, -4]);
    const b = p.get(Body)!;
    expect([b.walk.vx, b.walk.vy, b.walk.vz]).toEqual([0, 0, 0]);
    expect(b.yaw).toBe(1.5);
    expect(p.rotation.y).toBe(1.5);
    s.conn.dispose();
  });
  it('teleport without a yaw keeps the facing, and a missing node fails naming it', async () => {
    const s = await setup();
    const p = s.game.world.find('player')!;
    p.add(Body).yaw = 0.7;
    await s.call({ op: 'teleport', node: 'player', to: [1, 0, 1] });
    expect(p.get(Body)!.yaw).toBe(0.7);
    const bad = await s.call({ op: 'teleport', node: 'nobody', to: [1, 0, 1] });
    expect(JSON.stringify(bad)).toContain('nobody');
    const bad2 = await s.call({ op: 'teleport', node: 'player', to: [1, 0] });
    expect(JSON.stringify(bad2)).toContain('three numbers');
    s.conn.dispose();
  });
  it('set changes a number, string or boolean field and answers the old and new value', async () => {
    const s = await setup();
    const p = s.game.world.find('player')!;
    p.add(Body);
    expect((await s.call({ op: 'set', node: 'player', field: 'Body.speed', value: 9 })).result).toEqual({ node: 'player', field: 'Body.speed', old: 2, new: 9 });
    expect((await s.call({ op: 'set', node: 'player', field: 'Body.label', value: 'angry' })).result).toMatchObject({ old: 'calm', new: 'angry' });
    expect((await s.call({ op: 'set', node: 'player', field: 'Body.armed', value: true })).result).toMatchObject({ old: false, new: true });
    expect(p.get(Body)!.speed).toBe(9);
    s.conn.dispose();
  });
  it('set refuses an object field, a value of another type and a field that is not there, and changes nothing', async () => {
    const s = await setup();
    const p = s.game.world.find('player')!;
    p.add(Body);
    for (const [field, value, why] of [['Body.items', 5, 'number, string or boolean'], ['Body.speed', 'fast', 'number'], ['Body.nope', 1, 'no field'], ['Nobody.speed', 1, 'behaviour'], ['speed', 1, 'Behaviour']] as const) {
      const r = await s.call({ op: 'set', node: 'player', field, value });
      expect(JSON.stringify(r), field).toContain(why);
    }
    expect(p.get(Body)!.speed).toBe(2);
    expect(p.get(Body)!.items).toEqual([1, 2]);
    s.conn.dispose();
  });
  it('until near holds when the node is within the distance on the floor plane, whatever its height', async () => {
    const s = await setup();
    const p = s.game.world.find('player')!;
    p.position.set(10, 50, 0);
    const near = { node: 'player', near: [10, 3], within: 2 };
    let r = (await s.call({ op: 'until', when: near, max: 5 })).result;
    expect(r).toMatchObject({ met: false, steps: 5 });
    p.position.set(10, 50, 1.5);
    r = (await s.call({ op: 'until', when: near, max: 5 })).result;
    expect(r).toMatchObject({ met: true, steps: 0 });
    s.conn.dispose();
  });
});

describe('the error ring', () => {
  it('unreadItems gives what is new or repeated since the last take, and marks nothing read', () => {
    const r = createErrorRing();
    r.add('error', 'old', undefined, 1, 0.1);
    r.take(false);
    expect(r.unreadItems()).toEqual([]);
    r.add('warn', 'fresh', undefined, 2, 0.2);
    r.add('error', 'old', undefined, 3, 0.3);
    expect(r.unreadItems().map((i) => `${i.message}x${i.count}`)).toEqual(['oldx2', 'freshx1']);
    expect(r.unreadItems()).toHaveLength(2);
    r.take(false);
    expect(r.unreadItems()).toEqual([]);
  });
  it('counts repeats, keeps the newest 50, and carries over a restart', () => {
    const r = createErrorRing();
    for (let i = 0; i < 60; i++) r.add('warn', `w${i}`, undefined, i, i / 60);
    expect(r.peek()).toHaveLength(50);
    r.add('error', 'x', '  at f (a.ts:1:1)\n  at g (b.ts:2:2)', 1, 0.1);
    expect(r.add('error', 'x', '  at f (a.ts:1:1)', 2, 0.2)).toBe(false);
    expect(r.peek().at(-1)).toMatchObject({ message: 'x', count: 2, tick: 2 });
    const copy = createErrorRing();
    copy.load(r.dump());
    expect(copy.peek().at(-1)).toMatchObject({ message: 'x', count: 2 });
    expect(copy.unread()).toBe(0);
  });
});
