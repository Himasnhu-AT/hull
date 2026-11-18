import { Behaviour, defineGame } from 'hull';
import { Camera, Mesh } from 'hull/render';
import { cube } from './tuning.ts';

/** Turns its node around Y at the tuned speed. `angle` is gameplay state: it is in the checksum. */
export class Spin extends Behaviour {
  static override state = ['angle'];
  angle = 0;

  override fixedUpdate(dt: number): void {
    this.angle += cube.spin * dt;
    this.node.rotation.y = this.angle;
  }
}

export default defineGame({
  ready(game) {
    const box = game.world.spawn('cube');
    box.add(Mesh, { shape: 'box', color: '#f0a43a' });
    box.add(Spin);

    const eye = game.world.spawn('camera');
    eye.position.set(0, 1.2, 3.5);
    eye.rotation.x = -0.3;
    eye.add(Camera, { fov: 55 });
  },
});
