import { defineGame } from '../../core/index.ts';
import { usePhysics } from '../../physics/index.ts';
import { spawnFirstPerson } from '../fps/fps.ts';
import { ArenaLevel } from '../level/level.ts';
import { spawnGrunt } from '../spawner/spawner.ts';

/** Bench scene: a gun and a row of enemies standing at different distances, to try hit zones and damage. */
export default defineGame({
  ready(g) {
    usePhysics(g.world);
    g.world.spawn('level').add(ArenaLevel);
    spawnFirstPerson(g.world);
    for (let i = 0; i < 3; i++) spawnGrunt(g.world, -4 + i * 4, -8, 1);
  },
});
