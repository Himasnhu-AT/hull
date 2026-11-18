/// <reference types="node" />
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, startGame, type ConfigSource, type Game } from 'hull';
import { InputCore, wireInput, type StepSnapshot } from 'hull/input';
import { beforeAll, describe, expect, it } from 'vitest';
import game from './main.ts';
import { rig, sound } from './rig.ts';
import { Round } from './round.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

function sources(): ConfigSource[] {
  const out: ConfigSource[] = [{ path: 'hull.json', text: readFileSync(join(root, 'hull.json'), 'utf8') }];
  const walk = (dir: string): void => {
    for (const n of readdirSync(dir).sort()) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.json')) out.push({ path: relative(root, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') });
    }
  };
  walk(join(root, 'config'));
  return out;
}

interface Run { checksum: string; moved: number; score: number; sounds: Record<string, number>; recording: StepSnapshot[] }

/** Starts a fresh game with a headless input core in place of the browser's. */
async function start(): Promise<{ g: Game; core: InputCore; log: Record<string, number> }> {
  const log: Record<string, number> = {};
  sound.sink = (id) => { log[id] = (log[id] ?? 0) + 1; };
  const g = await startGame(game, { seed: 11 });
  const core = new InputCore(() => g.world.tick);
  core.setMap(config.get('input-map', 'play'), 'input-map/play');
  wireInput(g, core);
  rig.input = core;
  return { g, core, log };
}

/** A bot that walks toward the nearest gem and hops when it is slowed by a crate. Its inputs are recorded. */
async function botRun(steps: number): Promise<Run> {
  const { g, core, log } = await start();
  const me = g.world.find('player')!;
  const rec = core.record();
  let moved = 0;
  let lx = me.position.x;
  let lz = me.position.z;
  for (let i = 0; i < steps; i++) {
    let best = Infinity;
    let tx = 0;
    let tz = 0;
    for (const n of g.world.root.children) {
      if (!n.name.startsWith('gem')) continue;
      const d = Math.hypot(n.position.x - me.position.x, n.position.z - me.position.z);
      if (d < best) { best = d; tx = n.position.x; tz = n.position.z; }
    }
    const dx = tx - me.position.x;
    const dz = tz - me.position.z;
    const len = Math.hypot(dx, dz) || 1;
    // Hop every half second: it clears low crates and uses the coyote and land code.
    const hop = i % 30 === 0;
    core.play([{ move: { x: dx / len, y: dz / len }, ...(hop ? { jump: { d: 1, p: 1 } } : {}) } as StepSnapshot]);
    g.step(1);
    moved += Math.hypot(me.position.x - lx, me.position.z - lz);
    lx = me.position.x;
    lz = me.position.z;
  }
  const score = g.world.find('round')!.get(Round)!.score;
  const recording = rec.stop();
  const run = { checksum: g.world.checksum(), moved, score, sounds: log, recording };
  g.dispose();
  return run;
}

async function replay(list: StepSnapshot[]): Promise<{ checksum: string; sounds: Record<string, number> }> {
  const { g, core, log } = await start();
  core.play(list);
  g.step(list.length);
  const checksum = g.world.checksum();
  g.dispose();
  return { checksum, sounds: log };
}

describe('arena', () => {
  beforeAll(() => {
    const r = config.load(sources());
    expect(r.problems).toEqual([]);
  });

  it('plays: the player moves, collects gems and makes the sounds; a replay of the recorded input matches', async () => {
    const a = await botRun(600);
    console.log(`arena bot: 600 steps, moved ${a.moved.toFixed(1)} m, score ${a.score}, sounds ${JSON.stringify(a.sounds)}, checksum ${a.checksum}`);
    expect(a.recording).toHaveLength(600);
    expect(a.moved).toBeGreaterThan(10);
    expect(a.score).toBeGreaterThanOrEqual(1);
    expect(a.sounds['sound/pickup']).toBe(a.score);
    expect(a.sounds['sound/footstep']).toBeGreaterThan(5);
    expect(a.sounds['sound/thud']).toBeGreaterThan(0);

    // The recorded input alone reproduces the run, twice.
    const b = await replay(a.recording);
    const c = await replay(a.recording);
    expect(b.checksum).toBe(a.checksum);
    expect(c.checksum).toBe(b.checksum);
    expect(b.sounds).toEqual(a.sounds);
  });

  it('ends the round when the clock runs out, and restarts on jump', async () => {
    const { g, core } = await start();
    const round = g.world.find('round')!.get(Round)!;
    const secs = round.timeLeft;
    g.step(Math.ceil(secs * g.world.stepRate) + 2);
    expect(round.over).toBe(true);
    core.play([{ jump: { d: 1, p: 1 } }]);
    g.step(2);
    expect(round.over).toBe(false);
    expect(round.timeLeft).toBeCloseTo(secs, 1);
    g.dispose();
  });
});
