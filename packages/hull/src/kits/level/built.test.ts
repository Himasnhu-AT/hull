import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { describe, expect, it } from 'vitest';
import { config, defineGame, type Game } from '../../index.ts';
import { Physics, physicsOf, usePhysics } from '../../physics/index.ts';
import { spawnFirstPerson } from '../fps/fps.ts';
import { Health } from '../health/health.ts';
import { Pickup, scatterPickups } from '../pickups/pickups.ts';
import { Spawner } from '../spawner/spawner.ts';
import { ALL_KITS, kitSources, startRig } from '../testing.ts';
import { LAYER, type LevelLike } from '../common.ts';
import { Level } from './built.ts';
import { yard } from './bench.ts';
import { checkLevel, checkPrefab } from './check.ts';
import type { Level as LevelDef, Prefab } from '../../schema/index.ts';

const sources = kitSources(...ALL_KITS);
const yardDef = (): LevelDef => config.lookup('level', 'yard') as LevelDef;

describe('level and prefab config kinds', () => {
  it('the example files pass their schemas and references', () => {
    const r = config.load(sources);
    expect(r.problems).toEqual([]);
    expect(r.ids['level']).toContain('yard');
    expect(r.ids['prefab']).toEqual(['crate', 'lamp', 'rock']);
    expect(checkLevel(yardDef(), 'level/yard')).toEqual([]);
    for (const id of r.ids['prefab']!) expect(checkPrefab(config.lookup('prefab', id) as Prefab, 'prefab/' + id)).toEqual([]);
  });

  it('a bad reference is a problem at file and pointer', () => {
    const bad = sources.map((s) => {
      if (s.path !== 'config/level/yard.json') return s;
      const v = JSON.parse(s.text);
      v.things[1].prefab = 'prefab/nope';
      v.blocks[0].material = 'material/missing';
      v.look = 'look/gone';
      v.scatter[0].prefab = 'prefab/rock-ish';
      return { ...s, text: JSON.stringify(v, null, 2) };
    });
    const r = config.load(bad);
    const at = r.problems.filter((p) => p.rule === 'ref').map((p) => `${p.file}#${p.pointer}`).sort();
    expect(at).toEqual([
      'config/level/yard.json#/blocks/0/material',
      'config/level/yard.json#/look',
      'config/level/yard.json#/scatter/0/prefab',
      'config/level/yard.json#/things/1/prefab',
    ]);
    expect(r.problems.every((p) => p.line !== undefined)).toBe(true);
    config.load(sources);
  });

  it('a prefab with a bad part is a schema problem, and the checker names flat sizes', () => {
    const bad = sources.map((s) => (s.path === 'config/prefab/crate.json' ? { ...s, text: JSON.stringify({ kind: 'prefab', parts: [{ shape: 'cone', size: [1, 1, 1], material: 'material/crate' }] }) } : s));
    const r = config.load(bad);
    expect(r.problems.map((p) => p.pointer)).toContain('/parts/0/shape');
    config.load(sources);
    const flat = { kind: 'prefab', parts: [{ shape: 'box', at: [0, 0, 0], size: [1, 0, 1], material: 'material/crate' }], collider: { shape: 'box', size: [1, 1, 0] } } as Prefab;
    expect(checkPrefab(flat, 'prefab/flat')).toEqual([
      'prefab/flat#/parts/0/size: every side must be more than 0, got [1, 0, 1]',
      'prefab/flat#/collider/size: the collider has no volume, got [1, 1, 0]',
    ]);
  });

  it('the level checker finds things off the ground and shared streams', () => {
    const d = structuredClone(yardDef()) as LevelDef;
    d.things![0]!.at = [90, 0, 0];
    d.markers!['lost'] = { at: [0, 0, -99] };
    d.scatter!.push({ ...d.scatter![0]!, count: 1 });
    expect(checkLevel(d, 'level/yard')).toEqual([
      expect.stringContaining('level/yard#/things/0/at:'),
      expect.stringContaining('level/yard#/markers/lost/at:'),
      expect.stringContaining('level/yard#/scatter/1/stream:'),
    ]);
  });
});

const layout = async (seed: number): Promise<{ key: string; checksum: string }> => {
  const r = await startRig(yard, sources, '', seed);
  const w = r.g.world;
  const lv = w.find('level')!.get(Level)!;
  r.step(5);
  const key = JSON.stringify([lv.blocks, lv.things('prefab/rock').map((n) => [n.position.x, n.position.z, n.rotation.y])]);
  const checksum = w.checksum();
  r.g.dispose();
  return { key, checksum };
};

describe('Level behaviour', () => {
  it('builds the same layout and checksum for one seed, another for another', async () => {
    const a = await layout(5);
    expect(await layout(5)).toEqual(a);
    const b = await layout(6);
    expect(b.key).not.toBe(a.key);
    expect(b.checksum).not.toBe(a.checksum);
  });

  it('finds markers and things, with groups and solid colliders on the world layer', async () => {
    const r = await startRig(yard, sources, '', 5);
    const w = r.g.world;
    const lv = w.find('level')!.get(Level)!;
    expect(lv.marker('start')).toMatchObject({ x: 0, y: 0, z: 14, yaw: 0 });
    expect(lv.marker('spawn/east')!.yaw).toBeCloseTo(Math.PI / 2);
    expect(lv.marker('nowhere')).toBeNull();
    expect(lv.markers('spawn/').map((m) => m.name)).toEqual(['spawn/north', 'spawn/east', 'spawn/west']);
    expect(lv.markers()).toHaveLength(5);
    expect(lv.things('prefab/crate')).toHaveLength(2);
    expect(lv.things('lamp')).toHaveLength(2);
    expect(lv.things('prefab/rock')).toHaveLength(6);
    expect(lv.things('prefab/none')).toHaveLength(0);
    // Each thing has its own name, so a save, world.find and the tree can tell them apart.
    expect(lv.things('prefab/rock').map((n) => n.name)).toEqual(['rock0', 'rock1', 'rock2', 'rock3', 'rock4', 'rock5']);
    expect(w.find('level/crate1')).toBe(lv.things('prefab/crate')[1]);
    expect(w.group('crate')).toHaveLength(2);
    expect(w.group('rock')).toHaveLength(6);
    expect(lv.bounds).toEqual({ minX: -20, maxX: 20, minZ: -20, maxZ: 20 });
    expect(lv.look).toBe('look/day');
    // Scattered rocks keep clear of each other, of the markers and of everything solid.
    const rocks = lv.things('prefab/rock');
    for (const a of rocks) {
      for (const m of lv.markers()) expect(Math.hypot(a.position.x - m.x, a.position.z - m.z)).toBeGreaterThan(3);
      for (const b of rocks) if (a !== b) expect(Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z)).toBeGreaterThan(1.5);
    }
    // The ramp is a turned box: a ray down onto its middle lands on its top, higher than the floor and lower than the platform.
    const ph = physicsOf(w) as Physics;
    const down = ph.raycast({ x: -6, y: 6, z: 8 }, { x: 0, y: -1, z: 0 }, 20, { mask: LAYER.world });
    expect(down).not.toBeNull();
    expect(down!.y).toBeGreaterThan(0.5);
    expect(down!.y).toBeLessThan(1.2);
    expect(Math.abs(down!.nx)).toBeGreaterThan(0.1);
    // A pillar is a prism: a ray at its middle lands on its top, one beside it passes to the floor.
    expect(ph.raycast({ x: 8, y: 6, z: -6 }, { x: 0, y: -1, z: 0 }, 20, { mask: LAYER.world })!.y).toBeCloseTo(3);
    expect(ph.raycast({ x: 9.6, y: 6, z: -6 }, { x: 0, y: -1, z: 0 }, 20, { mask: LAYER.world })!.y).toBeCloseTo(0);
    expect(lv.hits(5, 4, 0.2, 0.2)).toBe(true);
    expect(lv.hits(0, 0, 0.2, 0.2)).toBe(false);
    r.g.dispose();
  });

  it('allocates nothing per step', async () => {
    const r = await startRig(yard, sources, '', 5);
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    r.step(300);
    gc(); gc();
    const before = process.memoryUsage().heapUsed;
    r.step(6000);
    gc(); gc();
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(400_000);
    r.g.dispose();
  });
});

describe('a game whose world comes only from a level config', () => {
  // No block, crate or wall is written in code: the level file builds the world, then the pickups and spawner kits,
  // unchanged, place their things through the LevelLike it offers.
  const game = defineGame({
    ready(g: Game) {
      usePhysics(g.world);
      const level = g.world.spawn('level').add(Level, { level: 'yard' });
      const start = level.marker('start')!;
      const me = spawnFirstPerson(g.world, { x: start.x, z: start.z, yaw: start.yaw });
      me.get(Health)!.max = me.get(Health)!.hp = 1e6;
      scatterPickups(g.world, level, 'health', 4, { respawn: 5 });
      const s = g.world.spawn('spawner');
      s.add(Spawner, { level, firstCount: 2 } as Partial<Spawner>);
    },
  });

  const play = async (seed: number): Promise<{ checksum: string; spots: string }> => {
    const r = await startRig(game, sources, 'fps', seed);
    const w = r.g.world;
    const lv: LevelLike = w.find('level')!.get(Level)!;
    r.step(900);
    const pickups = w.group('pickup');
    expect(pickups).toHaveLength(4);
    const enemies = w.group('enemy');
    expect(enemies.length).toBeGreaterThan(0);
    for (const n of [...pickups, ...enemies]) {
      expect(n.position.x).toBeGreaterThan(lv.bounds.minX);
      expect(n.position.x).toBeLessThan(lv.bounds.maxX);
      expect(n.position.z).toBeGreaterThan(lv.bounds.minZ);
      expect(n.position.z).toBeLessThan(lv.bounds.maxZ);
    }
    for (const p of pickups) expect(lv.hits(p.position.x, p.position.z, 0.3, 0.3)).toBe(false);
    // A pickup takes health when the player stands on it.
    const me = w.find('player')!;
    const hp = me.get(Health)!;
    hp.hp = 100;
    const p0 = pickups[0]!;
    me.position.set(p0.position.x, 0, p0.position.z);
    r.step(3);
    expect(hp.hp).toBeGreaterThan(100);
    expect(p0.get(Pickup)!.active).toBe(false);
    const out = { checksum: w.checksum(), spots: JSON.stringify([...pickups, ...enemies].map((n) => [n.position.x, n.position.z])) };
    r.g.dispose();
    return out;
  };

  it('places the player at a marker, scatters pickups and spawns enemies on its free floor, the same every time', async () => {
    const a = await play(9);
    expect(await play(9)).toEqual(a);
    expect((await play(10)).spots).not.toBe(a.spots);
  });
});
