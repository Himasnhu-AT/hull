import { defineGame } from '../../core/index.ts';
import { Collider } from '../../physics/index.ts';
import { ensurePhysics, LAYER } from '../common.ts';
import { FirstPerson, spawnFirstPerson } from '../fps/fps.ts';
import { Health } from '../health/health.ts';
import { Launcher } from './projectile.ts';

/** Bench scene: a launcher on the player's eye, a thin wall at 10 m and a target with a Health at 6 m. */
export default defineGame({
  ready(g) {
    ensurePhysics(g.world).addGround(0, { layer: LAYER.world });
    const me = spawnFirstPerson(g.world);
    me.get(FirstPerson)!.eye.add(Launcher, { action: 'fire', speed: 200, damage: 20, rate: 6, hitSound: 'sound/projectile-hit' });
    const wall = g.world.spawn('wall');
    wall.position.set(0, 2, -10);
    wall.add(Collider, { shape: { type: 'box', size: [8, 4, 0.2] }, static: true, layer: LAYER.world });
    const target = g.world.spawn('target');
    target.position.set(2, 1, -6);
    target.add(Health, { max: 100, hp: 100, invulnAfterHit: 0 });
    target.add(Collider, { shape: { type: 'sphere', radius: 0.5 }, layer: LAYER.enemy });
  },
});
