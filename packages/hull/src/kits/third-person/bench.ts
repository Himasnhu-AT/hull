import { defineGame } from '../../core/index.ts';
import { usePhysics } from '../../physics/index.ts';
import { ArenaLevel } from '../level/level.ts';
import { scatterPickups } from '../pickups/pickups.ts';
import { spawnThirdPerson } from './third-person.ts';

/** Bench scene: the soldier with gas pickups on the floor, to feel run, sprint and boost. */
export default defineGame({
  ready(g) {
    usePhysics(g.world);
    const level = g.world.spawn('level').add(ArenaLevel);
    spawnThirdPerson(g.world);
    scatterPickups(g.world, level, 'gas', 4, { amount: 40, respawn: 8 });
  },
});
