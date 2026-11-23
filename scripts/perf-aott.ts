/// <reference types="node" />
// Maintainer script: AOTT's Holdout, headless, timed step by step. It is the measure every engine speed change is
// judged by: the same seed and inputs give the same run, so two builds of the engine are compared on identical work.
//   node --import tsx scripts/perf-aott.ts [seconds] [seed] [scale] [--profile] [--kernels=on|off|fail]
// Prints one JSON line: ms a step (mean, p50, p95, p99, max) for the whole run and for its last third, where the
// most titans are alive, and the run's checksum, which must not move when a kernel is swapped.
// `scale` (plan-rust.md R0) multiplies titans a wave, comrades and civilians, to find the load at which the frame is
// lost; the checksum of a scaled run is its own. `--profile` runs once more under V8's sampling profiler over the
// last third and adds where the step goes: ms a step per subsystem, and the functions that cost the most.
// `--kernels` starts the game with the WebAssembly kernels on (the default), off, or failing to load; the checksum
// must be the same in all three.
import { config, startGame, type Game } from '../packages/hull/src/index.ts';
import { InputCore, wireInput } from '../packages/hull/src/input/index.ts';
import { kernelStatus } from '../packages/hull/src/kernel/index.ts';
import { projectSources } from '../packages/hull/src/kits/testing.ts';
import { physicsOf } from '../packages/hull/src/physics/index.ts';
import { Session } from 'node:inspector/promises';
import { attribute, type CpuProfile } from './perf-where.ts';
import { fileURLToPath } from 'node:url';
import def from '../examples/aott/src/main.ts';
import { aottOf, hub } from '../examples/aott/src/host.ts';

const root = fileURLToPath(new URL('../examples/aott/', import.meta.url));
const HZ = 120;
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const profile = process.argv.includes('--profile');
const seconds = Number(args[0] ?? 95);
const seed = Number(args[1] ?? 11);
const scale = Number(args[2] ?? 1);
const kernels = (process.argv.find((a) => a.startsWith('--kernels='))?.slice(10) ?? 'on') as 'on' | 'off' | 'fail';

const r4 = (v: number): number => Math.round(v * 10000) / 10000;

function stats(ms: Float64Array): Record<string, number> {
  const s = Float64Array.from(ms).sort();
  let sum = 0;
  for (const v of s) sum += v;
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return { mean: r4(sum / s.length), p50: r4(at(0.5)), p95: r4(at(0.95)), p99: r4(at(0.99)), max: r4(at(1)) };
}

// ---------------------------------------------------------------- the run

const problems = config.load(projectSources(root)).problems;
if (problems.length) throw new Error('config: ' + JSON.stringify(problems.slice(0, 3)));

async function run(withProfile: boolean): Promise<Record<string, unknown>> {
  let g: Game | undefined;
  const core = new InputCore(() => g?.world.tick ?? 0);
  hub.view = core;
  hub.options = { allies: 2, scale };
  g = await startGame(def, { seed, kernels });
  core.setMap(config.lookup('input-map', 'play'), 'input-map/play');
  wireInput(g, core);
  const a = aottOf(g);
  a.flow.start('expedition');
  a.player.reset(a.world.playerSpawn.position.clone(), 0);
  const steps = Math.round(seconds * HZ);
  const lastThird = Math.floor((steps * 2) / 3);
  const ms = new Float64Array(steps);
  const session = withProfile ? new Session() : null;
  let maxTitans = 0;
  for (let i = 0; i < steps; i++) {
    if (session && i === lastThird) {
      session.connect();
      await session.post('Profiler.enable');
      await session.post('Profiler.setSamplingInterval', { interval: 100 });
      await session.post('Profiler.start');
    }
    core.play([i % 600 === 200 ? { jump: { d: 1, p: 1 } } : {}]);
    const t0 = performance.now();
    g.step(1);
    ms[i] = performance.now() - t0;
    if (i % HZ === 0) maxTitans = Math.max(maxTitans, a.titans?.titans.length ?? 0);
  }
  const prof = session ? ((await session.post('Profiler.stop')) as { profile: CpuProfile }).profile : null;
  session?.disconnect();
  const out: Record<string, unknown> = {
    seconds, seed, scale, kernels: kernelStatus().state, physics: physicsOf(g.world).backend, steps, maxTitans, titans: a.titans?.alive.length ?? 0, comrades: a.allies.length,
    civilians: a.civilians?.list.length ?? 0, playerAlive: a.player.alive, wave: a.flow.wave, checksum: g.world.checksum(),
    all: stats(ms), lastThird: stats(ms.subarray(lastThird)),
  };
  if (prof) out.profile = prof;
  g.dispose();
  return out;
}

// The first run warms the JIT; the second is the one reported; the profiled third only says where the second's time went.
await run(false);
const out = await run(false);
if (profile) {
  const p = (await run(true)).profile as CpuProfile;
  Object.assign(out, attribute(p, (out.lastThird as { mean: number }).mean));
}
console.log(JSON.stringify(out));
