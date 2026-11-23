/// <reference types="node" />
// Maintainer script: Hull's own subsystems timed headless in Node at load scales 1, 4 and 16, so a table can say at
// what load each one costs 2 ms of a 16.7 ms frame (plan-rust.md, phase R0). It never ships.
//   node --import tsx scripts/perf-engine.ts [scales, default 1,4,16]
// Prints one JSON line: { scales, benches: [ { name, description, rows: [ { scale, load, msStep, msFrame } ] } ] }.
// msStep is best / median / p95 of the timed calls (milliseconds a step, or a pass of the queries for a query bench).
// msFrame is the cost of one 60 fps frame: 2 fixed steps (the engine steps at 120 Hz), or for a query bench the whole
// query set issued once a frame. Only the engine call sits between the two performance.now() reads, and every random
// input comes from a seeded LCG, so two runs build the same loads and report the same counts.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, defineGame, startGame, type Game } from '../packages/hull/src/index.ts';
import { Body, usePhysics, type Physics } from '../packages/hull/src/physics/index.ts';
import { Animator } from '../packages/hull/src/anim/index.ts';
import { mountVfx, vfx } from '../packages/hull/src/vfx/index.ts';

const HZ = 120;
const scales = (process.argv[2] ?? '1,4,16').split(',').map(Number);

const v = (x: number, y: number, z: number) => ({ x, y, z });
const r4 = (n: number) => Math.round(n * 10000) / 10000;

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

interface Stat { best: number; median: number; p95: number }
function stat(ms: number[]): Stat {
  const s = ms.slice().sort((a, b) => a - b);
  return { best: r4(s[0]!), median: r4(s[Math.floor(s.length / 2)]!), p95: r4(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!) };
}

interface Row { scale: number; load: Record<string, number>; msStep: Stat; msFrame: number }
interface Bench { name: string; description: string; rows: Row[] }

/** msFrame from the median: a step bench pays 2 steps a frame, a query bench pays the whole pass once. */
const row = (scale: number, load: Record<string, number>, ms: number[], perFrame: number): Row => {
  const msStep = stat(ms);
  return { scale, load, msStep, msFrame: r4(msStep.median * perFrame) };
};

function config_(dir: string, kinds: string[]): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const k of kinds) {
    const d = join(dir, k);
    for (const f of readdirSync(d)) out.push({ path: `config/${k}/${f}`, text: readFileSync(join(d, f), 'utf8') });
  }
  return out;
}
const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// ---- physics queries ------------------------------------------------------------------------------------------

async function boxScene(boxes: number, side: number): Promise<{ game: Game; phys: Physics; rnd: () => number }> {
  let phys!: Physics;
  const game = await startGame(defineGame({ ready(g) { phys = usePhysics(g.world); } }), { seed: 1, stepRate: HZ });
  // The same generator as the 1,000 raycasts / 5,000 boxes test in physics.test.ts.
  const rnd = lcg(12345);
  for (let i = 0; i < boxes; i++) {
    const h = 10 + rnd() * 50;
    phys.addBox(v(rnd() * side, h / 2, rnd() * side), v(4 + rnd() * 10, h, 4 + rnd() * 10));
  }
  return { game, phys, rnd };
}

type Query = (phys: Physics, o: { x: number; y: number; z: number }, d: { x: number; y: number; z: number }) => number;

function queryRow(scale: number, phys: Physics, rnd: () => number, side: number, n: number, q: Query, extra: Record<string, number>, reps: number): Row {
  const origins: number[] = [], dirs: number[] = [];
  for (let i = 0; i < n; i++) {
    origins.push(rnd() * side, 20 + rnd() * 60, rnd() * side);
    const a = rnd() * Math.PI * 2, e = (rnd() - 0.6) * 0.8;
    dirs.push(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e));
  }
  const o = v(0, 0, 0), d = v(0, 0, 0);
  let hits = 0;
  const run = () => {
    hits = 0;
    for (let i = 0; i < n; i++) {
      o.x = origins[i * 3]!; o.y = origins[i * 3 + 1]!; o.z = origins[i * 3 + 2]!;
      d.x = dirs[i * 3]!; d.y = dirs[i * 3 + 1]!; d.z = dirs[i * 3 + 2]!;
      hits += q(phys, o, d);
    }
  };
  for (let i = 0; i < Math.max(3, reps >> 1); i++) run();
  const ms: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    run();
    ms.push(performance.now() - t0);
  }
  return row(scale, { ...extra, queries: n, hits }, ms, 1);
}

const ray: Query = (p, o, d) => (p.raycast(o, d, 120) !== null ? 1 : 0);
const sphere: Query = (p, o, d) => (p.spherecast(o, d, 120, 0.5) !== null ? 1 : 0);
const overlap: Query = (p, o) => (p.overlapSphere(o, 3).length > 0 ? 1 : 0);
const queryReps = (scale: number) => Math.max(8, Math.floor(60 / scale));

async function physicsQueries(): Promise<Bench[]> {
  const raycast: Bench = { name: 'physics.raycast', rows: [], description: 'Static boxes (4-14 wide, 10-60 tall) at 5,000 per 800 x 800. Sweep a: 5,000 boxes, 1,000*scale rays. Sweep b: 5,000*scale boxes over side 800*sqrt(scale) (same density), 1,000 rays. msFrame = all the rays issued once a frame; load.sweep 0 is a, 1 is b.' };
  const sph: Bench = { name: 'physics.spherecast', rows: [], description: 'Scene a (5,000 boxes), 1,000*scale spherecasts of radius 0.5, range 120. msFrame = all the casts issued once a frame.' };
  const ovl: Bench = { name: 'physics.overlapSphere', rows: [], description: 'Scene a (5,000 boxes), 1,000*scale overlapSphere calls of radius 3. msFrame = all the calls issued once a frame.' };
  const a = await boxScene(5000, 800);
  for (const scale of scales) {
    const reps = queryReps(scale);
    raycast.rows.push(queryRow(scale, a.phys, lcg(777), 800, 1000 * scale, ray, { sweep: 0, boxes: 5000 }, reps));
    sph.rows.push(queryRow(scale, a.phys, lcg(778), 800, 1000 * scale, sphere, { boxes: 5000 }, reps));
    ovl.rows.push(queryRow(scale, a.phys, lcg(779), 800, 1000 * scale, overlap, { boxes: 5000 }, reps));
  }
  a.game.dispose();
  for (const scale of scales) {
    const side = 800 * Math.sqrt(scale);
    const b = await boxScene(5000 * scale, side);
    raycast.rows.push(queryRow(scale, b.phys, lcg(777), side, 1000, ray, { sweep: 1, boxes: 5000 * scale }, queryReps(scale)));
    b.game.dispose();
  }
  return [raycast, sph, ovl];
}

// ---- rigid bodies ---------------------------------------------------------------------------------------------

async function rigidRun(scale: number, timed: boolean): Promise<{ ms: number[]; awake: number; hash: number }> {
  const count = 100 * scale;
  // A square pit sized so the pile is a few boxes deep, with walls tall enough that nothing climbs out.
  const half = Math.ceil(Math.sqrt(count) * 0.9) + 2;
  const game = await startGame(defineGame({
    ready(g) {
      const p = usePhysics(g.world);
      p.addGround(0);
      p.addBox(v(-half, 4, 0), v(0.5, 8, half * 2));
      p.addBox(v(half, 4, 0), v(0.5, 8, half * 2));
      p.addBox(v(0, 4, -half), v(half * 2, 8, 0.5));
      p.addBox(v(0, 4, half), v(half * 2, 8, 0.5));
      const rnd = lcg(99);
      for (let i = 0; i < count; i++) {
        const n = g.world.spawn(`b${i}`);
        n.position.set((rnd() * 2 - 1) * (half - 1.5), 1 + (i % 12) * 0.9 + rnd() * 0.3, (rnd() * 2 - 1) * (half - 1.5));
        n.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
        if (i % 3 === 0) n.add(Body, { shape: { type: 'sphere', radius: 0.35 }, mass: 1, restitution: 0.4 });
        else n.add(Body, { shape: { type: 'box', size: [0.6 + (i % 4) * 0.1, 0.4, 0.5] }, mass: 2 });
      }
    },
  }), { seed: 7, stepRate: HZ });
  const ms: number[] = [];
  for (let i = 0; i < 600; i++) {
    const t0 = performance.now();
    game.step(1);
    if (timed) ms.push(performance.now() - t0);
  }
  let awake = 0;
  for (let i = 0; i < count; i++) if (!game.world.find(`b${i}`)!.get(Body)!.sleeping) awake++;
  const hash = game.world.checksum() as unknown as number;
  game.dispose();
  return { ms, awake, hash: typeof hash === 'number' ? hash : 0 };
}

async function rigid(): Promise<Bench> {
  const b: Bench = { name: 'physics.rigid', rows: [], description: 'A pile of 100*scale rigid boxes and balls (2 in 3 boxes) dropped into a walled pit; each of the first 600 fixed steps at 120 Hz is timed from step 0, so bodies are still falling and awake. msStep stats are over those 600 steps; msFrame = 2 * median step. load.awakeAtEnd is how many bodies had not slept after step 600.' };
  for (const scale of scales) {
    await rigidRun(scale, false); // JIT warm-up on the same load
    const { ms, awake } = await rigidRun(scale, true);
    b.rows.push(row(scale, { bodies: 100 * scale, steps: 600, awakeAtEnd: awake }, ms, 2));
  }
  return b;
}

// ---- animation ------------------------------------------------------------------------------------------------

async function anim(): Promise<Bench> {
  const b: Bench = { name: 'anim.graph', rows: [], description: '10*scale soldier characters, each with an Animator on the locomotion graph, a speed parameter swept 0 to 10 with a phase per character so states keep blending. Timed after a 240-step warm-up, 240 steps: (1) one fixed step (120 Hz) of the whole world, which only advances graph state; msStep stats are over these. (2) One render() pass over every Animator (the pose, IK and bone writes that update() does each drawn frame; game.step never reaches it headless), load.renderMs is its median. msFrame = 2 * median step + median render pass, the cost of one 60 fps frame.' };
  const res = config.load(config_(src('../packages/hull/src/anim/examples/config'), ['character', 'anim-set', 'anim-graph', 'material']));
  if (res.problems.length) throw new Error('anim config: ' + JSON.stringify(res.problems.slice(0, 2)));
  for (const scale of scales) {
    const n = 10 * scale;
    const anims: Animator[] = [];
    const game = await startGame(defineGame({
      ready(g) { for (let i = 0; i < n; i++) anims.push(g.world.spawn(`c${i}`).add(Animator, { character: 'character/soldier' })); },
    }), { seed: 3, stepRate: HZ });
    const ms: number[] = [], rms: number[] = [];
    for (let i = 0; i < 480; i++) {
      for (let k = 0; k < n; k++) anims[k]!.set('speed', 5 + 5 * Math.sin(i * 0.01 + k));
      const t0 = performance.now();
      game.step(1);
      const t1 = performance.now();
      if (i >= 240) ms.push(t1 - t0);
      if (i % 2 === 0) {
        for (let k = 0; k < n; k++) anims[k]!.render(0.5, 1 / 60);
        if (i >= 240) rms.push(performance.now() - t1);
      }
    }
    // Characters in a state other than idle at the end: a count that must repeat run to run.
    let moving = 0;
    for (const a of anims) if (a.stateOf() !== 'idle') moving++;
    const rr = row(scale, { characters: n, moving, renderMs: stat(rms).median }, ms, 2);
    rr.msFrame = r4(rr.msFrame + stat(rms).median);
    b.rows.push(rr);
    game.dispose();
  }
  return b;
}

// ---- cpu particles --------------------------------------------------------------------------------------------

async function particles(): Promise<Bench> {
  const b: Bench = { name: 'vfx.cpu', rows: [], description: 'The VfxSystem with one CPU emitter (life 1 s, 17*scale particles burst every fixed step at 120 Hz) holding about 2,000*scale live. Burst calls are outside the timing; one fixed step (spawn from the burst, simulate, age) is timed over 240 steps after a 240-step warm-up. msFrame = 2 * median step. load.live is vfx.stats().live at the end.' };
  const res = config.load([
    ...config_(src('../packages/hull/src/vfx/examples/config'), ['look', 'material']),
    { path: 'config/vfx/bench.json', text: JSON.stringify({
      kind: 'vfx', emit: { count: [17, 17] },
      particle: { life: [1, 1], speed: [1, 3], direction: { cone: [0, 1, 0], angleDeg: 60 }, gravity: -1, drag: 0.5, size: [[0, 0.2], [1, 0.4]], color: [[0, '#ffffff'], [1, '#888888']], alpha: [[0, 1], [1, 0]] },
      budget: { max: 100000 },
    }) },
  ]);
  if (res.problems.length) throw new Error('vfx config: ' + JSON.stringify(res.problems.slice(0, 2)));
  for (const scale of scales) {
    const game = await startGame(defineGame({ ready() {} }), { seed: 5, stepRate: HZ });
    mountVfx(game);
    const ms: number[] = [];
    for (let i = 0; i < 480; i++) {
      for (let k = 0; k < scale; k++) vfx.burst('bench', { x: k, y: 0, z: 0 }, undefined, { count: 17 });
      const t0 = performance.now();
      game.step(1);
      if (i >= 240) ms.push(performance.now() - t0);
    }
    const s = vfx.stats();
    b.rows.push(row(scale, { live: s.live, spawned: s.spawned, dropped: s.dropped }, ms, 2));
    game.dispose();
  }
  return b;
}

const benches: Bench[] = [...(await physicsQueries()), await rigid(), await anim(), await particles()];
console.log(JSON.stringify({ scales, benches }));
