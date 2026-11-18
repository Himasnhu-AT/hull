import { Behaviour, type Node } from 'hull';
import { Camera, Mesh, teleported } from 'hull/render';
import { Level } from './level.ts';
import { rig, sound } from './rig.ts';
import { Round } from './round.ts';
import { camera, player, sfx } from './tuning.ts';

const stick = { x: 0, y: 0 };
const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * A capsule that runs and jumps. Collision is a circle on the floor plane against the boxes of the level, plus a
 * floor height per box, which is all a crate arena needs. Everything is in fixed steps; the sounds are effects only.
 */
export class Player extends Behaviour {
  static override state = ['vx', 'vy', 'vz', 'grounded', 'coyote', 'stride'];
  vx = 0;
  vy = 0;
  vz = 0;
  grounded = true;
  /** Seconds left in which a jump still counts after leaving the ground. */
  coyote = 0;
  /** Distance run since the last footstep. */
  stride = 0;

  private level!: Level;
  private round!: Round;
  private body!: Node;

  override ready(): void {
    this.level = this.world.find('level')!.get(Level)!;
    this.round = this.world.find('round')!.get(Round)!;
    this.body = this.world.spawn('body', this.node);
    this.body.add(Mesh, { shape: 'capsule', material: 'material/player' });
  }

  override fixedUpdate(dt: number): void {
    const p = this.node.position;
    const r = player.radius;
    const input = rig.input;

    let mx = 0;
    let mz = 0;
    let jump = false;
    if (!this.round.over) {
      input.vec2('move', stick);
      const len = Math.hypot(stick.x, stick.y);
      const k = len > 1 ? 1 / len : 1;
      // Up on the stick or W is negative y, which is forward (-z) in the world.
      mx = stick.x * k;
      mz = stick.y * k;
      jump = input.action('jump').pressed;
    }

    // Accelerate toward the wanted velocity; in the air only a share of the ground acceleration applies.
    const accel = player.groundAccel * (this.grounded ? 1 : player.airControl) * dt;
    const dx = mx * player.runSpeed - this.vx;
    const dz = mz * player.runSpeed - this.vz;
    const d = Math.hypot(dx, dz);
    if (d <= accel) {
      this.vx += dx;
      this.vz += dz;
    } else {
      this.vx += (dx / d) * accel;
      this.vz += (dz / d) * accel;
    }

    this.coyote = this.grounded ? player.coyoteTime : Math.max(0, this.coyote - dt);
    if (jump && this.coyote > 0) {
      this.vy = Math.sqrt(2 * player.gravity * player.jumpHeight);
      this.grounded = false;
      this.coyote = 0;
    }

    // Sideways first, so the vertical step sees where the player really is.
    p.x += this.vx * dt;
    p.z += this.vz * dt;
    this.pushOutOfBlocks(p.x, p.z, p.y, r);
    const lim = this.level.half - r;
    p.x = Math.min(Math.max(p.x, -lim), lim);
    p.z = Math.min(Math.max(p.z, -lim), lim);

    const wasGrounded = this.grounded;
    const feetBefore = p.y;
    this.vy -= player.gravity * dt;
    p.y += this.vy * dt;
    let support = 0;
    if (this.vy <= 0) {
      for (const b of this.level.blocks) {
        if (feetBefore < b.top - 0.05 || b.top <= support) continue;
        const cx = Math.min(Math.max(p.x, b.x - b.hx), b.x + b.hx) - p.x;
        const cz = Math.min(Math.max(p.z, b.z - b.hz), b.z + b.hz) - p.z;
        if (cx * cx + cz * cz < r * r) support = b.top;
      }
    }
    this.grounded = false;
    if (p.y <= support && this.vy <= 0) {
      const impact = -this.vy;
      p.y = support;
      this.vy = 0;
      this.grounded = true;
      if (!wasGrounded && impact > sfx.landMinSpeed) {
        const t = clamp01((impact - sfx.landMinSpeed) / Math.max(0.001, sfx.landMaxSpeed - sfx.landMinSpeed));
        sound.play('sound/thud', { volume: 0.25 + 0.75 * t });
      }
    }

    // Footsteps by distance run, so a faster player steps faster and a stopped one is silent.
    const speed = Math.hypot(this.vx, this.vz);
    if (this.grounded && speed > 0.5) {
      this.stride += speed * dt;
      if (this.stride >= sfx.strideLength) {
        this.stride -= sfx.strideLength;
        sound.play('sound/footstep');
      }
    } else if (this.grounded) {
      this.stride = sfx.strideLength;
    }

    const b = this.body;
    b.scale.set(r / 0.25, player.height, r / 0.25);
    b.position.y = player.height / 2;
  }

  private pushOutOfBlocks(x: number, z: number, y: number, r: number): void {
    const p = this.node.position;
    for (const b of this.level.blocks) {
      if (y >= b.top - 0.05) continue;
      const cx = Math.min(Math.max(x, b.x - b.hx), b.x + b.hx);
      const cz = Math.min(Math.max(z, b.z - b.hz), b.z + b.hz);
      const dx = x - cx;
      const dz = z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      let nx: number;
      let nz: number;
      if (d2 > 1e-12) {
        const d = Math.sqrt(d2);
        nx = dx / d;
        nz = dz / d;
        p.x = cx + nx * r;
        p.z = cz + nz * r;
      } else {
        // The centre is inside the box: leave by the nearest face.
        const ex = b.hx - Math.abs(x - b.x);
        const ez = b.hz - Math.abs(z - b.z);
        if (ex < ez) { nx = x < b.x ? -1 : 1; nz = 0; p.x = b.x + nx * (b.hx + r); } else { nx = 0; nz = z < b.z ? -1 : 1; p.z = b.z + nz * (b.hz + r); }
      }
      // Lose the part of the velocity that points into the box, keep the part along it (so the player slides).
      const vn = this.vx * nx + this.vz * nz;
      if (vn < 0) {
        this.vx -= vn * nx;
        this.vz -= vn * nz;
      }
      x = p.x;
      z = p.z;
    }
  }
}

/** Follows the player from behind and above, smoothly, and looks at them. */
export class CameraRig extends Behaviour {
  private target!: Node;
  private cam!: Camera;

  override ready(): void {
    this.target = this.world.find('player')!;
    this.cam = this.node.get(Camera)!;
    const t = this.target.position;
    this.node.position.set(t.x, t.y + camera.height, t.z + camera.distance);
    this.aim();
    teleported(this.node);
  }

  override fixedUpdate(dt: number): void {
    const t = this.target.position;
    const c = this.node.position;
    const k = 1 - Math.exp(-camera.follow * dt);
    c.x += (t.x - c.x) * k;
    c.y += (t.y + camera.height - c.y) * k;
    c.z += (t.z + camera.distance - c.z) * k;
    this.aim();
  }

  private aim(): void {
    const t = this.target.position;
    const c = this.node.position;
    const flat = Math.hypot(c.x - t.x, c.z - t.z);
    this.node.rotation.set(-Math.atan2(c.y - (t.y + camera.lookHeight), flat), Math.atan2(c.x - t.x, c.z - t.z), 0, 'YXZ');
    if (this.cam.fov !== camera.fov) {
      this.cam.fov = camera.fov;
      if (this.cam.view) { this.cam.view.fov = camera.fov; this.cam.view.updateProjectionMatrix(); }
    }
  }
}
