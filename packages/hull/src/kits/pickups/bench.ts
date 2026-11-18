import { defineGame } from '../../core/index.ts';
import { usePhysics } from '../../physics/index.ts';
import { spawnFirstPerson } from '../fps/fps.ts';
import { ArenaLevel } from '../level/level.ts';
import { scatterPickups } from './pickups.ts';

/** Bench scene: two of each kind of pickup on the floor around the player. */
export default defineGame({
  ready(g) {
    usePhysics(g.world);
    const level = g.world.spawn('level').add(ArenaLevel);
    spawnFirstPerson(g.world);
    for (const kind of ['health', 'ammo', 'gas', 'blades']) scatterPickups(g.world, level, kind, 2, { respawn: 6 });
  },
});
