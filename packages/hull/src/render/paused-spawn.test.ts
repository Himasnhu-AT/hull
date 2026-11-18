import { Mesh as ThreeMesh, Scene, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Behaviour, defineGame, startGame } from '../index.ts';
import { stateFor } from './interp.ts';
import { Mesh } from './behaviours.ts';

describe('nodes spawned while the game is paused and stepped', () => {
  // Enemies spawned inside game.step(n) were reported as never drawn. Drawing is simulated as the backends do it:
  // blend, update matrices, look for the mesh in the visible scene, restore.
  it('are in the drawn scene at the right pose after the next frame', async () => {
    class Spawner extends Behaviour {
      made = false;
      override fixedUpdate(): void {
        if (this.made || this.world.tick < 3) return;
        this.made = true;
        const e = this.world.spawn('enemy');
        e.add(Mesh, { shape: 'box' });
        e.position.set(4, 1, -2);
      }
    }
    class Walk extends Behaviour {
      override fixedUpdate(): void { this.node.position.x += 0.5; }
    }
    const g = await startGame(defineGame({ ready(game) { game.world.spawn('s').add(Spawner); } }));
    g.paused = true;
    g.step(5);
    const enemy = g.world.find('enemy')!;
    expect(enemy).toBeDefined();
    enemy.add(Walk);
    g.step(2);
    const scene = new Scene();
    scene.add(g.world.root.object3d);
    const drawn = (alpha: number): number[] => {
      const { interp } = stateFor(g.world);
      interp.apply(alpha);
      scene.updateMatrixWorld(true);
      let found = 0;
      scene.traverseVisible((o) => {
        if ((o as ThreeMesh).isMesh && o.parent === enemy.object3d) found++;
      });
      const x = new Vector3().setFromMatrixPosition(enemy.object3d.matrixWorld).x;
      interp.restore();
      return [found, x];
    };
    expect(drawn(1)).toEqual([1, 5]);
    expect(drawn(0)).toEqual([1, 4.5]);
    expect(enemy.position.x).toBe(5);
    g.dispose();
  });
});
