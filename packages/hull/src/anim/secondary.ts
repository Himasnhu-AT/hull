// Secondary motion that is not in any clip: chains of bones that swing from the body's own movement (hair, a sash, a
// tassel on the scabbard), and a flinch that leans the body away from a blow. Both are additive, run on frame time
// (they move the picture, not the game) and stop when the animator's time scale is 0, so a hit-stop holds them too.
// Nothing here allocates per frame: the state lives in typed arrays made when the character is built.
import { Quaternion, type Matrix4, type Object3D } from 'three';
import type { AnimGraph } from '../schema/anim-graph.ts';
import { clamp, qMul, qRotate } from './math.ts';
import type { Pose, Skeleton } from './skeleton.ts';

const _nq = new Quaternion();
const _nqa = new Float64Array(4);
const _wr = new Float64Array(4);
const _la = new Float64Array(3);
const _qq = new Float64Array(4);
const _pw = new Float64Array(3);

/** Rotation by the rotation vector (axis times angle) `w` at index i, laid over the bone's rotation in its parent's frame. */
function addRotation(pose: Pose, bone: number, wx: number, wy: number, wz: number): void {
  const a = Math.hypot(wx, wy, wz);
  if (a < 1e-7) return;
  const s = Math.sin(a / 2) / a;
  _qq[0] = wx * s; _qq[1] = wy * s; _qq[2] = wz * s; _qq[3] = Math.cos(a / 2);
  qMul(pose.rot, bone * 4, _qq, 0, pose.rot, bone * 4);
}

type SpringDef = NonNullable<AnimGraph['springs']>[string];

class Chain {
  readonly bones: Int16Array;
  readonly w: Float64Array;
  readonly v: Float64Array;
  /** Rest direction of each bone (towards the next one in the chain), in the bone's own frame. */
  readonly dir: Float64Array;
  readonly k: Float64Array;
  readonly c: number;
  readonly drive: number;
  readonly limit: number;
  private primed = false;
  private readonly pos = new Float64Array(3);
  private readonly vel = new Float64Array(3);
  private readonly acc = new Float64Array(3);

  constructor(sk: Skeleton, bones: number[], def: SpringDef) {
    const n = bones.length;
    this.bones = Int16Array.from(bones);
    this.w = new Float64Array(n * 3);
    this.v = new Float64Array(n * 3);
    this.dir = new Float64Array(n * 3);
    this.k = new Float64Array(n);
    const stiff = def.stiffness ?? 120, fall = def.falloff ?? 0.8;
    this.c = def.damping ?? 7;
    this.drive = def.drive ?? 0.05;
    this.limit = ((def.limitDeg ?? 70) * Math.PI) / 180;
    for (let i = 0; i < n; i++) {
      this.k[i] = stiff * Math.pow(fall, i);
      // Towards the next bone of the chain; the tip keeps the direction of the one before it. A chain that hangs has -y.
      const from = bones[i]!, to = i + 1 < n ? bones[i + 1]! : -1;
      let dx = 0, dy = -1, dz = 0;
      if (to >= 0) { dx = sk.rest[to * 3]!; dy = sk.rest[to * 3 + 1]!; dz = sk.rest[to * 3 + 2]!; }
      else if (i > 0) { dx = this.dir[(i - 1) * 3]!; dy = this.dir[(i - 1) * 3 + 1]!; dz = this.dir[(i - 1) * 3 + 2]!; }
      else { dx = sk.rest[from * 3]!; dy = sk.rest[from * 3 + 1]!; dz = sk.rest[from * 3 + 2]!; }
      const l = Math.hypot(dx, dy, dz);
      if (l < 1e-9) { dx = 0; dy = -1; dz = 0; } else { dx /= l; dy /= l; dz /= l; }
      this.dir[i * 3] = dx; this.dir[i * 3 + 1] = dy; this.dir[i * 3 + 2] = dz;
    }
  }

  reset(): void {
    this.w.fill(0); this.v.fill(0); this.primed = false;
  }

  step(dt: number, sk: Skeleton, pose: Pose, mq: Float64Array, mp: Float64Array, nodeM: Matrix4): void {
    const b0 = this.bones[0]!;
    _pw[0] = mp[b0 * 3]!; _pw[1] = mp[b0 * 3 + 1]!; _pw[2] = mp[b0 * 3 + 2]!;
    const e = nodeM.elements;
    // World position of the chain's root joint (the node's matrix on the joint's model-space position).
    const x = e[0]! * _pw[0]! + e[4]! * _pw[1]! + e[8]! * _pw[2]! + e[12]!;
    const y = e[1]! * _pw[0]! + e[5]! * _pw[1]! + e[9]! * _pw[2]! + e[13]!;
    const z = e[2]! * _pw[0]! + e[6]! * _pw[1]! + e[10]! * _pw[2]! + e[14]!;
    if (!this.primed) {
      this.pos[0] = x; this.pos[1] = y; this.pos[2] = z;
      this.vel.fill(0); this.acc.fill(0);
      this.primed = true;
    } else if (dt > 1e-6) {
      const f = Math.min(1, dt * 35);
      let ax = 0, ay = 0, az = 0;
      const vx = (x - this.pos[0]!) / dt, vy = (y - this.pos[1]!) / dt, vz = (z - this.pos[2]!) / dt;
      ax = (vx - this.vel[0]!) / dt; ay = (vy - this.vel[1]!) / dt; az = (vz - this.vel[2]!) / dt;
      const m = Math.hypot(ax, ay, az);
      if (m > 120) { const s = 120 / m; ax *= s; ay *= s; az *= s; }
      this.vel[0] = vx; this.vel[1] = vy; this.vel[2] = vz;
      this.pos[0] = x; this.pos[1] = y; this.pos[2] = z;
      this.acc[0] = this.acc[0]! + (ax - this.acc[0]!) * f;
      this.acc[1] = this.acc[1]! + (ay - this.acc[1]!) * f;
      this.acc[2] = this.acc[2]! + (az - this.acc[2]!) * f;
    }
    const n = this.bones.length;
    const sub = dt > 1 / 60 ? Math.min(4, Math.ceil(dt * 60)) : 1;
    const h = dt / sub;
    for (let i = 0; i < n; i++) {
      const bone = this.bones[i]!;
      const p = sk.parent[bone]!;
      // The acceleration in the frame the bone hangs in: the node's, then its parent bone's.
      if (p >= 0) qMul(_wr, 0, _nqa, 0, mq, p * 4); else { _wr[0] = _nqa[0]!; _wr[1] = _nqa[1]!; _wr[2] = _nqa[2]!; _wr[3] = _nqa[3]!; }
      _wr[0] = -_wr[0]!; _wr[1] = -_wr[1]!; _wr[2] = -_wr[2]!;
      qRotate(_wr, 0, this.acc[0]!, this.acc[1]!, this.acc[2]!, _la, 0);
      // Where the bone's tip must go to trail the acceleration, as a rotation: direction x (-acceleration) x drive.
      const dx = this.dir[i * 3]!, dy = this.dir[i * 3 + 1]!, dz = this.dir[i * 3 + 2]!;
      const nx = -_la[0]!, ny = -_la[1]!, nz = -_la[2]!;
      const tx = (dy * nz - dz * ny) * this.drive, ty = (dz * nx - dx * nz) * this.drive, tz = (dx * ny - dy * nx) * this.drive;
      const k = this.k[i]!;
      for (let s = 0; s < sub; s++) {
        for (let q = 0; q < 3; q++) {
          const target = q === 0 ? tx : q === 1 ? ty : tz;
          const j = i * 3 + q;
          this.v[j] = this.v[j]! + (k * (target - this.w[j]!) - this.c * this.v[j]!) * h;
          this.w[j] = this.w[j]! + this.v[j]! * h;
        }
      }
      const m = Math.hypot(this.w[i * 3]!, this.w[i * 3 + 1]!, this.w[i * 3 + 2]!);
      if (m > this.limit) {
        const s = this.limit / m;
        this.w[i * 3] = this.w[i * 3]! * s; this.w[i * 3 + 1] = this.w[i * 3 + 1]! * s; this.w[i * 3 + 2] = this.w[i * 3 + 2]! * s;
      }
      addRotation(pose, bone, this.w[i * 3]!, this.w[i * 3 + 1]!, this.w[i * 3 + 2]!);
    }
  }

  /** Lays the current swing over the pose without moving it on. */
  hold(pose: Pose): void {
    for (let i = 0; i < this.bones.length; i++) addRotation(pose, this.bones[i]!, this.w[i * 3]!, this.w[i * 3 + 1]!, this.w[i * 3 + 2]!);
  }
}

/** The spring chains of a character. */
export class Springs {
  private readonly chains: Chain[] = [];
  private readonly mq: Float64Array;
  private readonly mp: Float64Array;

  constructor(private readonly sk: Skeleton, defs: AnimGraph['springs'], where: string, problem: (m: string) => void) {
    this.mq = new Float64Array(sk.n * 4);
    this.mp = new Float64Array(sk.n * 3);
    for (const [name, d] of Object.entries(defs ?? {})) {
      const bones: number[] = [];
      d.chain.forEach((b, i) => {
        const bi = sk.index(b);
        if (bi < 0) problem(`${where}/springs/${name}/chain/${i}: the body has no bone "${b}"; it is left out.`);
        else bones.push(bi);
      });
      if (bones.length > 0) this.chains.push(new Chain(sk, bones, d));
    }
  }

  get count(): number {
    return this.chains.length;
  }

  reset(): void {
    for (const c of this.chains) c.reset();
  }

  /** Advances every chain by `dt` and lays it over `pose`. `node` is the character's node: its movement in the world is what the chains trail. */
  update(dt: number, pose: Pose, node: Object3D): void {
    if (this.chains.length === 0) return;
    if (dt <= 0) { for (const c of this.chains) c.hold(pose); return; }
    node.updateWorldMatrix(true, false);
    node.getWorldQuaternion(_nq);
    _nqa[0] = _nq.x; _nqa[1] = _nq.y; _nqa[2] = _nq.z; _nqa[3] = _nq.w;
    this.sk.fk(pose, this.mq, this.mp);
    for (const c of this.chains) c.step(dt, this.sk, pose, this.mq, this.mp, node.matrixWorld);
  }
}

type HitDef = NonNullable<AnimGraph['hitReact']>;

const DEFAULT_FLINCH: Record<string, number> = { hips: 0.1, spine: 0.25, chest: 0.3, neck: 0.2, head: 0.25 };

/** A flinch: a lean away from a blow, as a damped spring along the direction of the blow, spread over a few bones. */
export class HitReact {
  private readonly bones: Int16Array;
  private readonly share: Float64Array;
  private readonly hips: number;
  private readonly angle: number;
  private readonly shift: number;
  private readonly k: number;
  private readonly c: number;
  // Displacement and velocity along the model's x and z.
  private px = 0; private pz = 0; private vx = 0; private vz = 0;

  constructor(sk: Skeleton, def: HitDef | undefined, where: string, problem: (m: string) => void) {
    const bones: number[] = [], share: number[] = [];
    for (const [b, s] of Object.entries(def?.bones ?? DEFAULT_FLINCH)) {
      const bi = sk.index(b);
      if (bi < 0) { if (def?.bones) problem(`${where}/hitReact/bones/${b}: the body has no bone "${b}"; it is left out.`); continue; }
      bones.push(bi); share.push(s);
    }
    this.bones = Int16Array.from(bones);
    this.share = Float64Array.from(share);
    this.hips = sk.index('hips');
    this.angle = def?.angle ?? 0.35;
    this.shift = (def?.shift ?? 0.05) * sk.scale;
    this.k = def?.stiffness ?? 220;
    this.c = def?.damping ?? 16;
  }

  get active(): boolean {
    return Math.abs(this.px) + Math.abs(this.pz) + Math.abs(this.vx) * 0.05 + Math.abs(this.vz) * 0.05 > 1e-4;
  }

  /** A blow along (dx, dz) in the model's frame, `strength` 1 being a firm hit. */
  kick(dx: number, dz: number, strength: number): void {
    const l = Math.hypot(dx, dz);
    if (l < 1e-9) return;
    const s = (24 * strength) / l;
    this.vx += dx * s; this.vz += dz * s;
  }

  reset(): void {
    this.px = 0; this.pz = 0; this.vx = 0; this.vz = 0;
  }

  update(dt: number, pose: Pose): void {
    if (!this.active) return;
    if (dt > 0) {
      const sub = dt > 1 / 60 ? Math.min(4, Math.ceil(dt * 60)) : 1;
      const h = dt / sub;
      for (let s = 0; s < sub; s++) {
        this.vx += (-this.k * this.px - this.c * this.vx) * h; this.vz += (-this.k * this.pz - this.c * this.vz) * h;
        this.px += this.vx * h; this.pz += this.vz * h;
      }
      this.px = clamp(this.px, -1.5, 1.5); this.pz = clamp(this.pz, -1.5, 1.5);
    }
    // The top of a bone that points up moves along the blow when it turns about (up x blow).
    for (let i = 0; i < this.bones.length; i++) {
      const a = this.angle * this.share[i]!;
      addRotation(pose, this.bones[i]!, this.pz * a, 0, -this.px * a);
    }
    if (this.hips >= 0) {
      pose.off[this.hips * 3] = pose.off[this.hips * 3]! + this.px * this.shift;
      pose.off[this.hips * 3 + 2] = pose.off[this.hips * 3 + 2]! + this.pz * this.shift;
    }
  }
}
