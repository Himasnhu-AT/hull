/// <reference types="node" />
// Maintainer script: AOTT's Holdout, headless, timed step by step. It is the measure every engine speed change is
// judged by: the same seed and inputs give the same run, so two builds of the engine are compared on identical work.
//   node --import tsx scripts/perf-aott.ts [seconds] [seed]       (add --cpu-prof before --import for a profile)
// Prints one JSON line: ms a step (mean, p50, p95, p99, max) for the whole run and for its last third, where the
// most titans are alive, and the run's checksum, which must not move when a kernel is swapped.
import { config, startGame, type Game } from '../packages/hull/src/index.ts';
import { InputCore, wireInput } from '../packages/hull/src/input/index.ts';
import { projectSources } from '../packages/hull/src/kits/testing.ts';
import { fileURLToPath } from 'node:url';
import def from '../examples/aott/src/main.ts';
import { aottOf, hub } from '../examples/aott/src/host.ts';

const root = fileURLToPath(new URL('../examples/aott/', import.meta.url));
const HZ = 120;
const seconds = Number(process.argv[2] ?? 95);
const seed = Number(process.argv[3] ?? 11);

function stats(ms: Float64Array): Record<string, number> {
  const s = Float64Array.from(ms).sort();
  let sum = 0;
  for (const v of s) sum += v;
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  const r = (v: number) => Math.round(v * 10000) / 10000;
  return { mean: r(sum / s.length), p50: r(at(0.5)), p95: r(at(0.95)), p99: r(at(0.99)), max: r(at(1)) };
}

const problems = config.load(projectSources(root)).problems;
if (problems.length) throw new Error('config: ' + JSON.stringify(problems.slice(0, 3)));

async function run(): Promise<Record<string, unknown>> {
  let g: Game | undefined;
  const core = new InputCore(() => g?.world.tick ?? 0);
  hub.view = core;
  hub.options = { allies: 2 };
  g = await startGame(def, { seed });
  core.setMap(config.lookup('input-map', 'play'), 'input-map/play');
  wireInput(g, core);
  const a = aottOf(g);
  a.flow.start('expedition');
  a.player.reset(a.world.playerSpawn.position.clone(), 0);
  const steps = Math.round(seconds * HZ);
  const ms = new Float64Array(steps);
  let maxTitans = 0;
  for (let i = 0; i < steps; i++) {
    core.play([i % 600 === 200 ? { jump: { d: 1, p: 1 } } : {}]);
    const t0 = performance.now();
    g.step(1);
    ms[i] = performance.now() - t0;
    if (i % HZ === 0) maxTitans = Math.max(maxTitans, a.titans?.titans.length ?? 0);
  }
  const out = {
    seconds, seed, steps, maxTitans, wave: a.flow.wave, checksum: g.world.checksum(),
    all: stats(ms), lastThird: stats(ms.subarray(Math.floor((steps * 2) / 3))),
  };
  g.dispose();
  return out;
}

// The first run warms the JIT; the second is the one reported.
await run();
console.log(JSON.stringify(await run()));
