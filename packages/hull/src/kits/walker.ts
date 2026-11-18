// Ground movement shared by the first- and third-person controllers: accelerate toward a wanted velocity, gravity,
// jump with a little coyote time, then let the physics mover slide the capsule against the world. The state is a
// plain object the controller lists in its `static state`, so it is in the checksum and in saves.
import type { Collider, MoveOptions } from '../physics/index.ts';
import { kitIO } from './io.ts';

export interface WalkState { vx: number; vy: number; vz: number; grounded: boolean; coyote: number; stride: number }
export const newWalk = (): WalkState => ({ vx: 0, vy: 0, vz: 0, grounded: false, coyote: 0, stride: 0 });

export interface WalkTuning { jumpHeight: number; gravity: number; coyoteTime: number; airControl: number }

const vel = { x: 0, y: 0, z: 0 };
const opts: MoveOptions = { mask: 0, stepHeight: 0.35, snap: 0.2 };

/**
 * One fixed step. (wx, wz) is the wanted direction (length 0..1), `speed` the top speed, `accel` m/s². Returns how
 * hard the capsule landed this step (m/s), or 0.
 */
export function walk(c: Collider, s: WalkState, wx: number, wz: number, speed: number, accel: number, jump: boolean, mask: number, t: WalkTuning, dt: number): number {
  const a = accel * (s.grounded ? 1 : t.airControl) * dt;
  const dx = wx * speed - s.vx;
  const dz = wz * speed - s.vz;
  const d = Math.hypot(dx, dz);
  if (d <= a) { s.vx += dx; s.vz += dz; } else { s.vx += (dx / d) * a; s.vz += (dz / d) * a; }

  s.coyote = s.grounded ? t.coyoteTime : Math.max(0, s.coyote - dt);
  if (jump && s.coyote > 0) {
    s.vy = Math.sqrt(2 * t.gravity * t.jumpHeight);
    s.grounded = false;
    s.coyote = 0;
  }
  s.vy -= t.gravity * dt;

  vel.x = s.vx; vel.y = s.vy; vel.z = s.vz;
  opts.mask = mask;
  // Stepping up and snapping to the ground would glue a jump to the floor, so both wait until the jump is over.
  opts.snap = s.vy > 0 ? 0 : 0.2;
  opts.stepHeight = s.vy > 0 ? 0 : 0.35;
  const was = s.grounded;
  const r = c.move(vel, dt, opts);
  const impact = !was && r.grounded ? Math.max(0, -s.vy) : 0;
  s.vx = r.vx; s.vy = r.vy; s.vz = r.vz;
  s.grounded = r.grounded;
  return impact;
}

/** Footsteps by distance run, so a faster body steps faster and a stopped one is silent. Sounds are effects only. */
export function footsteps(s: WalkState, dt: number, strideLength: number, sound: string): void {
  const speed = Math.hypot(s.vx, s.vz);
  if (s.grounded && speed > 0.5) {
    s.stride += speed * dt;
    if (s.stride >= strideLength) {
      s.stride -= strideLength;
      if (sound !== '') kitIO.play(sound);
    }
  } else if (s.grounded) {
    s.stride = strideLength * 0.8;
  }
}
