import { describe, expect, it } from 'vitest';
import { ALL_KITS, kitSources, startRig } from '../testing.ts';
import { Health } from '../health/health.ts';
import { Pickup, Stock } from '../pickups/pickups.ts';
import { kitIO } from '../io.ts';
import bench from './bench.ts';
import { SaveSlots } from './saves.ts';

const sources = kitSources(...ALL_KITS);

describe('save slots kit', () => {
  it('saves where things are and what they hold, and loads them back', async () => {
    const r = await startRig(bench, sources, 'fps');
    const w = r.g.world;
    const slots = w.find('saves')!.get(SaveSlots)!;
    const me = w.find('player')!;
    const hp = me.get(Health)!;
    const stock = me.add(Stock, { caps: { gas: 100 } });
    stock.add('gas', 40);
    r.step(20, { move: { y: -1 }, look: { x: 50, y: 0 } });
    hp.damage(35);
    const pick = w.group('pickup')[0]!.get(Pickup)!;
    pick.node.position.copy(me.position);
    r.step(3);
    expect(pick.active).toBe(false);
    hp.hp = 45;
    expect(slots.savedAt(1)).toBe(0);
    expect(slots.load(1)).toBe(false);
    expect(slots.save(1)).toBe(true);
    expect(slots.savedAt(1)).toBe(1_700_000_000_000);
    const saved = { x: me.position.x, z: me.position.z, hp: hp.hp };

    r.step(60, { move: { x: 1 } });
    hp.heal(30);
    stock.take('gas', 40);
    pick.active = true;
    expect(me.position.x).not.toBeCloseTo(saved.x, 1);
    expect(slots.load(1)).toBe(true);
    expect(me.position.x).toBeCloseTo(saved.x, 6);
    expect(me.position.z).toBeCloseTo(saved.z, 6);
    expect(hp.hp).toBe(saved.hp);
    expect(stock.get('gas')).toBe(40);
    expect(stock.values).toBe(me.get(Stock)!.values);
    expect(pick.active).toBe(false);
    expect(pick.node.object3d.visible).toBe(false);
    expect(() => slots.save(4)).toThrow(/slot 4/);
    kitIO.useSaves(null);
  });

  it('a second slot is independent', async () => {
    const r = await startRig(bench, sources, 'fps');
    const slots = r.g.world.find('saves')!.get(SaveSlots)!;
    const me = r.g.world.find('player')!;
    slots.save(1);
    r.step(30, { move: { y: -1 } });
    const z = me.position.z;
    slots.save(2);
    slots.load(1);
    expect(me.position.z).toBeCloseTo(0, 6);
    slots.load(2);
    expect(me.position.z).toBeCloseTo(z, 6);
  });
});
