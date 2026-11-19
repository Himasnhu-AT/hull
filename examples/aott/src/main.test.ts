/// <reference types="node" />
// Holdout, headless: the whole game on the Hull loop in Node, no document, renderer or sound. Same seed, same inputs,
// same checksum; and the run is a real one (titans spawn and walk, the waves come on their clock).
import { config, setTunable, startGame, type Game } from 'hull';
import { InputCore, wireInput, type StepSnapshot } from 'hull/input';
import { projectSources } from 'hull/kits/testing';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { CFG } from './config.ts';
import def from './main.ts';
import { aottOf, hub } from './host.ts';
import type { Game as Aott } from './types.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const HZ = 120;

interface Run {
  checksum: string;
  a: Aott;
  g: Game;
  core: InputCore;
  /** Metres all titans together walked, sampled each second. */
  walked: number;
  waveAt: number[];
  maxTitans: number;
  recording: StepSnapshot[];
}

/** Starts a fresh game on a headless input core (what the browser's input view is in the page). */
async function start(seed: number, options: Record<string, unknown> = {}): Promise<{ g: Game; core: InputCore; a: Aott }> {
  let g: Game | undefined;
  const core = new InputCore(() => g?.world.tick ?? 0);
  hub.view = core;
  hub.options = { allies: 2, ...options };
  g = await startGame(def, { seed });
  core.setMap(config.lookup('input-map', 'play'), 'input-map/play');
  wireInput(g, core);
  return { g, core, a: aottOf(g) };
}

/**
 * Holdout for `seconds`. The soldier stands on the wall top and now and then jumps, so the input path and the soldier's
 * physics are in the run; the titans, the comrades and the clock do the rest.
 */
async function holdout(seed: number, seconds: number, replay?: StepSnapshot[]): Promise<Run> {
  const { g, core, a } = await start(seed);
  a.flow.start('expedition');
  a.player.reset(a.world.playerSpawn.position.clone(), 0);
  const rec = core.record();
  const steps = Math.round(seconds * HZ);
  if (replay) core.play(replay);
  const last = new Map<unknown, { x: number; z: number }>();
  let walked = 0;
  const waveAt: number[] = [];
  let maxTitans = 0;
  for (let i = 0; i < steps; i++) {
    if (!replay) core.play([i % 600 === 200 ? { jump: { d: 1, p: 1 } } : {}]);
    g.step(1);
    if (a.flow.wave > waveAt.length) waveAt.push(i / HZ);
    if (i % HZ === 0) {
      const ts = a.titans?.titans ?? [];
      maxTitans = Math.max(maxTitans, ts.length);
      for (const t of ts) {
        const at = last.get(t);
        if (at) walked += Math.hypot(t.position.x - at.x, t.position.z - at.z);
        last.set(t, { x: t.position.x, z: t.position.z });
      }
    }
  }
  const recording = rec.stop();
  return { checksum: g.world.checksum(), a, g, core, walked, waveAt, maxTitans, recording };
}

describe('AOTT on Hull, headless', () => {
  beforeAll(() => {
    const r = config.load(projectSources(root));
    expect(r.problems).toEqual([]);
  });

  it('plays Holdout: the same seed gives the same checksum, and the run makes real progress', async () => {
    // the first wave comes at 2.5 s; the next marches on a clock at 86 s
    const seconds = 95;
    const a = await holdout(11, seconds);
    console.log(`aott holdout: ${seconds} s, wave ${a.a.flow.wave} (reached at ${a.waveAt.map((t) => t.toFixed(1)).join(', ')} s), up to ${a.maxTitans} titans, the titans together walked ${a.walked.toFixed(1)} m, score ${a.a.flow.score}, checksum ${a.checksum}`);
    // real progress
    expect(a.a.mode).toBe('expedition');
    expect(a.maxTitans).toBeGreaterThanOrEqual(4);
    expect(a.walked).toBeGreaterThan(100);
    expect(a.a.flow.wave).toBeGreaterThanOrEqual(2);
    expect(a.a.time).toBeGreaterThan(seconds - 1);
    expect(a.g.world.tick).toBe(seconds * HZ);
    const checksumA = a.checksum;
    const recording = a.recording;
    expect(recording).toHaveLength(seconds * HZ);
    a.g.dispose();

    // the same seed and inputs again
    const b = await holdout(11, seconds);
    expect(b.checksum).toBe(checksumA);
    expect(b.a.flow.wave).toBe(a.a.flow.wave);
    b.g.dispose();

    // the recorded input alone reproduces the run
    const c = await holdout(11, seconds, recording);
    expect(c.checksum).toBe(checksumA);
    c.g.dispose();

    // another seed is another run (the titans come from different places)
    const d = await holdout(12, 20);
    const d0 = await holdout(11, 20);
    expect(d.checksum).not.toBe(d0.checksum);
    d.g.dispose();
    d0.g.dispose();
  }, 300000);

  it('turns the soldier and the titans from tunables, live and without a restart', async () => {
    const { g, a } = await start(3, { noTitans: true, noAllies: true, noHorses: true, noCivilians: true });
    // a tuning file edit (what the Inspector writes) reaches the code that reads CFG
    expect(CFG.hook.range).toBe(115);
    const file = (n: string, patch: Record<string, number>) => ({ path: `config/tuning/${n}.json`, text: JSON.stringify({ kind: 'tuning', ...patch }) });
    expect(config.update(file('hook', { range: 160 })).problems).toEqual([]);
    expect(CFG.hook.range).toBe(160);
    // and so does a tunable set over the dev protocol (setTunable is what 'tunable.changed' calls)
    expect(setTunable('body.gravity', 5)).toBeNull();
    expect(CFG.gravity).toBe(5);
    expect(setTunable('titan.windup', 0.9)).toBeNull();
    // a value out of range is refused and changes nothing
    expect(setTunable('body.gravity', -3)).not.toBeNull();
    expect(CFG.gravity).toBe(5);
    // the soldier really falls by the changed gravity
    a.flow.start('free');
    const p = a.player;
    p.reset(p.pos.clone().setY(p.pos.y + 20), 0);
    const y0 = p.pos.y;
    g.step(20);
    const lowFall = y0 - p.pos.y;
    setTunable('body.gravity', 14.5);
    p.reset(p.pos.clone().setY(y0), 0);
    g.step(20);
    const normalFall = y0 - p.pos.y;
    expect(normalFall).toBeGreaterThan(lowFall * 1.5);
    g.dispose();
  }, 120000);
});
