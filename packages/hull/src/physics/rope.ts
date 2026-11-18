// A rope (distance) constraint for grapple wires: a point held at no more than `length` from an anchor.
// The wire is slack inside that length and taut at it. A taut wire removes the outward part of the velocity and
// pulls the position back onto the sphere, so a swinger on it moves along an arc.
import type { Physics } from './world.ts';
import type { Hit, QueryFilter, Vec3Like } from './types.ts';

export class Rope {
  ax = 0; ay = 0; az = 0;
  length: number;
  /** 0 is a rigid wire, larger values let it give, as a fraction of the overshoot corrected per step. */
  stiffness = 1;
  /** Tension of the last solve, as the speed change it applied (m/s). */
  lastImpulse = 0;
  taut = false;

  constructor(anchor: Vec3Like, length: number) {
    this.ax = anchor.x; this.ay = anchor.y; this.az = anchor.z;
    this.length = length;
  }

  /** A wire from `from` to the point a ray along `dir` hits, as long as that hit is. Null if nothing is in reach. */
  static fromRay(phys: Physics, from: Vec3Like, dir: Vec3Like, maxDist: number, filter?: QueryFilter): Rope | null {
    const h: Hit | null = phys.raycast(from, dir, maxDist, filter);
    if (h === null) return null;
    return new Rope({ x: h.x, y: h.y, z: h.z }, h.distance);
  }

  /** Current distance from the anchor to `p`. */
  distance(p: Vec3Like): number {
    const x = p.x - this.ax, y = p.y - this.ay, z = p.z - this.az;
    return Math.sqrt(x * x + y * y + z * z);
  }

  /** Shortens (negative) or lengthens the wire, never below `min`. */
  reel(delta: number, min = 0.5): void {
    this.length = Math.max(min, this.length + delta);
  }

  /**
   * Applies the constraint to a position and velocity, both changed in place. Call it after moving, each step.
   * Returns true if the wire was taut.
   */
  solve(pos: Vec3Like, vel: Vec3Like, dt: number): boolean {
    let x = pos.x - this.ax, y = pos.y - this.ay, z = pos.z - this.az;
    const d = Math.sqrt(x * x + y * y + z * z);
    this.lastImpulse = 0;
    if (d <= this.length || d < 1e-9) { this.taut = false; return false; }
    x /= d; y /= d; z /= d;
    const over = d - this.length;
    const k = this.stiffness > 0 ? Math.min(1, this.stiffness) : 1;
    pos.x -= x * over * k; pos.y -= y * over * k; pos.z -= z * over * k;
    // Only the part of the velocity pulling away from the anchor is removed.
    const vr = vel.x * x + vel.y * y + vel.z * z;
    if (vr > 0) {
      vel.x -= x * vr; vel.y -= y * vr; vel.z -= z * vr;
      this.lastImpulse = vr;
    }
    void dt;
    this.taut = true;
    return true;
  }
}
