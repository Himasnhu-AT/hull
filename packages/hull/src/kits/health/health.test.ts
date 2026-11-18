import { describe, expect, it } from 'vitest';
import { ALL_KITS, kitSources, startRig } from '../testing.ts';
import { Chaser } from '../spawner/spawner.ts';
import { Health } from './health.ts';
import { Weapon } from './weapon.ts';
import bench from './bench.ts';

const sources = kitSources(...ALL_KITS);

describe('health kit', () => {
  it('scales damage by hit zone, protects after a hit, and dies once', async () => {
    const r = await startRig(bench, sources, 'fps');
    // The bench's enemies would bite in the middle of the test, so send them away first.
    for (const e of r.g.world.group('enemy').slice()) e.destroy();
    r.step(1);
    const me = r.g.world.find('player')!.get(Health)!;
    let deaths = 0;
    me.died.connect(() => deaths++);
    expect(me.damage(10, 'head')).toBe(20);
    expect(me.damage(10)).toBe(0); // still protected
    r.step(40);
    expect(me.damage(10, 'limb:left-arm')).toBe(5);
    r.step(40);
    expect(me.damage(10, 'nape')).toBe(30);
    me.zones['nape'] = 10;
    r.step(40);
    expect(me.damage(1, 'nape')).toBe(10);
    r.step(40);
    me.damage(1000);
    r.step(40);
    me.damage(1000);
    expect(me.dead).toBe(true);
    expect(deaths).toBe(1);
    expect(me.heal(10)).toBe(0);
    me.revive();
    expect(me.hp).toBe(me.max);
  });

  it('a shot to the head hurts twice as much as the rules say, and a kill removes the enemy', async () => {
    const r = await startRig(bench, sources, 'fps');
    const enemies = r.g.world.group('enemy');
    const mid = enemies[1]!;
    const hp = mid.get(Health)!;
    const gun = r.g.world.find('player')!.children.find((n) => n.name === 'eye')!.get(Weapon)!;
    const zones: string[] = [];
    gun.hit.connect((_t, zone) => zones.push(zone));
    const start = hp.hp;
    r.step(1, { fire: { d: 1 } });
    expect(zones).toEqual(['head']);
    expect(hp.hp).toBe(start - 25 * 2);
    r.step(12, { fire: { d: 1 } });
    expect(hp.dead).toBe(true);
    r.step(2);
    expect(mid.destroyed).toBe(true);
    expect(r.sounds['sound/shot']).toBeGreaterThanOrEqual(2);
    expect(r.sounds['sound/hit']).toBeGreaterThanOrEqual(2);
  });

  it('enemies bite the player', async () => {
    const r = await startRig(bench, sources, 'fps');
    const me = r.g.world.find('player')!.get(Health)!;
    r.step(300);
    expect(me.hp).toBeLessThan(me.max);
    expect(r.g.world.group('enemy')[0]!.get(Chaser)).toBeDefined();
  });
});
