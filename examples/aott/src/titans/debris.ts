// Cut-off limbs. A forearm or a lower leg that the blades take off does not vanish: the piece falls away from the
// stump, tumbling, hits the ground with a thud, and lies there steaming until it has boiled away to nothing (a
// titan's flesh does not last once it is off the body). The stump meanwhile grows a new limb (titan.ts).
import * as THREE from 'hull/three';
import type { Game } from '../types';
import { R } from '../sim';

interface Piece {
  obj: THREE.Group;
  vel: THREE.Vector3;
  axis: THREE.Vector3; spin: number;
  age: number; life: number;
  /** rough half-thickness, for where it meets the ground (m) */
  r: number;
  size: number;
  rest: boolean;
  steamT: number;
  s0: THREE.Vector3;
}

const DOWN = new THREE.Vector3(0, -1, 0), UP = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion(), _p = new THREE.Vector3();
const GRAVITY = 14.5;
/** Seconds a piece lies whole before it starts to boil away, and how long that takes. */
const WHOLE = 1.3, BOIL = 3.4;

export class LimbDebris {
  readonly game: Game;
  pieces: Piece[] = [];

  constructor(game: Game) { this.game = game; }

  /**
   * Let a limb go. `joint` is the joint it hung from (its world transform is where the piece starts); `parts` are
   * the meshes that come away with it, each with the local transform it had under that joint (null: none).
   * `size`: the titan's height (m), `dir`: the way the cut was going.
   */
  drop(joint: THREE.Object3D, parts: { mesh: THREE.Mesh; under: THREE.Object3D | null }[], size: number, dir: THREE.Vector3, inherit: THREE.Vector3 | null = null): void {
    if (this.pieces.length >= 14) this._remove(0);
    const obj = new THREE.Group();
    joint.updateWorldMatrix(true, false);
    joint.matrixWorld.decompose(obj.position, obj.quaternion, obj.scale);
    for (const part of parts) {
      const m = new THREE.Mesh(part.mesh.geometry, part.mesh.material);
      m.castShadow = true; m.receiveShadow = true;
      if (part.under) {
        const g = new THREE.Group();
        g.position.copy(part.under.position); g.quaternion.copy(part.under.quaternion);
        g.add(m); obj.add(g);
      } else obj.add(m);
    }
    this.game.scene.add(obj);
    const vel = new THREE.Vector3(dir.x, 0, dir.z);
    if (vel.lengthSq() < 1e-4) vel.set(R.fx() - 0.5, 0, R.fx() - 0.5);
    vel.normalize().multiplyScalar(2.5 + R.fx() * 2.5 + size * 0.12);
    vel.y = 1.5 + R.fx() * 2;
    if (inherit) vel.add(inherit);
    this.pieces.push({
      obj, vel, axis: new THREE.Vector3(R.fx() - 0.5, R.fx() * 0.4, R.fx() - 0.5).normalize(), spin: (1.2 + R.fx() * 2.2) * (R.fx() < 0.5 ? -1 : 1),
      age: 0, life: WHOLE + BOIL, r: Math.max(0.25, size * 0.045), size, rest: false, steamT: 0.2, s0: obj.scale.clone(),
    });
  }

  update(dt: number): void {
    const g = this.game, col = g.collision as unknown as { raycast(o: THREE.Vector3, d: THREE.Vector3, max: number, opts?: { dynamic?: boolean }): { point: THREE.Vector3; normal: THREE.Vector3; collider: { material?: string } } | null; groundHeight(x: number, z: number): number };
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const P = this.pieces[i], o = P.obj;
      P.age += dt;
      if (P.age >= P.life) { this._remove(i); continue; }
      if (!P.rest) {
        P.vel.y -= GRAVITY * dt;
        const fall = Math.max(0, -P.vel.y * dt);
        const hit = P.vel.y <= 0 ? col.raycast(_p.copy(o.position).setY(o.position.y + 0.5), DOWN, 0.5 + P.r + fall, { dynamic: false }) : null;
        o.position.addScaledVector(P.vel, dt);
        o.quaternion.premultiply(_q.setFromAxisAngle(P.axis, P.spin * dt));
        const floor = hit && hit.normal.y > 0.4 ? hit.point.y : col.groundHeight(o.position.x, o.position.z);
        if (o.position.y - P.r <= floor) {
          o.position.y = floor + P.r;
          const speed = -P.vel.y;
          if (speed > 2.5) {
            // it lands: a thud you feel, dust, and it rolls on a little
            g.audio?.titanStep?.(o.position, P.size * 0.45);
            g.fx?.impact?.(_p.copy(o.position).setY(floor), UP, hit?.collider?.material || 'ground');
            g.events.emit('titan:step', { position: o.position.clone(), size: P.size * 0.3 });
          }
          if (speed > 4) { P.vel.y = speed * 0.22; P.vel.x *= 0.55; P.vel.z *= 0.55; P.spin *= 0.5; }
          else { P.rest = true; P.vel.set(0, 0, 0); }
        }
      }
      // off the body it boils away: steam pours off it and it shrivels to nothing
      P.steamT -= dt;
      if (P.steamT <= 0) {
        const boiling = P.age > WHOLE;
        P.steamT = boiling ? 0.16 : 0.45;
        g.fx?.steam?.(o.position, P.r * (boiling ? 3.2 : 1.8), boiling ? 1.1 : 0.7);
      }
      if (P.age > WHOLE) {
        const k = 1 - (P.age - WHOLE) / BOIL;
        o.scale.copy(P.s0).multiplyScalar(Math.max(0.02, k * k * (3 - 2 * k)));
        if (P.rest) o.position.y -= P.r * 0.25 * dt;      // (settles as it thins)
      }
    }
  }

  private _remove(i: number): void {
    const P = this.pieces[i];
    P.obj.parent?.remove(P.obj);
    this.pieces.splice(i, 1);
  }

  clear(): void {
    for (const P of this.pieces) P.obj.parent?.remove(P.obj);
    this.pieces.length = 0;
  }
}
