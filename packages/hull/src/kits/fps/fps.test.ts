import { describe, expect, it } from 'vitest';
import { defineGame } from '../../core/index.ts';
import { usePhysics } from '../../physics/index.ts';
import { Mesh } from '../../render/index.ts';
import { Weapon } from '../health/weapon.ts';
import { ArenaLevel } from '../level/level.ts';
import { ALL_KITS, kitSources, startRig, type Rig } from '../testing.ts';
import bench from './bench.ts';
import { FirstPerson, spawnFirstPerson } from './fps.ts';

const sources = kitSources(...ALL_KITS);
const fwd = { move: { y: -1 } };

async function start(): Promise<{ r: Rig; fp: FirstPerson }> {
  const r = await startRig(bench, sources, 'fps');
  return { r, fp: r.g.world.find('player')!.get(FirstPerson)! };
}

describe('first-person kit', () => {
  it('walks forward, faster when sprinting, and stays inside the arena', async () => {
    const { r, fp } = await start();
    const p = r.g.world.find('player')!.position;
    r.step(30);
    expect(fp.walk.grounded).toBe(true);
    const z0 = p.z;
    r.step(60, fwd);
    const walked = z0 - p.z;
    expect(walked).toBeGreaterThan(3);
    const half = r.g.world.find('level')!.get(ArenaLevel)!.half;
    r.step(900, fwd);
    expect(Math.abs(p.z)).toBeLessThan(half);
    expect(Math.abs(p.x)).toBeLessThan(half);

    const b = await start();
    b.r.step(30);
    const q = b.r.g.world.find('player')!.position;
    const z1 = q.z;
    b.r.step(60, { ...fwd, sprint: { d: 1 } });
    expect(z1 - q.z).toBeGreaterThan(walked * 1.2);
  });

  it('looks with the mouse and the arrow keys, and moves relative to where it looks', async () => {
    const { r, fp } = await start();
    r.step(2);
    r.step(1, { look: { x: 100, y: 0 } });
    expect(fp.yaw).toBeLessThan(-0.1);
    r.step(30, { lookPad: { x: -1 } });
    expect(fp.yaw).toBeGreaterThan(-0.1);
    r.step(1, { look: { x: 0, y: -2000 } });
    expect(fp.pitch).toBeLessThanOrEqual((85 * Math.PI) / 180 + 1e-9);
    // Facing +x (yaw = -90 degrees), forward is +x.
    const { r: r2, fp: f2 } = await start();
    f2.yaw = -Math.PI / 2;
    r2.step(30);
    const p = r2.g.world.find('player')!.position;
    const x0 = p.x;
    r2.step(40, fwd);
    expect(p.x - x0).toBeGreaterThan(2);
    expect(Math.abs(p.z)).toBeLessThan(0.5);
  });

  it('jumps and lands, with a landing sound', async () => {
    const { r, fp } = await start();
    r.step(30);
    const p = r.g.world.find('player')!.position;
    let peak = 0;
    r.step(1, { jump: { d: 1, p: 1 } });
    for (let i = 0; i < 90; i++) { r.step(1); peak = Math.max(peak, p.y); }
    expect(peak).toBeGreaterThan(0.8);
    expect(fp.walk.grounded).toBe(true);
    expect(p.y).toBeCloseTo(0, 1);
  });

  it('is the same on every run', async () => {
    const run = async (): Promise<string> => {
      const { r } = await start();
      r.step(20);
      r.step(40, { ...fwd, sprint: { d: 1 } });
      r.step(1, { jump: { d: 1, p: 1 } });
      r.step(40, { move: { x: 1, y: -1 }, look: { x: 4, y: 0 } });
      const c = r.g.world.checksum();
      r.g.dispose();
      return c;
    };
    expect(await run()).toBe(await run());
  });
});

describe('spawnFirstPerson options', () => {
  const unarmed = defineGame({ ready(g) { usePhysics(g.world); g.world.spawn('level').add(ArenaLevel); spawnFirstPerson(g.world, { x: 2, z: 3, gun: false }); } });
  it('has a gun by default: a Weapon on the eye and a gun mesh', async () => {
    const { fp } = await start();
    expect(fp.eye.get(Weapon)).toBeTruthy();
    expect(fp.eye.children.some((c) => c.name === 'gun' && c.get(Mesh))).toBe(true);
  });
  it('leaves out the Weapon and its mesh with gun: false, and still places the player', async () => {
    const r = await startRig(unarmed, sources, 'fps');
    const me = r.g.world.find('player')!;
    const fp = me.get(FirstPerson)!;
    expect(fp.eye.get(Weapon)).toBeFalsy();
    expect(r.g.world.find('player/eye/gun')).toBeFalsy();
    expect([me.position.x, me.position.z]).toEqual([2, 3]);
    r.step(30, { fire: { d: 1, p: 1 } });
  });
});
