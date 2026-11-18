/// <reference types="node" />
import { Vector3 } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { config, defineGame, startGame, type Game } from '../index.ts';
import { createRegistry } from '../config/index.ts';
import type { AnimGraph } from '../schema/anim-graph.ts';
import type { AnimSet } from '../schema/anim-set.ts';
import type { Character } from '../schema/character.ts';
import { Animator, compileCondition, compileClip, evalCurve, Pose, buildBody, twoBone, lookAt, sampleClip, Graph } from './index.ts';
import { exampleSources } from './examples/load.ts';

beforeAll(() => {
  const res = config.load(exampleSources());
  expect(res.problems).toEqual([]);
});

const soldier = (): Character => config.lookup('character', 'soldier') as Character;
const humanoidSet = (): AnimSet => config.lookup('anim-set', 'humanoid') as AnimSet;
const locomotion = (): AnimGraph => config.lookup('anim-graph', 'locomotion') as AnimGraph;

async function start(opts: { rate?: number; graph?: AnimGraph; character?: string | Character } = {}): Promise<{ game: Game; a: Animator }> {
  let a!: Animator;
  const game = await startGame(
    defineGame({
      ready(g) {
        const n = g.world.spawn('hero');
        a = n.add(Animator, { character: opts.character ?? 'character/soldier', ...(opts.graph ? { graph: opts.graph } : {}) });
      },
    }),
    { seed: 3, stepRate: opts.rate ?? 60 },
  );
  return { game, a };
}

describe('examples', () => {
  it('validate against their schemas, with every reference resolved', () => {
    const res = createRegistry().load(exampleSources());
    expect(res.problems).toEqual([]);
    expect(res.ids['character']).toEqual(['soldier', 'titan']);
    expect(res.ids['anim-set']).toEqual(['humanoid']);
    expect(res.ids['anim-graph']).toEqual(['locomotion', 'titan']);
  });

  it('name the place of a mistake in a graph or a clip', () => {
    const reg = createRegistry();
    const bad = JSON.parse(JSON.stringify(locomotion()));
    bad.layers.base.transitions[0].when = 'speed >';
    const res = reg.load([{ path: 'config/anim-graph/bad.json', text: JSON.stringify(bad) }]);
    // The schema accepts any string for `when`; the graph compiler names the place.
    expect(res.problems).toEqual([]);
    const problems: string[] = [];
    const sk = buildBody(soldier().body).skeleton;
    new Graph(bad, new Map(), sk, 'anim-graph/bad#', (m) => problems.push(m));
    expect(problems.some((p) => p.startsWith('anim-graph/bad#/layers/base/transitions/0/when: expected a value at column'))).toBe(true);
    const clipProblems: string[] = [];
    compileClip('x', { type: 'keyframes', length: 1, tracks: { tail: { rotation: [[0, [0, 0, 0]]] } } }, sk, 'anim-set/a#/clips/x', (m) => clipProblems.push(m));
    expect(clipProblems[0]).toContain('anim-set/a#/clips/x/tracks/tail');
  });
});

describe('bones from proportions', () => {
  it('puts the hips at leg height, the head at the top and the shoulders as wide as asked', () => {
    const { skeleton: sk, parts } = buildBody(soldier().body);
    const mq = new Float64Array(sk.n * 4), mp = new Float64Array(sk.n * 3);
    const pose = new Pose(sk.n);
    sk.fk(pose, mq, mp);
    const y = (n: string): number => mp[sk.index(n) * 3 + 1]!;
    const x = (n: string): number => mp[sk.index(n) * 3]!;
    expect(y('hips')).toBeCloseTo(0.52 * 1.78, 6);
    expect(y('head') + 0.23).toBeCloseTo(1.78, 6);
    expect(y('footL') + sk.dims!.footH).toBeCloseTo(y('legL') - sk.dims!.thigh - sk.dims!.shin + sk.dims!.footH, 6);
    expect(y('footL')).toBeCloseTo(sk.dims!.footH, 6);
    expect(x('armR') - x('armL')).toBeGreaterThan(0.3);
    expect(x('armR') - x('armL')).toBeLessThan(0.44);
    expect(x('armR')).toBeGreaterThan(0);
    expect(parts.length).toBeGreaterThan(15);
    expect(sk.names.indexOf('hips')).toBeLessThan(sk.names.indexOf('spine'));
  });

  it('scales a titan from the same generator', () => {
    const t = buildBody(config.lookup('character', 'titan').body);
    const s = buildBody(soldier().body);
    expect(t.skeleton.scale / s.skeleton.scale).toBeCloseTo(15 / 1.78, 6);
    expect(t.skeleton.dims!.height).toBe(15);
    expect(t.skeleton.dims!.legLen).toBeCloseTo(7.5, 6);
    expect(t.skeleton.dims!.head).toBeCloseTo(2.4, 6);
  });

  it('builds a custom skeleton and names a bad bone list', () => {
    const body = { type: 'generated' as const, recipe: 'custom' as const, bones: [{ name: 'root', offset: [0, 1, 0] as [number, number, number] }, { name: 'tail', parent: 'root', offset: [0, 0, 1] as [number, number, number] }], parts: [{ bone: 'tail', shape: 'limb' as const, to: [0, 0, 1] as [number, number, number], radius: 0.1 }] };
    const b = buildBody(body, 'character/dog#/body');
    expect(b.skeleton.names).toEqual(['root', 'tail']);
    expect(() => buildBody({ ...body, bones: [{ name: 'tail', parent: 'root', offset: [0, 0, 1] }] }, 'character/dog#/body')).toThrow('character/dog#/body: bone "tail" names parent "root"');
    expect(() => buildBody({ ...body, parts: [{ bone: 'wing', shape: 'box' }] }, 'character/dog#/body')).toThrow('part names bone "wing"');
  });
});

describe('clips', () => {
  it('passes through keys, is smooth, and wraps a loop', () => {
    const times = Float64Array.from([0, 0.25, 0.5, 0.75]);
    const vals = Float64Array.from([0, 0, 0, 1, 0, 0, 0, 0, 0, -1, 0, 0]);
    const out = new Float64Array(3);
    for (let i = 0; i < 4; i++) {
      evalCurve(times, vals, times[i]!, true, 1, true, out);
      expect(out[0]).toBeCloseTo(vals[i * 3]!, 9);
    }
    // No kink: the slope just before and after a key agree.
    const f = (t: number): number => { evalCurve(times, vals, t, true, 1, true, out); return out[0]!; };
    const e = 1e-5;
    expect((f(0.25) - f(0.25 - e)) / e).toBeCloseTo((f(0.25 + e) - f(0.25)) / e, 2);
    // Wraps from the last key through the end back to the first.
    expect(f(0.9)).toBeLessThan(0);
    expect(f(0.9)).toBeGreaterThan(-1);
    // A loop is continuous across the seam.
    expect(Math.abs(f(0.999999) - f(0))).toBeLessThan(1e-4);
  });

  it('clamps a clip that plays once, and loops a looping one', () => {
    const sk = buildBody(soldier().body).skeleton;
    const set = humanoidSet();
    const slash = compileClip('slash', set.clips['slash']!, sk, 'x', () => {})!;
    const arm = sk.index('armR');
    const end = sampleClip(slash, sk, 0.45);
    const past = sampleClip(slash, sk, 5);
    expect(Array.from(past.rot.slice(arm * 4, arm * 4 + 4))).toEqual(Array.from(end.rot.slice(arm * 4, arm * 4 + 4)));
    expect(sampleClip(slash, sk, 0.14).cov[arm]).toBe(1);
    expect(sampleClip(slash, sk, 0.14).cov[sk.index('legL')]).toBe(0);
    const walk = compileClip('walk', set.clips['walk']!, sk, 'x', () => {})!;
    const a = sampleClip(walk, sk, 0.3), b = sampleClip(walk, sk, 0.3 + walk.length * 3);
    for (let i = 0; i < a.rot.length; i++) expect(b.rot[i]).toBeCloseTo(a.rot[i]!, 9);
    expect(walk.travel).toBeCloseTo(1.44, 6);
  });

  it('scales a gait with the body: a titan takes longer, slower steps', () => {
    const sTit = buildBody(config.lookup('character', 'titan').body).skeleton;
    const w = compileClip('walk', humanoidSet().clips['walk']!, sTit, 'x', () => {})!;
    expect(w.length).toBeCloseTo(Math.sqrt(15 / 1.78), 6);
    expect(w.travel).toBeCloseTo(4.18, 1);
  });
});

describe('events on fixed steps', () => {
  // A graph that only plays one clip, so the expected events are easy to count.
  const only = (clip: string): AnimGraph => ({ kind: 'anim-graph', layers: { base: { start: 's', states: { s: { clip } } } } });

  for (const rate of [30, 60, 120]) {
    it(`misses none and doubles none at ${rate} Hz`, async () => {
      const { game, a } = await start({ rate, graph: only('run') });
      const seen: [string, number][] = [];
      a.events.connect((name) => seen.push([name, game.world.time]));
      game.step(rate * 3);
      // run: 0.56 s cycle, footL at 0.25 and footR at 0.75 of it: 0.14 + 0.56k and 0.42 + 0.56k, up to 3 s.
      const expected: number[] = [];
      for (let k = 0; 0.14 + 0.56 * k <= 3 + 1e-9; k++) expected.push(0.14 + 0.56 * k);
      for (let k = 0; 0.42 + 0.56 * k <= 3 + 1e-9; k++) expected.push(0.42 + 0.56 * k);
      expect(seen.length).toBe(expected.length);
      expect(seen.filter((s) => s[0] === 'footL').length).toBe(6);
      expect(seen.filter((s) => s[0] === 'footR').length).toBe(5);
      // Each event fires on the step that contains its time.
      const dt = 1 / rate;
      const sorted = [...expected].sort((p, q) => p - q);
      seen.forEach(([, t], i) => {
        expect(t).toBeGreaterThanOrEqual(sorted[i]! - 1e-9);
        expect(t - sorted[i]!).toBeLessThan(dt + 1e-9);
      });
      game.dispose();
    });

    it(`fires a one-shot event on exactly the step it is due at ${rate} Hz`, async () => {
      const { game, a } = await start({ rate, graph: only('slash') });
      let at = -1;
      a.events.connect((name) => { if (name === 'hit') at = Math.round(game.world.time * rate); });
      game.step(rate);
      expect(at).toBe(Math.round(0.2 * rate));
      game.dispose();
    });
  }

  it('gives the same events however the same game time is cut into frames', async () => {
    const a1 = await start({ graph: only('run') });
    const a2 = await start({ graph: only('run') });
    const c1: string[] = [], c2: string[] = [];
    a1.a.events.connect((n) => c1.push(n));
    a2.a.events.connect((n) => c2.push(n));
    a1.game.step(180);
    for (let i = 0; i < 180; i++) a2.game.frame(1 / 60);
    expect(c2).toEqual(c1);
    expect(c1.length).toBeGreaterThan(8);
  });
});

describe('graph', () => {
  it('reads conditions', () => {
    const idx = (n: string): number => ['speed', 'grounded', 'go'].indexOf(n);
    const v = Float64Array.from([4, 0, 1]);
    expect(compileCondition('speed > 3.5 && !grounded', idx)(v)).toBe(1);
    expect(compileCondition('speed <= 3 || go', idx)(v)).toBe(1);
    expect(compileCondition('!(speed >= 4) || grounded', idx)(v)).toBe(0);
    expect(compileCondition('speed == 4 && go != 0', idx)(v)).toBe(1);
    expect(() => compileCondition('speed > nope', idx)).toThrow('unknown parameter "nope" at column 9');
    expect(() => compileCondition('speed >', idx)).toThrow('expected a value');
    expect(() => compileCondition('speed $ 3', idx)).toThrow('unexpected "$" at column 7');
  });

  it('crossfades by weight over the blend time, then drops the old state', async () => {
    const { game, a } = await start();
    a.set('speed', 3);
    // idle -> move with blend 0.15 s: 9 steps at 60 Hz.
    game.step(1);
    expect(a.stateOf()).toBe('move');
    expect(a.weights().move).toBeCloseTo(1 / 9, 9);
    expect(a.weights().idle).toBeCloseTo(8 / 9, 9);
    game.step(4);
    expect(a.weights().move).toBeCloseTo(5 / 9, 9);
    game.step(10);
    expect(a.weights()).toEqual({ move: 1 });
    game.dispose();
  });

  it('fades the same way at another step rate', async () => {
    const { game, a } = await start({ rate: 120 });
    a.set('speed', 3);
    game.step(9);
    expect(a.weights().move).toBeCloseTo(9 / 18, 9);
    game.dispose();
  });

  it('blends clips by the parameter and reports foot slide', async () => {
    const { game, a } = await start();
    const g = a.graphRuntime!;
    expect(g.clipWeights('base', 'move')).toEqual({ walk: 1, run: 0 });
    a.set('speed', 3.13);
    expect(g.clipWeights('base', 'move').walk).toBeCloseTo(0.5, 6);
    a.set('speed', 9);
    expect(g.clipWeights('base', 'move')).toEqual({ walk: 0, run: 1 });
    // Playback follows speed within 0.5x to 1.6x of the authored pace; outside that the feet slide.
    expect(g.slideAt('base', 'move', 1.44)).toBeCloseTo(0, 6);
    expect(g.slideAt('base', 'move', 4.82)).toBeCloseTo(0, 6);
    expect(g.slideAt('base', 'move', 3.4)).toBeLessThan(1.2);
    expect(g.slideAt('base', 'move', 0.4)).toBeGreaterThan(0.2);
    expect(g.slideAt('base', 'move', 12)).toBeGreaterThan(2);
    a.set('speed', 4.82);
    game.step(30);
    expect(a.footSlide).toBeLessThan(0.01);
    expect(a.footStride).toBeCloseTo(4.82, 2);
    a.set('speed', 12);
    game.step(2);
    expect(a.footSlide).toBeGreaterThan(2);
    game.dispose();
  });

  it('runs a trigger once, plays a clip once and exits to its state', async () => {
    const { game, a } = await start();
    a.trigger('attack');
    game.step(1);
    expect(a.stateOf('upper')).toBe('slash');
    expect(a.get('attack')).toBe(0);
    game.step(60);
    expect(a.stateOf('upper')).toBe('none');
    expect(a.weights('upper')).toEqual({ none: 1 });
    game.dispose();
  });

  it('goes to the air when not grounded and lands again', async () => {
    const { game, a } = await start();
    a.set('grounded', false);
    game.step(2);
    expect(a.stateOf()).toBe('air');
    a.set('grounded', true);
    game.step(2);
    expect(a.stateOf()).toBe('idle');
    a.trigger('jump');
    game.step(1);
    expect(a.stateOf()).toBe('jump');
    game.step(60);
    expect(a.stateOf()).toBe('idle');
    game.dispose();
  });

  it('reports a bad parameter once and keeps going', async () => {
    const { game, a } = await start();
    a.set('nope', 1);
    a.set('nope', 2);
    expect(a.problems.filter((p) => p.includes('"nope"')).length).toBe(1);
    game.step(3);
    game.dispose();
  });
});

describe('two-bone IK', () => {
  const rig = () => {
    const sk = buildBody(soldier().body).skeleton;
    const pose = new Pose(sk.n);
    pose.setRest();
    const mq = new Float64Array(sk.n * 4), mp = new Float64Array(sk.n * 3);
    sk.fk(pose, mq, mp);
    return { sk, pose, mq, mp, a: sk.index('armR'), b: sk.index('forearmR'), c: sk.index('handR') };
  };
  const dist = (mp: Float64Array, i: number, t: number[]): number => Math.hypot(mp[i * 3]! - t[0]!, mp[i * 3 + 1]! - t[1]!, mp[i * 3 + 2]! - t[2]!);

  it('reaches a point it can reach', () => {
    const { sk, pose, mq, mp, a, b, c } = rig();
    const sh = [mp[a * 3]!, mp[a * 3 + 1]!, mp[a * 3 + 2]!];
    const t = [sh[0]! + 0.1, sh[1]! - 0.1, sh[2]! - 0.45];
    const r = twoBone(sk, pose, mq, mp, a, b, c, t[0]!, t[1]!, t[2]!, mp[b * 3]!, mp[b * 3 + 1]!, mp[b * 3 + 2]! + 1);
    expect(r.reached).toBe(true);
    expect(dist(mp, c, t)).toBeLessThan(1e-6);
    // The pose really changed, and a fresh FK of it agrees with what the solver left behind.
    const mp2 = new Float64Array(mp.length), mq2 = new Float64Array(mq.length);
    sk.fk(pose, mq2, mp2);
    for (let i = 0; i < mp.length; i++) expect(mp2[i]).toBeCloseTo(mp[i]!, 9);
    // Bone lengths are kept.
    expect(Math.hypot(mp[b * 3]! - sh[0]!, mp[b * 3 + 1]! - sh[1]!, mp[b * 3 + 2]! - sh[2]!)).toBeCloseTo(sk.dims!.upperArm, 6);
  });

  it('bends toward the pole', () => {
    for (const side of [1, -1]) {
      const { sk, pose, mq, mp, a, b, c } = rig();
      const t = [mp[a * 3]!, mp[a * 3 + 1]! - 0.1, mp[a * 3 + 2]! - 0.4];
      twoBone(sk, pose, mq, mp, a, b, c, t[0]!, t[1]!, t[2]!, mp[a * 3]! + side * 2, mp[a * 3 + 1]!, mp[a * 3 + 2]!);
      expect(Math.sign(mp[b * 3]! - mp[a * 3]!)).toBe(side);
    }
  });

  it('stretches straight toward a target out of reach, and stops at the length of the limb', () => {
    const { sk, pose, mq, mp, a, b, c } = rig();
    const reach = sk.dims!.upperArm + sk.dims!.foreArm;
    const t = [mp[a * 3]!, mp[a * 3 + 1]!, mp[a * 3 + 2]! - 5];
    const r = twoBone(sk, pose, mq, mp, a, b, c, t[0]!, t[1]!, t[2]!, mp[b * 3]!, mp[b * 3 + 1]!, mp[b * 3 + 2]! + 1);
    expect(r.reached).toBe(false);
    const d = Math.hypot(mp[c * 3]! - mp[a * 3]!, mp[c * 3 + 1]! - mp[a * 3 + 1]!, mp[c * 3 + 2]! - mp[a * 3 + 2]!);
    expect(d).toBeCloseTo(reach, 4);
    expect(mp[c * 3 + 2]!).toBeLessThan(mp[a * 3 + 2]! - reach * 0.99);
  });

  it('folds, but never past the shortest the limb can be, for a target on the shoulder', () => {
    const { sk, pose, mq, mp, a, b, c } = rig();
    const r = twoBone(sk, pose, mq, mp, a, b, c, mp[a * 3]!, mp[a * 3 + 1]!, mp[a * 3 + 2]!, mp[b * 3]!, mp[b * 3 + 1]!, mp[b * 3 + 2]! + 1);
    expect(r.reached).toBe(false);
    for (let i = 0; i < mp.length; i++) expect(Number.isFinite(mp[i])).toBe(true);
  });

  it('turns the head toward a target within its limits', () => {
    const { sk, pose, mq, mp } = rig();
    const chain = Int16Array.from(['chest', 'neck', 'head'].map((n) => sk.index(n)));
    const head = sk.index('head');
    const forward = (): number[] => {
      const o = head * 4;
      const [x, y, z, w] = [mq[o]!, mq[o + 1]!, mq[o + 2]!, mq[o + 3]!];
      // -Z rotated by the quaternion
      return [-2 * (x * z + w * y), -2 * (y * z - w * x), -(1 - 2 * (x * x + y * y))];
    };
    const hy = mp[head * 3 + 1]!;
    lookAt(sk, pose, mq, mp, chain, Float64Array.from([0.3, 0.3, 0.4]), 3, hy, 0, Math.PI, Math.PI / 2, 1);
    expect(forward()[0]).toBeCloseTo(1, 4);
    expect(forward()[2]).toBeCloseTo(0, 4);
    // Behind the body: the head stops at the yaw limit instead of twisting round.
    lookAt(sk, pose, mq, mp, chain, Float64Array.from([0.3, 0.3, 0.4]), 0, hy, 5, 1, 0.5, 1);
    expect(forward()[0]).toBeCloseTo(Math.sin(1), 4);
  });
});

describe('animator', () => {
  it('is deterministic: the same inputs give the same checksum, at any step rate', async () => {
    for (const rate of [30, 60, 120]) {
      const sums: string[] = [];
      for (let run = 0; run < 2; run++) {
        const { game, a } = await start({ rate });
        for (let i = 0; i < rate * 4; i++) {
          if (i === 5) a.set('speed', 4);
          if (i === rate) a.trigger('attack');
          if (i === rate * 2) a.set('speed', 9);
          if (i === rate * 3) a.set('grounded', false);
          game.step(1);
        }
        sums.push(game.world.checksum());
        game.dispose();
      }
      expect(sums[0]).toBe(sums[1]);
    }
  });

  it('puts the animation state in the checksum', async () => {
    const x = await start();
    const y = await start();
    x.game.step(10);
    y.a.set('speed', 4);
    y.game.step(10);
    expect(x.game.world.checksum()).not.toBe(y.game.world.checksum());
  });

  it('poses the bones, and looks different when running', async () => {
    const { game, a } = await start();
    a.render(1, 0.016);
    const idleKnee = a.bone('shinL')!.quaternion.x;
    a.set('speed', 4.82);
    for (let i = 0; i < 40; i++) game.step(1);
    a.render(1, 0.016);
    expect(a.bone('shinL')!.quaternion.x).not.toBeCloseTo(idleKnee, 2);
    game.dispose();
  });

  it('previews a clip at a time and the graph at a set of parameters', async () => {
    const { game, a } = await start();
    expect(a.previewClip('slash', 0.14)).toBe(true);
    const up = a.bone('armR')!.quaternion.clone();
    a.previewClip('slash', 0);
    expect(a.bone('armR')!.quaternion.angleTo(up)).toBeGreaterThan(1.5);
    const before = game.world.checksum();
    game.step(30);
    // A held preview does not run the graph.
    a.stopPreview();
    a.previewGraph({ speed: 9 });
    expect(a.stateOf()).toBe('move');
    expect(a.weights()).toEqual({ move: 1 });
    expect(before).not.toBe('');
    expect(a.previewClip('nope', 0)).toBe(false);
    game.dispose();
  });

  it('places feet on ground that is higher than the floor under the body', async () => {
    const { game, a } = await start();
    const footY = (): number => {
      a.node.object3d.updateWorldMatrix(true, true);
      return a.bone('footL')!.getWorldPosition(new Vector3()).y;
    };
    a.render(1, 1);
    const flat = footY();
    a.ground = () => 0.12;
    a.render(1, 1);
    a.render(1, 1);
    expect(footY() - flat).toBeCloseTo(0.12, 2);
    game.dispose();
  });

  it('reaches a hand to a world point', async () => {
    const { game, a } = await start();
    a.node.position.set(2, 0, 3);
    a.reach('handR', { x: 2.3, y: 1.2, z: 2.6 });
    a.render(1, 0.1);
    a.node.object3d.updateWorldMatrix(true, true);
    const p = a.bone('handR')!.getWorldPosition(new Vector3());
    expect(Math.hypot(p.x - 2.3, p.y - 1.2, p.z - 2.6)).toBeLessThan(1e-3);
    a.reach('handR', null);
    game.dispose();
  });

  it('cuts a limb off into a node of its own', async () => {
    const { game, a } = await start();
    a.node.position.set(5, 0, 0);
    a.set('speed', 3);
    game.step(30);
    const cuts: string[] = [];
    a.cut.connect((b) => cuts.push(b));
    a.render(1, 0.016);
    a.node.object3d.updateWorldMatrix(true, true);
    const before = a.bone('handR')!.getWorldPosition(new Vector3());
    const limb = a.detach('armR')!;
    expect(limb).not.toBeNull();
    expect(limb.parent).toBe(game.world.root);
    expect(cuts).toEqual(['armR']);
    expect(a.bone('armR')).toBeUndefined();
    expect(a.bone('legR')).toBeDefined();
    expect(a.severedBones).toEqual(['armR']);
    // The hand is where it was, now under the cut-off node.
    limb.object3d.updateWorldMatrix(true, true);
    const hand = limb.object3d.getObjectByName('handR')!;
    const after = hand.getWorldPosition(before.clone());
    expect(after.distanceTo(before)).toBeLessThan(1e-6);
    expect(a.detach('armR')).toBeNull();
    // Throwing it is the game's business; here it falls.
    limb.position.y -= 1;
    limb.destroy();
    game.step(2);
    expect(limb.destroyed).toBe(true);
    game.dispose();
  });

  it('rebuilds when its files change, keeping parameters', async () => {
    const { game, a } = await start();
    a.set('speed', 4);
    game.step(30);
    expect(a.stateOf()).toBe('move');
    const original = JSON.stringify(soldier());
    const next = JSON.parse(original);
    next.body.proportions.height = 2.4;
    const res = config.update({ path: 'config/character/soldier.json', text: JSON.stringify(next) });
    expect(res.problems).toEqual([]);
    game.frame(1 / 60);
    expect(a.skeleton.dims!.height).toBeCloseTo(2.4, 6);
    expect(a.get('speed')).toBe(4);
    expect(a.stateOf()).toBe('move');
    config.update({ path: 'config/character/soldier.json', text: original });
    game.frame(1 / 60);
    expect(a.skeleton.dims!.height).toBeCloseTo(1.78, 6);
    game.dispose();
  });

  it('draws nothing but keeps running when its character is missing', async () => {
    const { game, a } = await start({ character: 'character/nobody' });
    expect(a.problems[0]).toContain('character/nobody does not exist');
    game.step(5);
    game.frame(1 / 60);
    game.dispose();
  });
});
