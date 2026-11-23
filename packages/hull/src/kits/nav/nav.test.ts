import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { describe, expect, it } from 'vitest';
import { defineGame, type Game } from '../../core/index.ts';
import { Collider, physicsOf, usePhysics } from '../../physics/index.ts';
import { GROUP, LAYER } from '../common.ts';
import { ALL_KITS, kitSources, startRig, type Rig } from '../testing.ts';
import { spawnGrunt } from '../spawner/spawner.ts';
import { followPath, NavGrid, navTuning, NavPath, newFollower, type FollowOut } from './nav.ts';
import bench from './bench.ts';

const sources = kitSources(...ALL_KITS);
const world = { layer: LAYER.world };

/** A 20 m square with a wall across the middle (x = 0) that has a gap at the top (z from 6 to 10). */
function maze(extra?: (g: Game) => void) {
  return defineGame({
    ready(g) {
      const p = usePhysics(g.world);
      p.addGround(0, world);
      p.addBox({ x: 0, y: 1, z: -2 }, { x: 0.6, y: 2, z: 16 }, world);
      extra?.(g);
      g.world.spawn('nav').add(NavGrid, { bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 } });
    },
  });
}

const grid = (r: Rig): NavGrid => r.g.world.find('nav')!.get(NavGrid)!;

describe('nav kit', () => {
  it('goes round a wall that blocks the straight line, in sight-smoothed legs', async () => {
    const r = await startRig(maze(), sources, '');
    const nav = grid(r);
    const path = new NavPath();
    expect(nav.lineClear(-5, 0, 5, 0)).toBe(false);
    expect(nav.findPath(-5, 0, 5, 0, path)).toBe(true);
    expect(path.count).toBeGreaterThanOrEqual(3);
    expect(path.count).toBeLessThan(8); // smoothed, not one point per cell
    expect([path.xs[0], path.zs[0]]).toEqual([-5, 0]);
    expect([path.xs[path.count - 1], path.zs[path.count - 1]]).toEqual([5, 0]);
    for (let i = 0; i < path.count - 1; i++) expect(nav.lineClear(path.xs[i]!, path.zs[i]!, path.xs[i + 1]!, path.zs[i + 1]!)).toBe(true);
    // Through the gap (z 6 to 10), so longer than the straight 10 m, about 17.
    expect(path.length).toBeGreaterThan(15);
    expect(path.length).toBeLessThan(30);
    expect(nav.reachable(-5, 0, 5, 0)).toBe(true);
    r.g.dispose();
  });

  it('snaps a start or goal inside the wall to the nearest free spot; nearestFree reports it', async () => {
    const r = await startRig(maze(), sources, '');
    const nav = grid(r);
    const out = { x: 0, z: 0 };
    expect(nav.walkable(0, 0)).toBe(false);
    expect(nav.nearestFree(0, 0, out)).toBe(true);
    expect(Math.abs(out.x)).toBeGreaterThan(0.6);
    expect(nav.walkable(out.x, out.z)).toBe(true);
    expect(nav.nearestFree(100, 100, out)).toBe(false);
    const path = new NavPath();
    expect(nav.findPath(-5, 0, 0, 0, path)).toBe(true);
    r.g.dispose();
  });

  it('gives false when there is no path, and a follower stops', async () => {
    const closed = maze((g) => {
      // A closed pen round (6, 0): four walls.
      const p = physicsOf(g.world);
      p.addBox({ x: 6, y: 1, z: -2 }, { x: 4, y: 2, z: 0.4 }, world);
      p.addBox({ x: 6, y: 1, z: 2 }, { x: 4, y: 2, z: 0.4 }, world);
      p.addBox({ x: 4, y: 1, z: 0 }, { x: 0.4, y: 2, z: 4 }, world);
      p.addBox({ x: 8, y: 1, z: 0 }, { x: 0.4, y: 2, z: 4 }, world);
    });
    const r = await startRig(closed, sources, '');
    const nav = grid(r);
    const path = new NavPath();
    expect(nav.findPath(-5, 0, 6, 0, path)).toBe(false);
    expect(path.count).toBe(0);
    expect(nav.reachable(-5, 0, 6, 0)).toBe(false);
    const f = newFollower(nav);
    f.goalX = 6; f.goalZ = 0;
    const out: FollowOut = { dx: 1, dz: 1, remaining: 1 };
    expect(followPath(f, { x: -5, z: 0 }, 3, 1 / 60, out)).toBe(false);
    expect([out.dx, out.dz]).toEqual([0, 0]);
    expect(f.hasPath).toBe(false);
    r.g.dispose();
  });

  it('replans when the grid is rebaked: a wall that falls opens the short way', async () => {
    const r = await startRig(maze(), sources, '');
    const nav = grid(r);
    const phys = physicsOf(r.g.world);
    let wall = null as null | ReturnType<typeof phys.addBox>;
    phys.eachShape((s) => { if (s.maxy === 2 && s.maxz > 5) wall = s; });
    expect(wall).not.toBeNull();
    const f = newFollower(nav);
    f.goalX = 5; f.goalZ = 0;
    const out: FollowOut = { dx: 0, dz: 0, remaining: 0 };
    const pos = { x: -5, z: 0 };
    followPath(f, pos, 3, 1 / 60, out);
    expect(out.remaining).toBeGreaterThan(15);
    phys.remove(wall!);
    nav.rebake();
    followPath(f, pos, 3, 1 / 60, out);
    expect(out.remaining).toBeCloseTo(10, 0);
    r.g.dispose();
  });

  it('allocates nothing in a query after warm-up', async () => {
    const r = await startRig(maze(), sources, '');
    const nav = grid(r);
    const path = new NavPath();
    const out = { x: 0, z: 0 };
    const f = newFollower(nav);
    const fo: FollowOut = { dx: 0, dz: 0, remaining: 0 };
    const pos = { x: -7, z: -7 };
    const go = (n: number): void => {
      for (let i = 0; i < n; i++) {
        const a = (i % 17) - 8;
        nav.findPath(-8 + (i % 3), a, 8, -a, path);
        nav.reachable(a, a, -a, 3);
        nav.nearestFree(0, a * 0.3, out);
        f.goalX = 8; f.goalZ = a;
        followPath(f, pos, 3, 0.2, fo);
      }
    };
    go(300);
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    gc(); gc();
    const before = process.memoryUsage().heapUsed;
    go(3000);
    gc(); gc();
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(200_000);
    r.g.dispose();
  });

  it('bakes a 60 m square at 0.5 m cells with 200 boxes', async () => {
    let seed = 12345;
    const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const big = defineGame({
      ready(g) {
        const p = usePhysics(g.world);
        p.addGround(0, world);
        for (let i = 0; i < 200; i++) p.addBox({ x: (rnd() - 0.5) * 56, y: 1, z: (rnd() - 0.5) * 56 }, { x: 1 + rnd() * 3, y: 2, z: 1 + rnd() * 3 }, world);
      },
    });
    const r = await startRig(big, sources, '');
    const n = r.g.world.spawn('nav');
    const t0 = performance.now();
    const nav = n.add(NavGrid, { bounds: { minX: -30, maxX: 30, minZ: -30, maxZ: 30 } });
    const ms = performance.now() - t0;
    console.log(`nav bake: ${nav.nx}x${nav.nz} cells, 200 boxes: ${ms.toFixed(1)} ms`);
    expect(nav.nx).toBe(120);
    // A wall-clock budget only on a quiet machine: HULL_PERF=1 pnpm test.
    if (process.env['HULL_PERF']) expect(ms).toBeLessThan(50);
    const t1 = performance.now();
    const path = new NavPath();
    let found = 0;
    for (let i = 0; i < 200; i++) if (nav.findPath(-28, -28 + i * 0.2, 28, 28 - i * 0.2, path)) found++;
    console.log(`nav 200 queries across the map: ${(performance.now() - t1).toFixed(1)} ms, ${found} found`);
    r.g.dispose();
  });

  async function chase(withNav: boolean): Promise<{ dist: number; checksum: string }> {
    const def = defineGame({
      ready(g) {
        const p = usePhysics(g.world);
        p.addGround(0, world);
        p.addBox({ x: 0, y: 1, z: -2 }, { x: 0.6, y: 2, z: 16 }, world);
        if (withNav) g.world.spawn('nav').add(NavGrid, { bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 } });
        const me = g.world.spawn('player');
        me.position.set(6, 0, 0);
        me.addTo(GROUP.player);
        me.add(Collider, { shape: { type: 'capsule', radius: 0.4, height: 1.7, center: [0, 0.85, 0] }, layer: LAYER.player });
        spawnGrunt(g.world, -6, 0, 1);
      },
    });
    const r = await startRig(def, sources, '', 9);
    r.step(60 * 14);
    const e = r.g.world.group(GROUP.enemy)[0]!;
    const dist = Math.hypot(e.position.x - 6, e.position.z);
    const checksum = r.g.world.checksum();
    r.g.dispose();
    return { dist, checksum };
  }

  it('a Chaser reaches a player behind a wall when there is a NavGrid, and sticks without one', async () => {
    const a = await chase(true);
    expect(a.dist).toBeLessThan(1.6);
    expect((await chase(true)).checksum).toBe(a.checksum);
    expect((await chase(false)).dist).toBeGreaterThan(6);
  });

  it('the bench scene runs the same every time', async () => {
    const run = async (): Promise<string> => {
      const r = await startRig(bench, sources, 'fps', 31);
      r.step(60 * 12);
      expect(r.g.world.group(GROUP.enemy).length).toBeGreaterThan(0);
      const c = r.g.world.checksum();
      r.g.dispose();
      return c;
    };
    expect(await run()).toBe(await run());
  });

  it('keeps its tunables in a nav block', () => {
    expect(navTuning.cellSize).toBe(0.5);
  });
});
