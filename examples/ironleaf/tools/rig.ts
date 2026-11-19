// Move authoring for Ironleaf: key a pose by what the eye sees (where the hands and feet are, how the body leans), solve it
// with the engine's own two-bone IK against the character's skeleton, and write plain Euler keys into an anim-set.
// Run through `pnpm tsx examples/ironleaf/tools/build-anims.ts`; the output is config/anim-set/*.json.
// Coordinates: [r, u, f] = right, up, forward in metres (the skeleton's own axes are x right, y up, -z forward).
// Angles [lean, turn, roll]: lean forward, turn right, roll to the right, in radians.
import { readFileSync } from 'node:fs';
import { buildBody, Pose, type Skeleton } from '../../../packages/hull/src/anim/index.ts';
import { twoBone } from '../../../packages/hull/src/anim/ik.ts';
import { qFromEuler, qFromTo, qMul, qMulInv, qRotate } from '../../../packages/hull/src/anim/math.ts';

export type V3 = [number, number, number];
export type Ease = 'smooth' | 'linear' | 'in' | 'out' | 'snap' | 'hold';

/** One pose to solve. Every field is optional in a key: it keeps the value of the key before it. */
export interface Frame {
  hips: V3; hipsR: V3; spine: V3; chest: V3; neck: V3; head: V3;
  /** Right wrist, from the hips joint. */
  hand: V3;
  /** Blade direction, from the hand toward the tip. */
  blade: V3;
  roll: number;
  /** 'grip': the left wrist sits on the hilt. Otherwise a wrist position from the hips joint. */
  left: 'grip' | V3;
  /** Left hand's own blade-like axis when free (the way its fingers point); default straight down the forearm. */
  leftDir: V3 | null;
  /** Ankles: [r, height above ground, f] in the clip's own frame (planted feet stay put while the hips travel). */
  footL: V3; footR: V3;
  footPitchL: number; footPitchR: number; footTurnL: number; footTurnR: number;
  /** Where the elbows and knees point, from the shoulder or hip. */
  elbR: V3; elbL: V3; kneeR: V3; kneeL: V3;
}
export type Compiled = Map<string, { t: number[]; v: unknown[]; e: (Ease | undefined)[] }>;
export type Key = Partial<Frame> & { t: number; ease?: Ease };

const norm = (v: V3): V3 => { const n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };
const mix = (a: number, b: number, k: number): number => a + (b - a) * k;
const mix3 = (a: V3, b: V3, k: number): V3 => [mix(a[0], b[0], k), mix(a[1], b[1], k), mix(a[2], b[2], k)];
export function easeK(e: Ease | undefined, k: number): number {
  switch (e ?? 'smooth') {
    case 'linear': return k;
    case 'in': return Math.pow(k, 2.3);
    case 'out': return 1 - Math.pow(1 - k, 2.3);
    case 'snap': return 1 - Math.pow(1 - k, 4);
    case 'hold': return k >= 1 ? 1 : 0;
    default: return k * k * (3 - 2 * k);
  }
}
export class Rig {
  readonly sk: Skeleton;
  readonly names: string[];
  private readonly pose: Pose;
  private readonly mq: Float64Array;
  private readonly mp: Float64Array;
  private readonly ix: Record<string, number> = {};
  private readonly q = new Float64Array(8);
  private readonly v = new Float64Array(3);
  readonly dims: Record<string, number>;
  /** Blade tip distance along the blade from the hand (metres). */
  tipLen: number;
  baseLen: number;

  constructor(charFile: string, tip = 0.91, base = 0.14) {
    const c = JSON.parse(readFileSync(charFile, 'utf8'));
    this.sk = buildBody(c.body).skeleton;
    this.names = this.sk.names;
    this.names.forEach((n, i) => (this.ix[n] = i));
    this.pose = new Pose(this.sk.n);
    this.mq = new Float64Array(this.sk.n * 4);
    this.mp = new Float64Array(this.sk.n * 3);
    this.dims = (this.sk.dims ?? {}) as unknown as Record<string, number>;
    this.tipLen = tip; this.baseLen = base;
  }

  /** The standing pose of a fighter: the frame every move's first key inherits. */
  stand(over: Partial<Frame> = {}): Frame {
    const d = this.dims;
    const hx = d.hipX ?? 0.08;
    const f: Frame = {
      hips: [0, 0, 0], hipsR: [0, 0, 0], spine: [0, 0, 0], chest: [0, 0, 0], neck: [0, 0, 0], head: [0, 0, 0],
      hand: [0.12, 0.3, 0.45], blade: [0, 0.55, 0.83], roll: 0, left: 'grip', leftDir: null,
      footL: [-hx - 0.1, d.footH ?? 0.075, 0], footR: [hx + 0.1, d.footH ?? 0.075, 0],
      footPitchL: 0, footPitchR: 0, footTurnL: 0, footTurnR: 0,
      elbR: [0.35, -0.5, -0.25], elbL: [-0.35, -0.5, -0.25], kneeR: [0.12, -0.1, 0.6], kneeL: [-0.12, -0.1, 0.6],
    };
    return { ...f, ...over };
  }

  /** Sorts the keys into one timeline per field: a key only moves the fields it names, and eases the way into them. */
  resolve(base: Frame, keys: Key[]): Compiled {
    const lines = new Map<string, { t: number[]; v: unknown[]; e: (Ease | undefined)[] }>();
    for (const f of Object.keys(base) as (keyof Frame)[]) lines.set(f, { t: [0], v: [base[f]], e: [undefined] });
    for (const k of keys) {
      for (const [f, v] of Object.entries(k)) {
        if (f === 't' || f === 'ease') continue;
        const ln = lines.get(f);
        if (!ln) throw new Error('unknown field ' + f);
        if (k.t <= 0 && ln.t.length === 1 && ln.t[0] === 0) { ln.v[0] = v; continue; }
        ln.t.push(k.t); ln.v.push(v); ln.e.push(k.ease);
      }
    }
    return lines;
  }

  frameAt(res: Compiled, t: number): Frame {
    const o: Record<string, unknown> = {};
    for (const [f, ln] of res) {
      const n = ln.t.length;
      let val: unknown = ln.v[n - 1];
      if (t <= ln.t[0]!) val = ln.v[0];
      else for (let i = 1; i < n; i++) {
        if (t <= ln.t[i]! + 1e-9) {
          const k = (t - ln.t[i - 1]!) / Math.max(1e-9, ln.t[i]! - ln.t[i - 1]!);
          const x = ln.v[i - 1], y = ln.v[i];
          const ek = easeK(ln.e[i], k);
          if (typeof x === 'number') val = mix(x, y as number, ek);
          else if (Array.isArray(x) && Array.isArray(y)) val = f === 'blade' ? norm(mix3(x as V3, y as V3, ek)) : mix3(x as V3, y as V3, ek);
          else if (x === 'grip' && y === 'grip') val = 'grip';
          else val = ek < 1 ? x : y;
          break;
        }
      }
      o[f] = val;
    }
    return o as unknown as Frame;
  }

  /** Solves a frame. Fills pose, mq and mp (model space, clip frame: the hips offset is in them). */
  solve(f: Frame): void {
    const { sk, pose, mq, mp, ix } = this;
    const d = this.dims;
    pose.setRest();
    const E = (name: string, a: V3): void => pose.setEuler(ix[name]!, -a[0], -a[1], -a[2]);
    pose.setOffset(ix.hips!, f.hips[0], f.hips[1], -f.hips[2]);
    E('hips', f.hipsR); E('spine', f.spine); E('chest', f.chest); E('neck', f.neck); E('head', f.head);
    sk.fk(pose, mq, mp, 0);
    const hx = mp[ix.hips! * 3]!, hy = mp[ix.hips! * 3 + 1]!, hz = mp[ix.hips! * 3 + 2]!;
    const pivot = (p: V3): V3 => [hx + p[0], hy + p[1], hz - p[2]];
    // Legs first so the hips never drag the feet.
    for (const side of ['L', 'R'] as const) {
      const a = ix['leg' + side]!, b = ix['shin' + side]!, c = ix['foot' + side]!;
      const t = side === 'L' ? f.footL : f.footR;
      const kn = side === 'L' ? f.kneeL : f.kneeR;
      twoBone(sk, pose, mq, mp, a, b, c, t[0], t[1], -t[2], mp[a * 3]! + kn[0], mp[a * 3 + 1]! + kn[1], mp[a * 3 + 2]! - kn[2]);
      // Foot flat on the ground, turned and pitched as asked.
      const turn = side === 'L' ? f.footTurnL : f.footTurnR;
      const pitch = side === 'L' ? f.footPitchL : f.footPitchR;
      const q = this.q;
      qFromEuler(q, 0, pitch, -turn, 0);
      this.setModelRot(c, q, 0);
    }
    // Arms.
    const handPos = pivot(f.hand);
    const bd = norm(f.blade);
    const bladeD: V3 = [bd[0], bd[1], -bd[2]];
    const aimR = ix.handR!;
    const sA = ix.armR!, sB = ix.forearmR!;
    twoBone(sk, pose, mq, mp, sA, sB, aimR, handPos[0], handPos[1], handPos[2], mp[sA * 3]! + f.elbR[0], mp[sA * 3 + 1]! + f.elbR[1], mp[sA * 3 + 2]! - f.elbR[2]);
    this.aimHand(aimR, bladeD, f.roll);
    let lt: V3, ld: V3 | null;
    if (f.left === 'grip') { lt = [handPos[0] - bladeD[0] * 0.13, handPos[1] - bladeD[1] * 0.13, handPos[2] - bladeD[2] * 0.13]; ld = bladeD; }
    else { lt = pivot(f.left); ld = f.leftDir ? [f.leftDir[0], f.leftDir[1], -f.leftDir[2]] : null; }
    const lA = ix.armL!, lB = ix.forearmL!, lC = ix.handL!;
    twoBone(sk, pose, mq, mp, lA, lB, lC, lt[0], lt[1], lt[2], mp[lA * 3]! + f.elbL[0], mp[lA * 3 + 1]! + f.elbL[1], mp[lA * 3 + 2]! - f.elbL[2]);
    if (ld) this.aimHand(lC, ld, f.roll);
  }

  private setModelRot(bone: number, q: Float64Array, o: number): void {
    const { sk, pose, mq, mp } = this;
    for (let k = 0; k < 4; k++) mq[bone * 4 + k] = q[o + k]!;
    const p = sk.parent[bone]!;
    qMulInv(pose.rot, bone * 4, mq, p * 4, mq, bone * 4);
    pose.cov[bone] = 1;
    sk.fk(pose, mq, mp, bone);
  }

  /** Turns a hand so its -Y points along d (model space), then rolls it about d. */
  private aimHand(bone: number, d: V3, roll: number): void {
    const { mq, v, q } = this;
    qRotate(mq, bone * 4, 0, -1, 0, v, 0);
    qFromTo(q, 0, v[0]!, v[1]!, v[2]!, d[0], d[1], d[2]);
    qMul(q, 4, q, 0, mq, bone * 4);
    if (roll) {
      const h = roll / 2, s = Math.sin(h);
      const r = new Float64Array([d[0] * s, d[1] * s, d[2] * s, Math.cos(h)]);
      qMul(q, 4, r, 0, q, 4);
    }
    this.setModelRot(bone, q, 4);
  }

  /** The solved pose as Euler XYZ per bone (radians) and the hips offset. */
  euler(into: Record<string, V3>): V3 {
    const { pose, ix } = this;
    for (const n of Object.keys(into)) {
      const i = ix[n]!;
      const x = pose.rot[i * 4]!, y = pose.rot[i * 4 + 1]!, z = pose.rot[i * 4 + 2]!, w = pose.rot[i * 4 + 3]!;
      const m11 = 1 - 2 * (y * y + z * z), m12 = 2 * (x * y - z * w), m13 = 2 * (x * z + y * w);
      const m22 = 1 - 2 * (x * x + z * z), m23 = 2 * (y * z - x * w), m33 = 1 - 2 * (x * x + y * y);
      const ey = Math.asin(Math.max(-1, Math.min(1, m13)));
      let ex: number, ez: number;
      if (Math.abs(m13) < 0.999999) { ex = Math.atan2(-m23, m33); ez = Math.atan2(-m12, m11); }
      else { ex = Math.atan2(2 * (y * z + x * w), m22); ez = 0; }
      into[n] = [ex, ey, ez];
    }
    return [pose.off[ix.hips! * 3]!, pose.off[ix.hips! * 3 + 1]!, pose.off[ix.hips! * 3 + 2]!];
  }

  /** Model-space position of a bone joint after solve(). */
  at(name: string): V3 { const i = this.ix[name]!; return [this.mp[i * 3]!, this.mp[i * 3 + 1]!, this.mp[i * 3 + 2]!]; }
  /** Blade base and tip in model space after solve(), from the hand's -Y axis. */
  blade(): { base: V3; tip: V3 } {
    const i = this.ix.handR!;
    qRotate(this.mq, i * 4, 0, -1, 0, this.v, 0);
    const p = this.at('handR'), v = this.v;
    return { base: [p[0] + v[0]! * this.baseLen, p[1] + v[1]! * this.baseLen, p[2] + v[2]! * this.baseLen], tip: [p[0] + v[0]! * this.tipLen, p[1] + v[1]! * this.tipLen, p[2] + v[2]! * this.tipLen] };
  }
}
