// Skeletons and poses. A skeleton is a list of bones, parents first, each with a rest offset from its parent and a
// rest rotation of identity. A pose is what an animation changes: a rotation and an offset per bone, plus how much
// of the bone the pose covers (so a clip that only moves an arm does not pull the legs back to rest).
import type { Character, CharacterPart } from '../schema/character.ts';
import { qFromEuler, qIdentity, qMul, qNlerp, qRotate, type Arr } from './math.ts';

export const REF_HEIGHT = 1.78;

export class Skeleton {
  readonly n: number;
  readonly names: string[];
  readonly parent: Int16Array;
  /** Rest offset from the parent, 3 numbers per bone, in metres. */
  readonly rest: Float64Array;
  /** Lengths in a humanoid, zero for a custom skeleton. Used by IK defaults and by the gait generators. */
  readonly dims: HumanoidDims | null;
  /** Height over 1.78 m: clip offsets and gait lengths are authored for the reference body and scale by this. */
  readonly scale: number;
  private readonly lookup = new Map<string, number>();

  constructor(names: string[], parent: number[], rest: number[], scale: number, dims: HumanoidDims | null) {
    this.n = names.length;
    this.names = names;
    this.parent = Int16Array.from(parent);
    this.rest = Float64Array.from(rest);
    this.scale = scale;
    this.dims = dims;
    names.forEach((nm, i) => this.lookup.set(nm, i));
  }

  index(name: string): number {
    return this.lookup.get(name) ?? -1;
  }

  /** 1 for the bone and everything below it. */
  subtree(name: string, into?: Uint8Array): Uint8Array {
    const m = into ?? new Uint8Array(this.n);
    const root = this.index(name);
    if (root < 0) return m;
    m[root] = 1;
    for (let i = root + 1; i < this.n; i++) if (m[this.parent[i]!] === 1) m[i] = 1;
    return m;
  }

  /** Model-space rotation and position of every bone from `start` on, given a pose. Bones before `start` are kept. */
  fk(pose: Pose, mq: Arr, mp: Arr, start = 0): void {
    const par = this.parent;
    for (let i = start; i < this.n; i++) {
      const lx = this.rest[i * 3]! + pose.off[i * 3]!;
      const ly = this.rest[i * 3 + 1]! + pose.off[i * 3 + 1]!;
      const lz = this.rest[i * 3 + 2]! + pose.off[i * 3 + 2]!;
      const p = par[i]!;
      if (p < 0) {
        mp[i * 3] = lx; mp[i * 3 + 1] = ly; mp[i * 3 + 2] = lz;
        mq[i * 4] = pose.rot[i * 4]!; mq[i * 4 + 1] = pose.rot[i * 4 + 1]!; mq[i * 4 + 2] = pose.rot[i * 4 + 2]!; mq[i * 4 + 3] = pose.rot[i * 4 + 3]!;
      } else {
        qRotate(mq, p * 4, lx, ly, lz, mp, i * 3);
        mp[i * 3] = mp[i * 3]! + mp[p * 3]!;
        mp[i * 3 + 1] = mp[i * 3 + 1]! + mp[p * 3 + 1]!;
        mp[i * 3 + 2] = mp[i * 3 + 2]! + mp[p * 3 + 2]!;
        qMul(mq, i * 4, mq, p * 4, pose.rot, i * 4);
      }
    }
  }
}

export class Pose {
  readonly n: number;
  readonly rot: Float64Array;
  readonly off: Float64Array;
  /** 0 to 1 per bone: how much this pose says about the bone. */
  readonly cov: Float64Array;

  constructor(n: number) {
    this.n = n;
    this.rot = new Float64Array(n * 4);
    this.off = new Float64Array(n * 3);
    this.cov = new Float64Array(n);
    this.clear();
  }

  clear(): void {
    for (let i = 0; i < this.n; i++) qIdentity(this.rot, i * 4);
    this.off.fill(0);
    this.cov.fill(0);
  }

  /** Rest pose with full coverage: the bottom of every layer stack. */
  setRest(): void {
    this.clear();
    this.cov.fill(1);
  }

  setEuler(i: number, x: number, y: number, z: number): void {
    qFromEuler(this.rot, i * 4, x, y, z);
    this.cov[i] = 1;
  }

  setOffset(i: number, x: number, y: number, z: number): void {
    this.off[i * 3] = x; this.off[i * 3 + 1] = y; this.off[i * 3 + 2] = z;
    this.cov[i] = 1;
  }

  copyFrom(o: Pose): void {
    this.rot.set(o.rot); this.off.set(o.off); this.cov.set(o.cov);
  }
}

/**
 * Adds `src` into `dst` with weight w. `dst.cov` holds the weight gathered so far, so a bone the source does not
 * cover takes nothing from it. When the weights over all sources add to 1 the result is the weighted blend.
 */
export function accumulate(dst: Pose, src: Pose, w: number): void {
  if (w <= 0) return;
  for (let i = 0; i < dst.n; i++) {
    const add = src.cov[i]! * w;
    if (add <= 0) continue;
    const have = dst.cov[i]!;
    if (have <= 0) {
      for (let k = 0; k < 4; k++) dst.rot[i * 4 + k] = src.rot[i * 4 + k]!;
      for (let k = 0; k < 3; k++) dst.off[i * 3 + k] = src.off[i * 3 + k]!;
    } else {
      const t = add / (have + add);
      qNlerp(dst.rot, i * 4, dst.rot, i * 4, src.rot, i * 4, t);
      for (let k = 0; k < 3; k++) dst.off[i * 3 + k] = dst.off[i * 3 + k]! + (src.off[i * 3 + k]! - dst.off[i * 3 + k]!) * t;
    }
    dst.cov[i] = have + add;
  }
}

const zero = new Float64Array([0, 0, 0, 1]);

/** Lays a layer over `out`: replaces (or, if additive, adds to) the bones it covers, scaled by coverage, mask and weight. */
export function composite(out: Pose, layer: Pose, mask: Uint8Array | null, weight: number, additive: boolean): void {
  for (let i = 0; i < out.n; i++) {
    const c = layer.cov[i]! * weight * (mask === null ? 1 : mask[i]!);
    if (c <= 0) continue;
    if (additive) {
      qNlerp(scratchQ, 0, zero, 0, layer.rot, i * 4, c);
      qMul(out.rot, i * 4, out.rot, i * 4, scratchQ, 0);
      for (let k = 0; k < 3; k++) out.off[i * 3 + k] = out.off[i * 3 + k]! + layer.off[i * 3 + k]! * c;
    } else {
      qNlerp(out.rot, i * 4, out.rot, i * 4, layer.rot, i * 4, c);
      for (let k = 0; k < 3; k++) out.off[i * 3 + k] = out.off[i * 3 + k]! + (layer.off[i * 3 + k]! - out.off[i * 3 + k]!) * c;
    }
  }
}
const scratchQ = new Float64Array(4);

// ---------------------------------------------------------------------------------------------------------
// The humanoid recipe

export interface HumanoidDims {
  height: number;
  shoulders: number;
  head: number;
  hipY: number;
  legLen: number;
  thigh: number;
  shin: number;
  footH: number;
  footLen: number;
  hipX: number;
  spineLen: number;
  chestLen: number;
  neckLen: number;
  upperArm: number;
  foreArm: number;
  hand: number;
  armX: number;
  armY: number;
  build: number;
}

type Proportions = NonNullable<Character['body']['proportions']>;

export function humanoidDims(p: Proportions | undefined, scale = 1): HumanoidDims {
  const H = (p?.height ?? REF_HEIGHT) * scale;
  const build = p?.build ?? 1;
  const headH = (p?.head ?? 0.129 * (p?.height ?? REF_HEIGHT)) * scale;
  const W = (p?.shoulders ?? 0.247 * (p?.height ?? REF_HEIGHT)) * scale;
  const legLen = (p?.legs ?? 0.52) * H;
  const footH = 0.045 * H;
  const neckLen = 0.35 * headH;
  const neckBase = H - headH - neckLen;
  const hipY = legLen;
  const torso = neckBase - hipY;
  const armTotal = (p?.arms ?? 0.37) * H;
  return {
    height: H, shoulders: W, head: headH, hipY, legLen,
    thigh: (legLen - footH) * 0.5, shin: (legLen - footH) * 0.5, footH, footLen: 0.15 * H,
    hipX: W * 0.2,
    spineLen: torso * 0.42, chestLen: torso * 0.58, neckLen,
    upperArm: armTotal * 0.46, foreArm: armTotal * 0.4, hand: armTotal * 0.14,
    armX: W * 0.5 - 0.03 * H * build,
    armY: torso * 0.58 - 0.04 * H,
    build,
  };
}

export interface BuiltBody {
  skeleton: Skeleton;
  parts: CharacterPart[];
}

const Y = (y: number): [number, number, number] => [0, y, 0];

/** Bones and parts from a character's body. Throws a sentence naming the field if a custom bone list is wrong. */
export function buildBody(body: Character['body'], at = 'body'): BuiltBody {
  const scale = body.scale ?? 1;
  const custom = body.recipe === 'custom';
  const names: string[] = [];
  const parent: number[] = [];
  const rest: number[] = [];
  const add = (name: string, par: string | null, x: number, y: number, z: number): void => {
    const pi = par === null ? -1 : names.indexOf(par);
    if (par !== null && pi < 0) throw new Error(`${at}: bone "${name}" names parent "${par}", which is not an earlier bone`);
    if (names.includes(name)) throw new Error(`${at}: bone "${name}" is listed twice`);
    names.push(name); parent.push(pi); rest.push(x, y, z);
  };
  const parts: CharacterPart[] = [];
  let dims: HumanoidDims | null = null;
  let refScale = scale;

  if (!custom) {
    const d = humanoidDims(body.proportions, scale);
    dims = d;
    refScale = d.height / REF_HEIGHT;
    add('hips', null, 0, d.hipY, 0);
    add('spine', 'hips', 0, 0, 0);
    add('chest', 'spine', 0, d.spineLen, 0);
    add('neck', 'chest', 0, d.chestLen, 0);
    add('head', 'neck', 0, d.neckLen, 0);
    for (const [side, sx] of [['L', -1], ['R', 1]] as const) {
      add(`arm${side}`, 'chest', sx * d.armX, d.armY, 0);
      add(`forearm${side}`, `arm${side}`, 0, -d.upperArm, 0);
      add(`hand${side}`, `forearm${side}`, 0, -d.foreArm, 0);
    }
    for (const [side, sx] of [['L', -1], ['R', 1]] as const) {
      add(`leg${side}`, 'hips', sx * d.hipX, 0, 0);
      add(`shin${side}`, `leg${side}`, 0, -d.thigh, 0);
      add(`foot${side}`, `shin${side}`, 0, -d.shin, 0);
    }
    parts.push(...humanoidParts(d));
  } else {
    if (!body.bones?.length) throw new Error(`${at}/bones: a custom body needs at least one bone`);
    for (const b of body.bones) add(b.name, b.parent ?? null, b.offset[0] * scale, b.offset[1] * scale, b.offset[2] * scale);
  }
  for (const p of body.parts ?? []) {
    if (!names.includes(p.bone)) throw new Error(`${at}/parts: part names bone "${p.bone}", which the body does not have`);
    parts.push(scaleCustomPart(p, custom ? scale : 1));
  }
  return { skeleton: new Skeleton(names, parent, rest, refScale, dims), parts };
}

function scaleCustomPart(p: CharacterPart, s: number): CharacterPart {
  if (s === 1) return p;
  const v = (a: readonly number[] | undefined): [number, number, number] | undefined => (a ? [a[0]! * s, a[1]! * s, a[2]! * s] : undefined);
  const out: CharacterPart = { ...p };
  const from = v(p.from), to = v(p.to), center = v(p.center), size = v(p.size);
  if (from) out.from = from;
  if (to) out.to = to;
  if (center) out.center = center;
  if (size) out.size = size;
  if (p.radius !== undefined) out.radius = p.radius * s;
  if (p.radiusEnd !== undefined) out.radiusEnd = p.radiusEnd * s;
  return out;
}

/** What a humanoid is drawn with. Materials are named by role (skin, cloth, metal) and looked up on the character. */
function humanoidParts(d: HumanoidDims): CharacterPart[] {
  const H = d.height, B = d.build;
  const out: CharacterPart[] = [];
  const box = (bone: string, material: string, cy: number, sx: number, sy: number, sz: number, cz = 0): void => {
    out.push({ bone, shape: 'box', material, center: [0, cy, cz], size: [sx, sy, sz] });
  };
  const limb = (bone: string, material: string, len: number, r0: number, r1: number): void => {
    out.push({ bone, shape: 'limb', material, from: Y(0), to: Y(-len), radius: r0 * B, radiusEnd: r1 * B });
  };
  box('hips', 'cloth', 0, 0.165 * H * B, 0.1 * H, 0.105 * H * B);
  box('spine', 'cloth', d.spineLen * 0.5, 0.15 * H * B, d.spineLen + 0.01 * H, 0.1 * H * B);
  box('chest', 'cloth', d.chestLen * 0.5, d.shoulders * 0.78 * Math.sqrt(B), d.chestLen, 0.115 * H * B);
  out.push({ bone: 'neck', shape: 'limb', material: 'skin', from: Y(-0.01 * H), to: Y(d.neckLen + 0.01 * H), radius: 0.028 * H * B, radiusEnd: 0.026 * H * B });
  out.push({ bone: 'head', shape: 'sphere', material: 'skin', center: [0, d.head * 0.5, 0], size: [d.head * 0.78, d.head, d.head * 0.9] });
  for (const s of ['L', 'R']) {
    out.push({ bone: `arm${s}`, shape: 'sphere', material: 'cloth', center: [0, 0, 0], size: [0.07 * H * B, 0.07 * H * B, 0.07 * H * B] });
    limb(`arm${s}`, 'cloth', d.upperArm, 0.032 * H, 0.027 * H);
    limb(`forearm${s}`, 'cloth', d.foreArm, 0.027 * H, 0.021 * H);
    out.push({ bone: `hand${s}`, shape: 'sphere', material: 'skin', center: [0, -d.hand * 0.4, 0], size: [0.05 * H, d.hand * 1.1, 0.06 * H] });
    limb(`leg${s}`, 'cloth', d.thigh, 0.048 * H, 0.034 * H);
    limb(`shin${s}`, 'cloth', d.shin, 0.034 * H, 0.025 * H);
    out.push({ bone: `foot${s}`, shape: 'box', material: 'metal', center: [0, -d.footH * 0.5, -d.footLen * 0.28], size: [0.06 * H * B, d.footH, d.footLen] });
  }
  return out;
}
