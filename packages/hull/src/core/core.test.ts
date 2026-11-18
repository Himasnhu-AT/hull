import { describe, expect, it } from 'vitest';
import { Behaviour, defineGame, signal, startGame, scratch, World } from './index.ts';
import type { Game } from './index.ts';

declare module './index.ts' {
  interface HullEvents {
    ping: number;
  }
}

class Spin extends Behaviour {
  static override state = ['angle', 'hits'];
  angle = 0;
  hits = 0;
  speed = 1;
  override fixedUpdate(dt: number): void {
    this.angle += this.speed * dt;
    this.node.rotation.y = this.angle;
    const v = scratch.v3();
    v.set(this.angle, 0, 0);
    this.node.position.x = Math.sin(v.x);
    if (this.world.random('gameplay').chance(0.01)) this.hits++;
    this.world.random('cosmetic').next();
  }
}

const cube = defineGame({
  ready(game) {
    for (let i = 0; i < 3; i++) game.world.spawn(`cube${i}`).add(Spin, { speed: 1 + i });
  },
});

async function run(seed: number, steps: number): Promise<string> {
  const g = await startGame(cube, { seed });
  g.step(steps);
  return g.world.checksum();
}

describe('determinism', () => {
  it('10,000 steps twice from one seed agree, in under a second', async () => {
    const t0 = performance.now();
    const a = await run(7, 10_000);
    const b = await run(7, 10_000);
    const ms = performance.now() - t0;
    console.log(`10k steps x2: ${ms.toFixed(1)} ms`);
    expect(a).toBe(b);
    expect(ms).toBeLessThan(1000);
  });

  it('a different seed gives a different checksum', async () => {
    expect(await run(7, 500)).not.toBe(await run(8, 500));
  });

  it('the cosmetic stream is left out of the checksum', async () => {
    const g1 = await startGame(defineGame({ ready() {} }), { seed: 3 });
    const g2 = await startGame(defineGame({ ready() {} }), { seed: 3 });
    g1.world.random('cosmetic').next();
    expect(g1.world.checksum()).toBe(g2.world.checksum());
    g1.world.random('gameplay').next();
    expect(g1.world.checksum()).not.toBe(g2.world.checksum());
  });
});

describe('random', () => {
  it('a new stream does not change an existing one', () => {
    const a = new World({ seed: 5 });
    const b = new World({ seed: 5 });
    const xs = [a.random('loot').next(), a.random('loot').next()];
    b.random('other').next();
    const ys = [b.random('loot').next(), b.random('loot').next()];
    expect(ys).toEqual(xs);
    expect(a.random('x').next()).not.toBe(a.random('y').next());
  });

  it('int is inclusive and pick stays inside the list', () => {
    const r = new World({ seed: 1 }).random('t');
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(r.int(1, 3));
    expect([...seen].sort()).toEqual([1, 2, 3]);
    expect(['a', 'b']).toContain(r.pick(['a', 'b']));
  });
});

describe('timers', () => {
  it('after fires once at the right step, every repeats, cancel stops', async () => {
    const g = await startGame(defineGame({ ready() {} }), { stepRate: 60 });
    const w = g.world;
    const log: string[] = [];
    w.after(0.5, () => log.push(`after@${w.tick}`));
    const ev = w.every(0.25, () => log.push(`every@${w.tick}`));
    const c = w.after(0.1, () => log.push('cancelled'));
    c.cancel();
    expect(c.active).toBe(false);
    g.step(14);
    expect(log).toEqual([]);
    g.step(1);
    expect(log).toEqual(['every@15']);
    g.step(15);
    expect(log).toEqual(['every@15', 'after@30', 'every@30']);
    ev.cancel();
    g.step(60);
    expect(log.length).toBe(3);
    expect(ev.active).toBe(false);
  });

  it('a timer made inside a timer waits for a later step', async () => {
    const g = await startGame(defineGame({ ready() {} }));
    const log: number[] = [];
    g.world.after(0.01, () => g.world.after(0, () => log.push(g.world.tick)));
    g.step(1);
    expect(log).toEqual([]);
    g.step(1);
    expect(log).toEqual([2]);
  });
});

describe('destroy', () => {
  it('is deferred, and cleans groups, behaviours, signals and events', async () => {
    const g = await startGame(defineGame({ ready() {} }));
    const w = g.world;
    const log: string[] = [];
    class Tracked extends Behaviour {
      died = signal<[number]>();
      override dispose(): void {
        log.push('dispose');
      }
    }
    const a = w.spawn('a').addTo('enemies');
    const child = w.spawn('kid', a).addTo('enemies');
    const t = a.add(Tracked);
    const other = w.spawn('other');
    const sig = signal<[number]>();
    sig.connect((n) => log.push(`sig${n}`), a);
    sig.connect((n) => log.push(`free${n}`), other);
    w.events.on('ping', (n) => log.push(`ev${n}`), a);

    a.destroy();
    expect(a.destroyed).toBe(false);
    expect(w.group('enemies')).toEqual([a, child]);
    sig.emit(1);
    w.events.emit('ping', 1);
    expect(log).toEqual(['sig1', 'free1', 'ev1']);

    g.step(1);
    expect(a.destroyed).toBe(true);
    expect(child.destroyed).toBe(true);
    expect(w.group('enemies').length).toBe(0);
    expect(w.root.children).toEqual([other]);
    expect(w.find('a')).toBeUndefined();
    expect(a.object3d.parent).toBeNull();
    expect(log.slice(3)).toEqual(['dispose']);
    sig.emit(2);
    w.events.emit('ping', 2);
    expect(log.slice(4)).toEqual(['free2']);
    expect(t.died).toBeDefined();
  });

  it('a behaviour destroying its node still lets the step finish', async () => {
    const g = await startGame(defineGame({ ready() {} }));
    let ran = 0;
    class Suicide extends Behaviour {
      override fixedUpdate(): void {
        ran++;
        this.node.destroy();
      }
    }
    g.world.spawn('s').add(Suicide);
    g.world.spawn('s2').add(Suicide);
    g.step(3);
    expect(ran).toBe(2);
  });
});

describe('behaviours and systems', () => {
  it('add assigns init then calls ready; order is behaviours then systems; idle behaviours cost nothing', async () => {
    const g = await startGame(defineGame({ ready() {} }));
    const log: string[] = [];
    class A extends Behaviour {
      v = 0;
      override ready(): void {
        log.push(`ready${this.v}`);
      }
      override fixedUpdate(): void {
        log.push('A');
      }
    }
    class Idle extends Behaviour {}
    g.world.system('s1', { fixedUpdate: () => log.push('s1') });
    g.world.system('s2', { fixedUpdate: () => log.push('s2') });
    const n = g.world.spawn();
    n.add(A, { v: 9 });
    n.add(Idle);
    expect(n.get(Idle)).toBeInstanceOf(Idle);
    g.step(1);
    expect(log).toEqual(['ready9', 'A', 's1', 's2']);
  });
});

describe('frame', () => {
  it('runs whole steps from an accumulator, scaled and clamped', async () => {
    const g: Game = await startGame(defineGame({ ready() {} }), { stepRate: 60 });
    const alphas: number[] = [];
    const off = g.onFrame((a) => alphas.push(a));
    g.frame(1 / 60);
    expect(g.world.tick).toBe(1);
    g.frame(0.025);
    expect(g.world.tick).toBe(2);
    expect(alphas[1]).toBeCloseTo(0.5, 5);
    g.timeScale = 2;
    g.frame(1 / 60);
    expect(g.world.tick).toBe(4);
    g.timeScale = 1;
    g.frame(10);
    expect(g.world.tick).toBe(4 + 15);
    g.paused = true;
    g.frame(1);
    expect(g.world.tick).toBe(19);
    expect(alphas.length).toBe(4);
    off();
    g.paused = false;
    g.frame(1 / 60);
    expect(alphas.length).toBe(4);
  });

  it('sixty frames of 1/60 s make sixty steps', async () => {
    const g = await startGame(defineGame({ ready() {} }));
    for (let i = 0; i < 60; i++) g.frame(1 / 60);
    expect(g.world.tick).toBe(60);
    expect(g.world.time).toBeCloseTo(1, 12);
  });
});

describe('find', () => {
  it('walks a path of names', async () => {
    const g = await startGame(defineGame({ ready() {} }));
    const squad = g.world.spawn('squad');
    const ana = g.world.spawn('ana', squad);
    expect(g.world.find('squad')).toBe(squad);
    expect(g.world.find('squad/ana')).toBe(ana);
    expect(g.world.find('squad/bo')).toBeUndefined();
    expect(g.world.find('ana')).toBeUndefined();
    expect(ana.object3d.parent).toBe(squad.object3d);
    expect(squad.object3d.parent).toBe(g.world.root.object3d);
  });
});

describe('signal', () => {
  it('unsubscribe works, also during emit', () => {
    const s = signal<[number]>();
    const log: number[] = [];
    let off: () => void = () => {};
    off = s.connect((n) => {
      log.push(n);
      off();
    });
    s.connect((n) => log.push(n * 10));
    s.emit(1);
    s.emit(2);
    expect(log).toEqual([1, 10, 20]);
  });
});
