import { defineGame } from '../../core/index.ts';
import { Collider } from '../../physics/index.ts';
import { ensurePhysics, LAYER } from '../common.ts';
import { FirstPerson, spawnFirstPerson } from '../fps/fps.ts';
import { Interactable, Interactor } from './interact.ts';

/** Bench scene: a player with an Interactor, a lever in front, a door behind a wall, and a chest behind the player. */
export default defineGame({
  ready(g) {
    ensurePhysics(g.world).addGround(0, { layer: LAYER.world });
    const me = spawnFirstPerson(g.world);
    me.get(FirstPerson)!.eye.add(Interactor);
    const make = (name: string, x: number, y: number, z: number, prompt: string, radius = 0): void => {
      const n = g.world.spawn(name);
      n.position.set(x, y, z);
      n.add(Interactable, { prompt, radius });
    };
    make('lever', 0, 1.6, -2, 'Pull lever');
    make('chest', 0, 1.6, 3, 'Open chest');
    make('door', 0, 1.6, -9, 'Open door', 12);
    const wall = g.world.spawn('wall');
    wall.position.set(0, 2, -6);
    wall.add(Collider, { shape: { type: 'box', size: [6, 4, 0.2] }, static: true, layer: LAYER.world });
  },
});
