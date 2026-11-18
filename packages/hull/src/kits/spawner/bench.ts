import { defineGame } from '../../core/index.ts';
import { usePhysics } from '../../physics/index.ts';
import { spawnFirstPerson } from '../fps/fps.ts';
import { ArenaLevel } from '../level/level.ts';
import { Spawner, WaveHud } from './spawner.ts';

/** Bench scene: waves of grunts against a player who can shoot. */
export default defineGame({
  ready(g) {
    usePhysics(g.world);
    const level = g.world.spawn('level').add(ArenaLevel);
    spawnFirstPerson(g.world);
    const s = g.world.spawn('spawner');
    s.add(Spawner, { level });
    s.add(WaveHud);
  },
});
