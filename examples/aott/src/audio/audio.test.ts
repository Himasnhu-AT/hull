/// <reference types="node" />
// The game's sound on Hull: every recipe is valid and every sound the game can ask for exists, every code recipe has its
// generator, and a recorded Holdout asks for the same sounds, the same number of times, on every run. (Rendering and
// measuring the recipes needs Web Audio's OfflineAudioContext: that is the browser check in PORT.md.)
import { config, startGame, type Game } from 'hull';
import type { AudioView, SoundHandle } from 'hull/audio';
import { hasGenerator, planSynth } from 'hull/audio';
import { InputCore, wireInput } from 'hull/input';
import { projectSources } from 'hull/kits/testing';
import type { Mixer, Sound } from 'hull/schema';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import def from '../main.ts';
import { aottOf, hub } from '../host.ts';
import { Audio } from './audio';

const root = fileURLToPath(new URL('../..', import.meta.url));
const soundDir = join(root, 'config/sound');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : f.endsWith('.json') ? [join(dir, f)] : []));
}
const files = walk(soundDir).sort();
const idOf = (f: string): string => 'sound/' + f.slice(soundDir.length + 1, -5);

class Recorder implements AudioView {
  counts = new Map<string, number>();
  params: Record<string, number>[] = [];
  state = 'running' as const;
  context = null;
  play(id: string, o?: { params?: Record<string, number> }): SoundHandle {
    this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
    if (o?.params) this.params.push(o.params);
    return { stop() {}, set() {} };
  }
  setBus(): void {}
  duck(): void {}
  setBusLowpass(): void {}
  setListener(): void {}
  bus(): undefined { return undefined; }
  dispose(): void {}
}

describe('AOTT sounds', () => {
  beforeAll(() => {
    expect(config.load(projectSources(root)).problems).toEqual([]);
    new Audio(() => null); // registers the generators
  });

  it('has a valid recipe for every sound and a valid mixer', () => {
    expect(files.length).toBeGreaterThan(80);
    // config.load (beforeAll) validated every file against its schema and reported no problem; each is registered under its id
    for (const f of files) expect(config.has(idOf(f)), f).toBe(true);
    expect(config.has('mixer/main')).toBe(true);
  });

  it('plans every synth recipe to a finite length and gives every code recipe a registered generator', () => {
    const mixer = JSON.parse(readFileSync(join(root, 'config/mixer/main.json'), 'utf8')) as Mixer;
    let synth = 0;
    let code = 0;
    for (const f of files) {
      const s = JSON.parse(readFileSync(f, 'utf8')) as Sound;
      expect(Object.keys(mixer.buses), f).toContain(s.bus ?? 'sfx');
      if (s.source.type === 'synth') {
        synth++;
        const p = planSynth(s, 1);
        expect(p.length, f).toBeGreaterThan(0.01);
        expect(p.length, f).toBeLessThan(6);
        expect(planSynth(s, 7)).toEqual(planSynth(s, 7));
      } else if (s.source.type === 'code') {
        code++;
        expect(hasGenerator(s.source.generator), f).toBe(true);
      }
    }
    expect(synth).toBeGreaterThan(55);
    expect(code).toBeGreaterThan(15);
  });

  it('plays only sounds that exist, through every method of the game\'s Audio', () => {
    const rec = new Recorder();
    const a = new Audio(() => rec);
    expect(a.init()).toBe(true);
    const p = { x: 3, y: 4, z: 5 };
    for (const surface of ['stone', 'wood', 'bark', 'roof', 'metal', 'flesh', 'ground', 'nonsense']) {
      a.footstep(surface, 0.7, false); a.footstep(surface, 0.4, true); a.hookHit(surface, p); a.climbGrab(surface, 0.5);
    }
    for (const s of [0.1, 0.3, 0.5, 0.8, 1]) { a.impact(s); a.land(s); a.wireSnap(s); a.kickOff(s); a.whoosh(s, 0.3); a.wireCreak(s); }
    for (const z of [2, 5, 12, 25, 50, 100]) { a.titanStep(p, z); a.titanFall(p, z); a.steamHiss(p, z); a.titanGroan(p, z); }
    for (let n = 2; n <= 9; n++) a.combo(n);
    a.hookFire(0); a.hookFire(1); a.hookRetract(0); a.hookRetract('right'); a.hookMiss(); a.reelLock(true); a.reelLock(false);
    a.mantle(); a.speedBurst(); a.rescuePickup(); a.rescueDeliver(); a.civilianCry(p, 1); a.civilianLost(); a.uiHover(); a.uiClick(); a.uiBack(); a.whistle();
    a.slash(true); a.slash(false); a.napeKill(); a.bladeBreak(); a.bladeSwap(); a.refill(); a.grabbed(); a.eaten(); a.hurt(); a.behemothAppear();
    a.setGas(0); a.setGas(1); a.setReel(0.5); a.setWind(30); a.setScrape(0.4); a.setHeartbeat(0.8); a.setMusic(0.5); a.setAction(0.6);
    expect(a.toggleMute()).toBe(true);
    for (const id of rec.counts.keys()) expect(config.has(id), id).toBe(true);
    expect(rec.counts.size).toBeGreaterThan(75);
    // every recipe is reachable from the game (none is dead weight)
    const unused = files.map(idOf).filter((id) => !rec.counts.has(id));
    expect(unused).toEqual([]);
  });

  async function holdout(seed: number, seconds: number, recorder: Recorder): Promise<Game> {
    let g: Game | undefined;
    const core = new InputCore(() => g?.world.tick ?? 0);
    hub.view = core;
    hub.audio = recorder;
    hub.options = { allies: 2 };
    g = await startGame(def, { seed });
    core.setMap(config.lookup('input-map', 'play'), 'input-map/play');
    wireInput(g, core);
    const a = aottOf(g);
    a.flow.start('expedition');
    a.player.reset(a.world.playerSpawn.position.clone(), 0);
    const steps = Math.round(seconds * 120);
    for (let i = 0; i < steps; i++) {
      core.play([i % 600 === 200 ? { jump: { d: 1, p: 1 } } : {}]);
      g.step(1);
    }
    return g;
  }

  it('asks for the same sounds the same number of times in a Holdout, run twice', async () => {
    const r1 = new Recorder();
    const g1 = await holdout(11, 40, r1);
    g1.dispose();
    const r2 = new Recorder();
    const g2 = await holdout(11, 40, r2);
    g2.dispose();
    hub.audio = null;
    const sorted = (m: Map<string, number>): [string, number][] => [...m].sort((x, y) => (x[0] < y[0] ? -1 : 1));
    console.log('holdout sound ids:', JSON.stringify(sorted(r1.counts)));
    expect(r1.counts.size).toBeGreaterThan(3);
    expect(sorted(r2.counts)).toEqual(sorted(r1.counts));
    expect(r2.params).toEqual(r1.params);
    for (const id of r1.counts.keys()) expect(config.has(id), id).toBe(true);
  }, 300000);
});
