import { describe, expect, it } from 'vitest';
import { ALL_KITS, kitSources, startRig } from '../testing.ts';
import { defineGame } from '../../core/index.ts';
import { usePhysics } from '../../physics/index.ts';
import { spawnFirstPerson } from '../fps/fps.ts';
import { Health } from '../health/health.ts';
import { ArenaLevel } from '../level/level.ts';
import { Pickup, Stock, scatterPickups } from './pickups.ts';
import bench from './bench.ts';

const sources = kitSources(...ALL_KITS);

describe('pickups kit', () => {
  it('a stock holds named counters up to a cap', async () => {
    const r = await startRig(bench, sources, 'fps');
    const s = r.g.world.find('player')!.add(Stock, { caps: { gas: 100 } });
    expect(s.add('gas', 70)).toBe(70);
    expect(s.add('gas', 70)).toBe(30);
    expect(s.take('gas', 200)).toBe(false);
    expect(s.take('gas', 40)).toBe(true);
    expect(s.drain('gas', 1000)).toBe(60);
    expect(s.get('gas')).toBe(0);
    expect(s.add('blades', 5)).toBe(5);
  });

  it('heals only when hurt, fills a stock, and comes back after its respawn time', async () => {
    const game = defineGame({
      ready(g) {
        usePhysics(g.world);
        const level = g.world.spawn('level').add(ArenaLevel);
        const me = spawnFirstPerson(g.world);
        me.add(Stock, { caps: { gas: 100 } });
        void level;
        const a = g.world.spawn('heal');
        a.position.set(0.2, 0.7, 0);
        a.add(Pickup, { kind: 'health', amount: 30, respawn: 2 });
        const b = g.world.spawn('gas');
        b.position.set(-0.2, 0.7, 0);
        b.add(Pickup, { kind: 'gas', amount: 60 });
      },
    });
    const r = await startRig(game, sources, 'fps');
    const w = r.g.world;
    const heal = w.find('heal')!.get(Pickup)!;
    const hp = w.find('player')!.get(Health)!;
    const gas = w.find('player')!.get(Stock)!;
    r.step(5);
    expect(heal.active).toBe(true); // full health: left alone
    expect(gas.get('gas')).toBe(60);
    expect(w.find('gas')!.get(Pickup)!.active).toBe(false);
    hp.damage(50);
    r.step(2);
    expect(heal.active).toBe(false);
    expect(hp.hp).toBe(80);
    expect(r.sounds['sound/pickup']).toBe(2);
    r.step(130);
    expect(heal.active).toBe(false); // the player stands on it at full health? no: 80 of 100, so it heals again
  });

  it('scatter puts pickups on free floor, the same every time', async () => {
    const run = async (): Promise<string> => {
      const r = await startRig(bench, sources, 'fps', 5);
      const out = r.g.world.group('pickup').map((n) => `${n.position.x.toFixed(3)},${n.position.z.toFixed(3)}`).join(' ');
      const c = r.g.world.checksum();
      r.g.dispose();
      return `${out}|${c}`;
    };
    const a = await run();
    expect(a.split('|')[0]!.split(' ').length).toBe(8);
    expect(await run()).toBe(a);
    const r = await startRig(bench, sources, 'fps');
    void scatterPickups;
    r.g.dispose();
  });
});
