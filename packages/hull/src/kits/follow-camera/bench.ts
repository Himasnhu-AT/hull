import { defineGame } from '../../core/index.ts';
import { usePhysics } from '../../physics/index.ts';
import { ArenaLevel } from '../level/level.ts';
import { spawnThirdPerson } from '../third-person/third-person.ts';

/** Bench scene: a capsule body (no character) and the follow camera, to tune distance, speed effects and walls. */
export default defineGame({
  ready(g) {
    usePhysics(g.world);
    g.world.spawn('level').add(ArenaLevel);
    spawnThirdPerson(g.world, { x: 0, z: 0 }, '');
  },
});
