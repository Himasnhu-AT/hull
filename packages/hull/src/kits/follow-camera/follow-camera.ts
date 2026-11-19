import { Behaviour, type Node } from '../../core/index.ts';
import { num, tunables } from '../../config/index.ts';
import { physicsOf, type Physics, type QueryFilter } from '../../physics/index.ts';
import { Camera, teleported } from '../../render/index.ts';
import { flagsOf, LAYER, lockPointerOnClick, type KitFlags } from '../common.ts';
import { kitIO } from '../io.ts';

export const followTuning = tunables('followCamera', {
  distance: num(6, { min: 1.5, max: 30, step: 0.5, unit: 'm', widget: 'dial', help: 'How far behind the target the camera sits at rest.' }),
  height: num(1.6, { min: 0, max: 6, step: 0.1, unit: 'm', help: 'Height above the target\'s feet the camera orbits and aims at.' }),
  shoulder: num(0.5, { min: -2, max: 2, step: 0.1, unit: 'm', help: 'Sideways offset of the aim point: over the shoulder.' }),
  pitch: num(0.3, { min: -0.5, max: 1.3, step: 0.05, unit: 'rad', help: 'Starting height of the camera angle.' }),
  pitchMin: num(-0.35, { min: -1.2, max: 0.5, step: 0.05, unit: 'rad' }),
  pitchMax: num(1.2, { min: 0.2, max: 1.5, step: 0.05, unit: 'rad' }),
  mouseSensitivity: num(0.0025, { min: 0.0003, max: 0.01, step: 0.0001, unit: 'rad/px', widget: 'dial' }),
  padLookSpeed: num(2.4, { min: 0.5, max: 8, step: 0.1, unit: 'rad/s', widget: 'slider', help: 'Look speed with the right stick or the arrow keys.' }),
  follow: num(14, { min: 1, max: 60, step: 1, unit: '1/s', widget: 'slider', help: 'How tightly the aim point follows the target. Higher is stiffer.' }),
  fov: num(60, { min: 30, max: 110, step: 1, unit: 'deg', widget: 'slider' }),
  fovPerSpeed: num(0.7, { min: 0, max: 3, step: 0.05, unit: 'deg per m/s', widget: 'dial', help: 'Widen the view as the target speeds up.' }),
  fovMaxExtra: num(24, { min: 0, max: 60, step: 1, unit: 'deg', help: 'The most the view widens.' }),
  distancePerSpeed: num(0.12, { min: 0, max: 1, step: 0.01, unit: 'm per m/s', widget: 'dial', help: 'Pull back as the target speeds up.' }),
  distanceMaxExtra: num(3.5, { min: 0, max: 15, step: 0.5, unit: 'm' }),
  speedSmoothing: num(5, { min: 0.5, max: 30, step: 0.5, unit: '1/s', help: 'How quickly the speed effects settle.' }),
  collisionRadius: num(0.3, { min: 0.05, max: 1, step: 0.05, unit: 'm', help: 'Size of the camera when it is pushed off walls.' }),
  recover: num(5, { min: 0.5, max: 30, step: 0.5, unit: '1/s', help: 'How quickly the camera returns after a wall let it go.' }),
  lockFollow: num(7, { min: 1, max: 30, step: 0.5, unit: '1/s', help: 'How quickly the view swings round to keep a locked-on target in front.' }),
  lockPitch: num(0.28, { min: -0.3, max: 1, step: 0.02, unit: 'rad', help: 'Camera height angle while locked on.' }),
  lockSlope: num(0, { min: 0, max: 1.5, step: 0.05, help: 'While locked on, how much of the climb to the target (on stairs and hills) the camera takes off its height angle, so a target uphill is not hidden behind the slope. 0 keeps lockPitch.' }),
  shakeSize: num(0.22, { min: 0, max: 1, step: 0.01, unit: 'm', help: 'Sideways and vertical travel of a full-strength shake.' }),
});

const lk = { x: 0, y: 0 };
const filter: QueryFilter = { mask: LAYER.world };
const orig = { x: 0, y: 0, z: 0 };
const dir = { x: 0, y: 0, z: 0 };

/**
 * An orbiting chase camera. Mouse (or arrow keys, or the right stick) turns it around the target; it widens its view
 * and pulls back as the target speeds up, and a sphere cast from the target keeps it out of walls: it jumps in at
 * once when a wall comes between, and eases back out when the way is clear. Other behaviours read `yaw` to move
 * relative to the view. The node needs a `Camera` behaviour; the target is found by name.
 */
export class FollowCamera extends Behaviour {
  static override state = ['yaw', 'pitch', 'dist', 'speed', 'px', 'py', 'pz', 'lx', 'lz', 'shakeA', 'shakeT', 'shakeLen'];
  targetName = 'player';
  yaw = 0;
  pitch = 0;
  dist = 0;
  speed = 0;
  px = 0; py = 0; pz = 0;
  /** Where the target was a step ago, for its speed. */
  lx = 0; lz = 0;
  /** A node to keep in front of the target (lock-on); null for free look. */
  lockTarget: Node | null = null;
  /** Shake strength left (0 to 1), seconds left, and the length it started with. */
  shakeA = 0; shakeT = 0; shakeLen = 0;
  private target!: Node;
  private cam!: Camera;
  private phys!: Physics;
  private flags!: KitFlags;
  private unlock: (() => void) | null = null;

  override ready(): void {
    this.flags = flagsOf(this.world);
    this.unlock = lockPointerOnClick(this.flags);
    this.phys = physicsOf(this.world);
    this.cam = this.node.get(Camera)!;
    const t = this.world.find(this.targetName);
    if (!t) throw new Error(`follow camera: there is no node named "${this.targetName}" to follow; spawn it first`);
    this.target = t;
    this.pitch = followTuning.pitch;
    this.dist = followTuning.distance;
    this.px = t.position.x; this.py = t.position.y + followTuning.height; this.pz = t.position.z;
    this.lx = t.position.x; this.lz = t.position.z;
    this.place(0);
    teleported(this.node);
  }

  override dispose(): void { this.unlock?.(); }

  override fixedUpdate(dt: number): void {
    if (this.flags.paused) return;
    const input = kitIO.input;
    const lock = this.lockTarget;
    if (lock && !lock.destroyed) {
      // Locked on: the view swings round behind the target so the locked node stays in front; look input is ignored.
      const k = 1 - Math.exp(-followTuning.lockFollow * dt);
      const want = Math.atan2(this.target.position.x - lock.position.x, this.target.position.z - lock.position.z);
      let d = (want - this.yaw) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      else if (d < -Math.PI) d += Math.PI * 2;
      this.yaw += d * k;
      let goal = followTuning.lockPitch;
      if (followTuning.lockSlope > 0) {
        const dx = lock.position.x - this.target.position.x, dz = lock.position.z - this.target.position.z;
        // Only a climb lowers the camera; a target downhill leaves the angle where it is.
        goal -= followTuning.lockSlope * Math.max(0, Math.atan2(lock.position.y - this.target.position.y, Math.max(1, Math.hypot(dx, dz))));
      }
      this.pitch += (goal - this.pitch) * k;
    } else {
      input.vec2('look', lk);
      this.yaw -= lk.x * followTuning.mouseSensitivity;
      this.pitch += lk.y * followTuning.mouseSensitivity;
      input.vec2('lookPad', lk);
      this.yaw -= lk.x * followTuning.padLookSpeed * dt;
      this.pitch += lk.y * followTuning.padLookSpeed * dt;
    }
    this.pitch = Math.min(Math.max(this.pitch, followTuning.pitchMin), followTuning.pitchMax);
    this.place(dt);
    this.applyShake(dt);
  }

  /** Shakes the view: strength 0 to 1 for this long. A stronger shake replaces a weaker one; a weaker one is ignored. */
  shake(amount: number, seconds: number): void {
    if (amount * seconds < this.shakeA * this.shakeT) return;
    this.shakeA = Math.min(1, amount);
    this.shakeT = seconds;
    this.shakeLen = seconds;
  }

  // A shake is a decaying wobble on the camera's position, from game time so a replay shakes the same.
  private applyShake(dt: number): void {
    if (this.shakeT <= 0) return;
    this.shakeT = Math.max(0, this.shakeT - dt);
    const k = this.shakeLen > 0 ? this.shakeT / this.shakeLen : 0;
    const a = this.shakeA * k * followTuning.shakeSize;
    const t = this.world.time;
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const sx = Math.sin(t * 71) * a, sv = Math.cos(t * 59) * a;
    this.node.position.x += cy * sx;
    this.node.position.z -= sy * sx;
    this.node.position.y += sv;
    if (this.shakeT <= 0) this.shakeA = 0;
  }

  private place(dt: number): void {
    const t = this.target.position;
    // Speed from how far the target moved since the last step, smoothed so a stop does not snap the view.
    const raw = dt > 0 ? Math.hypot(t.x - this.lx, t.z - this.lz) / dt : 0;
    this.lx = t.x; this.lz = t.z;
    const ks = dt > 0 ? 1 - Math.exp(-followTuning.speedSmoothing * dt) : 1;
    this.speed += (raw - this.speed) * ks;

    const k = dt > 0 ? 1 - Math.exp(-followTuning.follow * dt) : 1;
    // The aim point is the target's chest, a little to the side of the view's right (over the shoulder).
    const sx = Math.cos(this.yaw) * followTuning.shoulder;
    const sz = -Math.sin(this.yaw) * followTuning.shoulder;
    this.px += (t.x + sx - this.px) * k;
    this.py += (t.y + followTuning.height - this.py) * k;
    this.pz += (t.z + sz - this.pz) * k;

    const cp = Math.cos(this.pitch);
    dir.x = Math.sin(this.yaw) * cp;
    dir.y = Math.sin(this.pitch);
    dir.z = Math.cos(this.yaw) * cp;

    const want = followTuning.distance + Math.min(followTuning.distanceMaxExtra, this.speed * followTuning.distancePerSpeed);
    orig.x = this.px; orig.y = this.py; orig.z = this.pz;
    const hit = this.phys.spherecast(orig, dir, want, followTuning.collisionRadius, filter);
    const free = hit ? Math.max(0.4, hit.distance) : want;
    if (free < this.dist || dt === 0) this.dist = free;
    else this.dist += (free - this.dist) * (1 - Math.exp(-followTuning.recover * dt));

    this.node.position.set(this.px + dir.x * this.dist, this.py + dir.y * this.dist, this.pz + dir.z * this.dist);
    this.node.rotation.set(-this.pitch, this.yaw, 0, 'YXZ');

    const fov = followTuning.fov + Math.min(followTuning.fovMaxExtra, this.speed * followTuning.fovPerSpeed);
    if (this.cam.fov !== fov) {
      this.cam.fov = fov;
      if (this.cam.view) { this.cam.view.fov = fov; this.cam.view.updateProjectionMatrix(); }
    }
  }
}
