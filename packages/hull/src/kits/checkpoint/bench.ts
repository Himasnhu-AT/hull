import { defineGame } from '../../core/index.ts';
import { ensurePhysics, LAYER } from '../common.ts';
import { spawnFirstPerson } from '../fps/fps.ts';
import { SaveSlots } from '../saves/saves.ts';
import { Checkpoint, Respawn } from './checkpoint.ts';

/** Bench scene: a player who comes back after dying, two checkpoints to walk through, and save slots. */
export default defineGame({
  ready(g) {
    ensurePhysics(g.world).addGround(0, { layer: LAYER.world });
    const me = spawnFirstPerson(g.world);
    me.add(Respawn);
    g.world.spawn('saves').add(SaveSlots);
    const cp = (name: string, x: number, z: number, yaw: number): void => {
      const n = g.world.spawn(name);
      n.position.set(x, 0, z);
      n.rotation.y = yaw;
      n.add(Checkpoint, { radius: 2 });
    };
    cp('cp1', 0, -10, 0.5);
    cp('cp2', 12, -10, -0.5);
  },
});
