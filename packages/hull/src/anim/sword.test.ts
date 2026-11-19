/// <reference types="node" />
import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { beforeAll, describe, expect, it } from 'vitest';
import { config, defineGame, startGame, type Game } from '../index.ts';
import type { AnimGraph } from '../schema/anim-graph.ts';
import type { Character } from '../schema/character.ts';
import { Animator, buildBody, compileClip, evalCurve, Graph, Pose, sampleClip } from './index.ts';
import { exampleSources } from './examples/load.ts';

beforeAll(() => {
  expect(config.load(exampleSources()).problems).toEqual([]);
});

async function start(opts: { graph?: AnimGraph; character?: string } = {}): Promise<{ game: Game; a: Animator }> {
  let a!: Animator;
  const game = await startGame(
    defineGame({
      ready(g) {
        const n = g.world.spawn('hero');
        a = n.add(Animator, { character: opts.character ?? 'character/swordswoman', ...(opts.graph ? { graph: opts.graph } : {}) });
      },
    }),
    { seed: 3, stepRate: 60 },
  );
  return { game, a };
}

const sword = (): Character => config.lookup('character', 'swordswoman') as Character;
const sk = () => buildBody(sword().body).skeleton;
const problems = (): string[] => [];

describe('key eases', () => {
  const T = Float64Array.from([0, 1, 2]);
  const V = Float64Array.from([0, 0, 0, 10, 0, 0, 20, 0, 0]);
  const out = new Float64Array(3);
  it('hold stays until the next key, in leaves slowly and arrives fast, out is the reverse', () => {
    const at = (code: number, t: number): number => { evalCurve(T, V, t, false, 2, true, out, Uint8Array.from([code, 0, 0])); return out[0]!; };
    expect(at(7, 0.99)).toBe(0);
    expect(at(2, 0.5)).toBeCloseTo(5, 6);
    expect(at(3, 0.5)).toBeCloseTo(1.25, 6);
    expect(at(4, 0.5)).toBeCloseTo(8.75, 6);
    expect(at(5, 0.5)).toBeCloseTo(5, 6);
    expect(at(6, 0.2)).toBeGreaterThan(6.7);
  });
  it('are named in the file and rejected when misspelled', () => {
    const ok = compileClip('x', { type: 'keyframes', length: 1, tracks: { armR: { rotation: [[0, [0, 0, 0], 'in'], [1, [1, 0, 0]]] } } }, sk(), 'w', problems);
    expect(ok).not.toBeNull();
    const pose = sampleClip(ok!, sk(), 0.5);
    const i = sk().index('armR');
    // 'in' puts a quarter of an eighth of the turn at the midpoint, linear would put half.
    expect(2 * Math.asin(pose.rot[i * 4]!)).toBeCloseTo(0.125, 2);
  });
});

describe('windows', () => {
  it('open and close on the fixed step, readable with inWindow and as events', async () => {
    const { game, a } = await start();
    const log: string[] = [];
    a.windows.connect((name, entering, clip, layer) => log.push(`${game.world.time.toFixed(3)} ${name} ${entering ? 'on' : 'off'} ${clip} ${layer}`));
    a.trigger('light');
    game.step(1);
    expect(a.stateOf()).toBe('light1');
    let during = false;
    for (let i = 0; i < 60; i++) { game.step(1); if (a.inWindow('trace')) during = true; }
    expect(during).toBe(true);
    expect(log.filter((l) => l.includes('trace')).map((l) => l.split(' ').slice(1, 3).join(' '))).toEqual(['trace on', 'trace off']);
    expect(log.some((l) => l.includes('cancel on light1 base'))).toBe(true);
    expect(a.inWindow('nothing')).toBe(false);
  });

  it('are the same on every run', async () => {
    const run = async (): Promise<string> => {
      const { game, a } = await start();
      const log: string[] = [];
      a.windows.connect((n, e, c) => log.push(`${game.world.time.toFixed(4)}${n}${e}${c}`));
      for (let i = 0; i < 600; i++) {
        if (i % 90 === 5) a.trigger(['light', 'light', 'heavy', 'deflect', 'dodge', 'hit'][(i / 90) | 0]!);
        game.step(1);
      }
      return JSON.stringify([log, a.animState]);
    };
    expect(await run()).toBe(await run());
  });

  it('are reported with the place of a mistake', () => {
    const p: string[] = [];
    compileClip('x', { type: 'keyframes', length: 1, windows: { hit: [0.5, 0.4], late: [0.9, 1.4] } }, sk(), 'anim-set/a#/clips/x', (m) => p.push(m));
    expect(p[0]).toContain('anim-set/a#/clips/x/windows/hit: the window ends');
    expect(p[1]).toContain('anim-set/a#/clips/x/windows/late');
  });
});

describe('root motion', () => {
  it('takes the hips travel out of the pose and hands it to the node', async () => {
    const { game, a } = await start();
    const clip = a.clip('light1')!;
    expect(clip.root!.total[2]).toBeCloseTo(-0.4, 3);
    const pose = sampleClip(clip, a.skeleton, 0.32);
    const h = a.skeleton.index('hips');
    expect(pose.off[h * 3]).toBe(0);
    expect(pose.off[h * 3 + 2]).toBe(0);
    expect(pose.off[h * 3 + 1]).toBeLessThan(-0.1);
    a.applyRootMotion = true;
    a.trigger('light');
    let sum = 0;
    for (let i = 0; i < 90; i++) { game.step(1); sum += a.rootMotion[2]!; }
    // A fade in from the ready stance weighs the first moments down a little, so the sum is near, not equal.
    expect(sum).toBeCloseTo(-0.4, 1);
    expect(a.node.position.z).toBeCloseTo(sum, 6);
  });

  it('turns the node when asked and follows its facing', async () => {
    const { game, a } = await start();
    a.node.rotation.y = Math.PI / 2;
    a.applyRootMotion = true;
    a.trigger('light');
    for (let i = 0; i < 90; i++) game.step(1);
    // Forward is -z in the character's frame; turned a quarter circle it is -x.
    expect(a.node.position.x).toBeCloseTo(-0.4, 1);
    expect(Math.abs(a.node.position.z)).toBeLessThan(0.01);
  });
});

describe('blend spaces, fades, layers, time', () => {
  const graph = (extra: Partial<AnimGraph['layers']['base']> = {}, trans: NonNullable<AnimGraph['layers']['base']['transitions']> = []): AnimGraph => ({
    kind: 'anim-graph',
    params: { x: { type: 'number', default: 0 }, y: { type: 'number', default: 0 }, go: { type: 'boolean' }, amt: { type: 'number', default: 1 } },
    layers: {
      base: {
        start: 'a',
        states: {
          a: { blend2d: { x: 'x', y: 'y', points: [{ x: 0, y: 0, clip: 'idle' }, { x: 0, y: 1, clip: 'walk' }, { x: 0, y: -1, clip: 'run' }, { x: 1, y: 0, clip: 'breathe' }] } },
          b: { clip: 'walk' },
        },
        transitions: trans,
        ...extra,
      },
    },
  });
  const hum = (): Character => config.lookup('character', 'soldier') as Character;
  const mk = (g: AnimGraph): Graph => {
    const s = buildBody(hum().body).skeleton;
    const set = config.lookup('anim-set', 'humanoid');
    const clips = new Map();
    for (const [n, d] of Object.entries(set.clips)) clips.set(n, compileClip(n, d, s, 'w', problems));
    const p: string[] = [];
    const gr = new Graph(g, clips, s, 'g#', (m) => p.push(m));
    expect(p).toEqual([]);
    return gr;
  };

  it('weights a 2D space by inverse distance and lands exactly on a point', () => {
    const g = mk(graph());
    g.setParam(g.paramIndexOf('y'), 1);
    expect(g.clipWeights('base', 'a')['walk']).toBe(1);
    g.setParam(g.paramIndexOf('y'), 0.5);
    const w = g.clipWeights('base', 'a');
    expect(w['idle']! + w['walk']!).toBeGreaterThan(0.9);
    expect(w['idle']).toBeCloseTo(w['walk']!, 6);
    g.setParam(g.paramIndexOf('x'), 0.9);
    g.setParam(g.paramIndexOf('y'), 0);
    expect(g.clipWeights('base', 'a')['breathe']).toBeGreaterThan(0.9);
    expect(Object.values(g.clipWeights('base', 'a')).reduce((s, v) => s + v, 0)).toBeCloseTo(1, 9);
  });

  it('starts a synced fade at the phase of the state it leaves', () => {
    const g = mk(graph({}, [{ from: 'a', to: 'b', when: 'go', blend: 0.2, sync: true }]));
    for (let i = 0; i < 20; i++) g.step(1 / 60, null);
    const before = g.layers[0]!.entries[0]!.t;
    g.setParam(g.paramIndexOf('go'), 1);
    g.step(1 / 60, null);
    const e = g.layers[0]!.entries[1]!;
    expect(g.layers[0]!.count).toBe(2);
    expect(e.t).toBeGreaterThan(0);
    expect(e.t / g.layers[0]!.states[1]!.clips[0]!.length).toBeGreaterThan(before - 0.1);
  });

  it('scales a layer by a parameter', () => {
    const g = mk(graph({ weightFrom: 'amt', weight: 0.8 }));
    const out = new Pose(g.skeleton.n);
    g.setParam(g.paramIndexOf('amt'), 0);
    g.evaluate(1, out);
    const rest = new Pose(g.skeleton.n); rest.setRest();
    expect(Array.from(out.rot)).toEqual(Array.from(rest.rot));
  });

  it('holds the animation in a hit-stop and in a time scale of 0, and buffers a trigger', async () => {
    const { game, a } = await start();
    a.trigger('light');
    game.step(10);
    const snap = JSON.stringify(a.animState[0]);
    a.hitStop(0.2);
    game.step(6);
    expect(JSON.stringify(a.animState[0])).toBe(snap);
    game.step(12);
    expect(JSON.stringify(a.animState[0])).not.toBe(snap);
    a.timeScale = 0;
    const layers = (): string => JSON.stringify((a.animState[0] as unknown[]).slice(1));
    const s2 = layers();
    a.trigger('deflect');
    game.step(10);
    expect(layers()).toBe(s2);
    a.timeScale = 1;
    game.step(2);
    expect(a.stateOf()).toBe('deflect');
  });
});

describe('grips, springs and flinches', () => {
  const worldOf = (a: Animator, n: string) => { a.node.object3d.updateWorldMatrix(true, true); return a.bone(n)!.getWorldPosition(new (a.bone(n)!.position.constructor as new () => import('three').Vector3)()); };

  it('puts the off-hand on the hilt whatever the clip does', async () => {
    const { game, a } = await start();
    a.trigger('heavy');
    for (let k = 0; k < 4; k++) {
      game.step(20);
      a.render(1, 0);
      a.node.object3d.updateWorldMatrix(true, true);
      const hand = worldOf(a, 'handL');
      const hilt = a.socket('hiltL')!.getWorldPosition(hand.clone());
      expect(hand.distanceTo(hilt)).toBeLessThan(0.06);
    }
  });

  it('swings a chain from the body moving, and settles when it stops', async () => {
    const { game, a } = await start();
    const q = (): number => Math.abs(a.bone('pony2')!.quaternion.x) + Math.abs(a.bone('pony2')!.quaternion.z);
    for (let i = 0; i < 60; i++) { game.step(1); a.render(1, 1 / 60); }
    const rest = q();
    for (let i = 0; i < 20; i++) { a.node.position.x += 0.12; game.step(1); a.render(1, 1 / 60); }
    for (let i = 0; i < 6; i++) { a.node.position.x += 0.0; game.step(1); a.render(1, 1 / 60); }
    expect(q()).toBeGreaterThan(rest + 0.02);
    for (let i = 0; i < 240; i++) { game.step(1); a.render(1, 1 / 60); }
    expect(q()).toBeLessThan(rest + 0.01);
  });

  it('leans away from a blow and springs back', async () => {
    const { game, a } = await start();
    game.step(5); a.render(1, 1 / 60);
    const chest = a.bone('chest')!;
    const r0 = chest.quaternion.clone();
    a.hitReact({ x: 0, y: 0, z: 1 }, 1);
    let worst = 0;
    for (let i = 0; i < 12; i++) { a.render(1, 1 / 60); worst = Math.max(worst, chest.quaternion.angleTo(r0)); }
    expect(worst).toBeGreaterThan(0.05);
    for (let i = 0; i < 120; i++) a.render(1, 1 / 60);
    expect(chest.quaternion.angleTo(r0)).toBeLessThan(0.01);
  });

  it('names a grip on a socket that does not exist', async () => {
    const g = JSON.parse(JSON.stringify(config.lookup('anim-graph', 'sword'))) as AnimGraph;
    g.ik!.grips!['handL']!.socket = 'nope';
    const { a } = await start({ graph: g });
    expect(a.problems.some((p) => p.includes('anim-graph#/ik/grips/handL/socket'))).toBe(true);
  });
});

describe('the sword set', () => {
  it('has every move, with a trace window on each attack and an iframe window on the dodge', () => {
    const set = config.lookup('anim-set', 'sword');
    for (const n of ['draw', 'light1', 'light2', 'light3', 'heavy', 'deflect', 'dodge', 'hit_react']) expect(set.clips[n], n).toBeDefined();
    for (const n of ['draw', 'light1', 'light2', 'light3', 'heavy']) expect(set.clips[n]!.windows!['trace'], n).toBeDefined();
    expect(set.clips['dodge']!.windows!['iframe']).toBeDefined();
    expect(set.clips['deflect']!.windows!['parry']).toBeDefined();
  });

  it('samples to the same numbers every time, and the blade is where the strike says', () => {
    const s = sk();
    const p: string[] = [];
    const set = config.lookup('anim-set', 'sword');
    const hash = (): number[] => {
      const out: number[] = [];
      for (const [n, d] of Object.entries(set.clips)) {
        const c = compileClip(n, d, s, 'w', (m) => p.push(m))!;
        for (let k = 0; k <= 8; k++) out.push(...sampleClip(c, s, (k / 8) * c.length).rot);
      }
      return out;
    };
    const a1 = hash(), a2 = hash();
    expect(p).toEqual([]);
    expect(a1).toEqual(a2);
    // Light 1 at the strike: the right hand is out in front of the body and above the belt, the blade points forward.
    const c = compileClip('light1', set.clips['light1']!, s, 'w', problems)!;
    const pose = sampleClip(c, s, 0.24);
    const mq = new Float64Array(s.n * 4), mp = new Float64Array(s.n * 3);
    s.fk(pose, mq, mp);
    const hand = s.index('handR');
    expect(mp[hand * 3 + 2]).toBeLessThan(-0.35);
    expect(mp[hand * 3 + 1]).toBeGreaterThan(1.0);
  });

  it('allocates nothing per step or per frame', async () => {
    const { game, a } = await start();
    a.applyRootMotion = true;
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const go = (n: number): void => {
      for (let i = 0; i < n; i++) {
        if (i % 50 === 0) a.trigger(['light', 'heavy', 'deflect', 'dodge', 'hit'][(i / 50) % 5 | 0]!);
        if (i % 97 === 0) a.hitReact({ x: 1, y: 0, z: 0.3 }, 0.7);
        game.step(1);
        a.node.position.set(0, 0, 0);
        a.render(0.5, 1 / 60);
      }
    };
    go(600);
    gc(); gc();
    const before = process.memoryUsage().heapUsed;
    go(6000);
    gc(); gc();
    const grew = process.memoryUsage().heapUsed - before;
    expect(grew).toBeLessThan(400_000);
  });
});
