import { defineGame } from '../../core/index.ts';
import { usePhysics } from '../../physics/index.ts';
import { spawnFirstPerson } from '../fps/fps.ts';
import { ArenaLevel } from '../level/level.ts';
import { scatterPickups } from '../pickups/pickups.ts';
import { SaveSlots } from './saves.ts';

/** Bench scene: a player, pickups and a SaveSlots node; call `save(1)` and `load(1)` on it from the console. */
export default defineGame({
  ready(g) {
    usePhysics(g.world);
    g.world.spawn('saves').add(SaveSlots);
    const level = g.world.spawn('level').add(ArenaLevel);
    spawnFirstPerson(g.world);
    scatterPickups(g.world, level, 'health', 3, { respawn: 0 });
  },
});
