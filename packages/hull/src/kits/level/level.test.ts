import { describe, expect, it } from 'vitest';
import { ALL_KITS, kitSources, startRig } from '../testing.ts';
import bench from './bench.ts';
import { ArenaLevel } from './level.ts';

const sources = kitSources(...ALL_KITS);
const layout = async (seed: number): Promise<string> => {
  const r = await startRig(bench, sources, '', seed);
  const lv = r.g.world.find('level')!.get(ArenaLevel)!;
  const s = JSON.stringify(lv.blocks);
  r.g.dispose();
  return s;
};

describe('level kit', () => {
  it('builds walls and crates, the same for one seed and different for another', async () => {
    const a = await layout(1);
    expect(JSON.parse(a).length).toBeGreaterThan(10);
    expect(await layout(1)).toBe(a);
    expect(await layout(2)).not.toBe(a);
  });

  it('finds free floor away from blocks and from a point', async () => {
    const r = await startRig(bench, sources, '', 3);
    const lv = r.g.world.find('level')!.get(ArenaLevel)!;
    const spot = { x: 0, z: 0 };
    for (let i = 0; i < 20; i++) {
      expect(lv.freeSpot(spot, 1, 'test', 0, 0, 8)).toBe(true);
      expect(lv.hits(spot.x, spot.z, 1, 1)).toBe(false);
      expect(Math.hypot(spot.x, spot.z)).toBeGreaterThanOrEqual(8);
    }
  });
});
