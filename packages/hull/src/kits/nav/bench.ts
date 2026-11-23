import { defineGame } from '../../core/index.ts';
import { usePhysics } from '../../physics/index.ts';
import { spawnFirstPerson } from '../fps/fps.ts';
import { ArenaLevel } from '../level/level.ts';
import { Spawner } from '../spawner/spawner.ts';
import { NavGrid } from './nav.ts';

/** Bench scene: waves of grunts that walk round the crates of the arena by path. */
export default defineGame({
  ready(g) {
    usePhysics(g.world);
    const level = g.world.spawn('level').add(ArenaLevel);
    const h = level.half;
    g.world.spawn('nav').add(NavGrid, { bounds: { minX: -h, maxX: h, minZ: -h, maxZ: h } });
    spawnFirstPerson(g.world);
    g.world.spawn('spawner').add(Spawner, { level });
  },
});
