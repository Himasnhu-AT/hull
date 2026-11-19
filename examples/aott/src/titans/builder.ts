// Procedural titan body geometry. Every joint's mesh is ONE merged, vertex-coloured BufferGeometry
// (skin, teeth, eyes, hair... all baked), cached per archetype and shared by every titan of that archetype.
// Local units: the model is built ~10 units tall (feet at y = 0, face towards +z, character-left = +x).
// Look: physically based skin (MeshStandardMaterial, roughness ~0.6) over a generated mottled skin texture and a
// matching normal map; the Behemoth is bare, wet, fibrous muscle with pale tendon sheets.
import * as THREE from 'hull/three';
import { mergeGeometries } from 'hull/three';
import { R } from '../sim';

const V3 = THREE.Vector3, V2 = THREE.Vector2, M4 = THREE.Matrix4, QT = THREE.Quaternion, EU = THREE.Euler;
type Vec3 = THREE.Vector3;
const _m = new M4(), _q = new QT(), _e = new EU(), _p = new V3(), _s = new V3(), _c = new THREE.Color();
const UPV = new V3(0, 1, 0);

export const SKINS = {
  pink: 0xeaa892, beige: 0xe2ae88, tan: 0xc98f68, pale: 0xeec4ac, ruddy: 0xe0937a, grey: 0xcaa894,
};
export const HAIRS = [0x1a120d, 0x2a1c12, 0x3b2a18, 0x0e0e12, 0x4a3a22, 0xd8bc74];   // (5: the Huntress's blonde)
const TEETH = 0xe2d8bc, GUM = 0x9a3e3c, MOUTH = 0x24090b, TONGUE = 0xa8505a, SCLERA = 0xe9dfcc, IRIS = 0x1d1815;

export type SkinKey = keyof typeof SKINS;
export type BuildKey = 'average' | 'lanky' | 'potbelly' | 'muscular' | 'gaunt' | 'female' | 'behemoth';
export type ExprKey = 'grin' | 'wide' | 'snarl' | 'behemoth' | 'huntress' | 'shifter';
export type SizeClass = 'S' | 'M' | 'L' | 'XL';

/** Body proportions per build (multipliers on the base dims). Flags: muscle (bare muscle overlays), ribs, female, behemoth. */
export interface Build {
  legs: number; arms: number; torsoW: number; torsoH: number; belly: number; limb: number; head: number;
  shoulder: number; neckW: number; faceW: number; faceH: number;
  muscle?: number; ribs?: number; female?: number; behemoth?: number;
}

export const BUILDS: Record<BuildKey, Build> = {
  average:  { legs: 1.00, arms: 1.00, torsoW: 1.00, torsoH: 1.00, belly: 0.35, limb: 1.00, head: 1.00, shoulder: 1.00, neckW: 1.0, faceW: 1.0, faceH: 1.0 },
  lanky:    { legs: 1.14, arms: 1.30, torsoW: 0.78, torsoH: 1.06, belly: 0.0,  limb: 0.70, head: 0.98, shoulder: 0.92, neckW: 0.8, faceW: 0.92, faceH: 1.08 },
  potbelly: { legs: 0.84, arms: 0.95, torsoW: 1.18, torsoH: 0.95, belly: 1.0,  limb: 1.12, head: 1.05, shoulder: 0.95, neckW: 1.2, faceW: 1.08, faceH: 0.95 },
  muscular: { legs: 0.96, arms: 1.06, torsoW: 1.30, torsoH: 1.02, belly: 0.0,  limb: 1.32, head: 0.92, shoulder: 1.22, neckW: 1.35, faceW: 1.0, faceH: 1.0, muscle: 1 },
  gaunt:    { legs: 1.12, arms: 1.22, torsoW: 0.72, torsoH: 1.08, belly: 0.0,  limb: 0.62, head: 1.0, shoulder: 0.9, neckW: 0.75, faceW: 0.9, faceH: 1.12, ribs: 1 },
  // the Huntress: tall, long-legged and lean, an athlete's build; bare muscle shows through on the shoulders, arms,
  // flanks and thighs (B.female picks the muscle colour and the chest)
  female:   { legs: 1.16, arms: 1.08, torsoW: 0.8,  torsoH: 1.0,  belly: 0.0,  limb: 0.86, head: 0.86, shoulder: 0.95, neckW: 0.82, faceW: 0.84, faceH: 1.06, muscle: 1, female: 1 },
  behemoth: { legs: 1.78, arms: 1.5, torsoW: 1.25, torsoH: 0.9, belly: 0.0,  limb: 1.2, head: 0.82, shoulder: 1.15, neckW: 1.15, faceW: 0.9, faceH: 1.22, muscle: 1, behemoth: 1 },
};

/** Facial expression preset. */
export interface Expr {
  open: number; smile: number; nT: number; tooth: number; eye: number; iris: number; lid: number; mouthW: number; brow: number;
  hairy?: number; noLips?: number; irisC?: number; bun?: number; sideLocks?: number; calm?: number; longHair?: number;
}

const EXPR: Record<ExprKey, Expr> = {
  grin:  { open: 0.07, smile: 0.30, nT: 11, tooth: 0.2, eye: 0.20, iris: 0.40, lid: 0.30, mouthW: 0.84, brow: 0.55, hairy: 1 },
  wide:  { open: 0.12, smile: 0.46, nT: 13, tooth: 0.22, eye: 0.235, iris: 0.34, lid: 0.10, mouthW: 0.94, brow: 0.0 },
  snarl: { open: 0.28, smile: 0.12, nT: 10, tooth: 0.26, eye: 0.245, iris: 0.30, lid: 0.0, mouthW: 0.82, brow: 0.8 },
  behemoth: { open: 0.10, smile: 0.16, nT: 15, tooth: 0.24, eye: 0.11, iris: 0.5, lid: 0.0, mouthW: 0.95, brow: 0.9, noLips: 1 },
  // the Huntress: a cold, level stare: steady blue eyes, a small closed mouth, short blonde hair with a fringe, a bun
  // at the back and two locks by the cheeks
  huntress: { open: 0.0, smile: 0.0, nT: 10, tooth: 0.1, eye: 0.15, iris: 0.52, lid: 0.42, mouthW: 0.4, brow: 0.3, irisC: 0x4f8fd6, bun: 1, sideLocks: 1, calm: 1 },
  // the shifter's giant: a glare under heavy brows, green eyes, a closed row of bared teeth, long dark hair
  shifter: { open: 0.04, smile: 0.02, nT: 12, tooth: 0.22, eye: 0.17, iris: 0.5, lid: 0.42, mouthW: 0.86, brow: 1.0, irisC: 0x2e9a62, longHair: 1 },
};

/** One titan design. `hair`: an index into HAIRS, or false for a bald head. */
export interface TitanSpec { build: BuildKey; skin: SkinKey; hair: number | false; expr: ExprKey; size?: SizeClass }

/** Rig dimensions (local units) derived from a build and a size class. */
export interface Dims {
  B: Build; build: BuildKey; size: SizeClass; headR: number;
  thighLen: number; shinLen: number; ankleH: number; hipY: number; hipX: number; spineY: number;
  shoulderX: number; shoulderY: number; neckY: number; neckLen: number; upperLen: number; foreLen: number;
  limb: number; handS: number; cy: number; cz: number; rx: number; ry: number; rz: number; headTop: number; total: number;
  jawPivot: Vec3; mouthLocal: Vec3; napeC: Vec3; napeHalf: Vec3;
}

/** A built joint mesh geometry. */
export interface PartGeo { full: THREE.BufferGeometry }
/** A forearm with the hand closed round a soldier, plus the grip centre (fore-local). */
export interface GripGeo extends PartGeo { centre: Vec3 }

export interface ArchGeo {
  pelvis: PartGeo; spine: PartGeo; head: PartGeo; jaw: PartGeo; arm: PartGeo;
  foreL: PartGeo; foreR: PartGeo; foreLFist: PartGeo; foreRFist: PartGeo;
  thigh: PartGeo; shin: PartGeo; foot: PartGeo;
  [grip: `grip${string}`]: GripGeo;
}

export type BoneKey = 'pelvis' | 'spine' | 'neck' | 'head' | 'jaw' | 'arm' | 'fore' | 'thigh' | 'shin' | 'foot';

export interface Archetype {
  key: string;
  dims: Dims;
  st: Expr;
  geo: ArchGeo;
  /** the shared body material (each titan wears a tinted copy, see bodyMaterial(…, tint)) */
  material: THREE.MeshStandardMaterial;
  behemoth: boolean;
  jawRest: number;
  skin: number;
  bones?: Record<BoneKey, THREE.BufferGeometry>;
}

// -------------------------------------------------------------------------------------------------------------
function mulberry(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const sm01 = (x: number) => { x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * (3 - 2 * x); };

type Tuple3 = readonly number[];
interface AddOpts {
  matrix?: THREE.Matrix4;
  rot?: Tuple3; pos?: Tuple3; scl?: Tuple3;
  fix?: (g: THREE.BufferGeometry) => void;
  /** how much downward-facing surfaces darken (baked ambient occlusion) */
  ao?: number;
  /** a detail part (teeth, eyes, lips, nostrils): not skin, samples the plain strip of the skin textures */
  detail?: boolean;
  /** joint crease: darken towards [yTop, bandTop, yBottom, bandBottom] (final local y) where a limb meets its neighbour */
  crease?: readonly [number, number, number, number];
  ws?: number; hs?: number; cs?: number; rs?: number;
}

/** Collects coloured primitives and merges them. `detailUV`: where detail parts point their UVs (null: leave them). */
class Parts {
  list: THREE.BufferGeometry[] = [];
  constructor(public detailUV: readonly [number, number] | null = null) {}
  add(geom: THREE.BufferGeometry, color: THREE.ColorRepresentation, o: AddOpts = {}): this {
    if (o.matrix) _m.copy(o.matrix);
    else {
      const r = o.rot || [0, 0, 0], p = o.pos || [0, 0, 0], s = o.scl || [1, 1, 1];
      _q.setFromEuler(_e.set(r[0], r[1], r[2], 'YXZ'));
      _m.compose(_p.set(p[0], p[1], p[2]), _q, _s.set(s[0], s[1], s[2]));
    }
    geom.applyMatrix4(_m);
    if (o.fix) o.fix(geom);
    const pos = geom.attributes.position, nor = geom.attributes.normal;
    const n = pos.count;
    const col = new Float32Array(n * 3);
    _c.set(color);
    const ao = o.ao === undefined ? 0.22 : o.ao, cr = o.crease;
    for (let i = 0; i < n; i++) {
      let k = 1 - ao * 0.6 * (0.5 - 0.5 * nor.getY(i));
      if (cr) {
        const y = pos.getY(i);
        k *= 1 - 0.14 * Math.max(sm01(1 - (cr[0] - y) / cr[1]), sm01(1 - (y - cr[2]) / cr[3]));
      }
      col[i * 3] = _c.r * k; col[i * 3 + 1] = _c.g * k; col[i * 3 + 2] = _c.b * k;
    }
    geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const dv = this.detailUV;
    if (dv && o.detail) { // detail parts skip the skin textures (see SKIN_DETAIL_UV / BEH_DETAIL_UV)
      const uv = geom.attributes.uv; for (let i = 0; i < n; i++) uv.setXY(i, dv[0], dv[1]);
    }
    this.list.push(geom);
    return this;
  }
  build(): PartGeo {
    const full = mergeGeometries(this.list, false);
    for (const g of this.list) g.dispose();
    full.computeBoundingSphere(); full.computeBoundingBox();
    return { full };
  }
}

/** Detail UVs: the plain strip at the top of the skin textures; for the Behemoth (triplanar) an out-of-range flag. */
const SKIN_DETAIL_UV = [0.5, 0.997] as const, BEH_DETAIL_UV = [-1, -1] as const;
const bodyParts = (d: Dims) => new Parts(d.B.behemoth ? BEH_DETAIL_UV : SKIN_DETAIL_UV);

const sphere = (r = 1, ws = 14, hs = 10) => new THREE.SphereGeometry(r, ws, hs);
function ell(P: Parts, color: THREE.ColorRepresentation, c: Tuple3, r: Tuple3, o: AddOpts = {}): Parts { // ellipsoid at c with radii r
  return P.add(sphere(1, o.ws || 14, o.hs || 10), color, { ...o, pos: c, scl: r });
}
function segMatrix(a: Vec3, b: Vec3, out = new M4()): THREE.Matrix4 {
  const dir = _p.copy(b).sub(a); const len = dir.length();
  _q.setFromUnitVectors(UPV, dir.divideScalar(Math.max(len, 1e-6)));
  return out.compose(new V3().addVectors(a, b).multiplyScalar(0.5), _q, _s.set(1, 1, 1));
}
function capsule(P: Parts, color: THREE.ColorRepresentation, a: Tuple3, b: Tuple3, r: number, o: AddOpts = {}): Parts {
  const A = new V3(a[0], a[1], a[2]), B = new V3(b[0], b[1], b[2]);
  const len = Math.max(A.distanceTo(B) - 2 * r, 0.001);
  return P.add(new THREE.CapsuleGeometry(r, len, o.cs || 3, o.rs || 8), color, { ...o, matrix: segMatrix(A, B) });
}
/** Lathe limb hanging along -y from the origin: cap radius r0 at y=0, cap radius r1 at y=-len, optional bulge. */
function limbGeo(len: number, r0: number, r1: number, bulge = 0.1, bulgeAt = 0.3, seg = 12): THREE.LatheGeometry {
  const pts: THREE.Vector2[] = [], capN = 4, N = 8;
  for (let i = 0; i <= capN; i++) { const a = (i / capN) * Math.PI / 2; pts.push(new V2(Math.max(0.0001, Math.sin(a) * r0), Math.cos(a) * r0)); }
  for (let i = 1; i < N; i++) {
    const t = i / N;
    const r = r0 + (r1 - r0) * t + bulge * r0 * Math.exp(-((t - bulgeAt) ** 2) / 0.05);
    pts.push(new V2(r, -t * len));
  }
  for (let i = 0; i <= capN; i++) { const a = (i / capN) * Math.PI / 2; pts.push(new V2(Math.max(0.0001, Math.cos(a) * r1), -len - Math.sin(a) * r1)); }
  pts.reverse();
  return new THREE.LatheGeometry(pts, seg);
}
/** Crease bands for a limb lathe (darker where it disappears into the neighbouring joint mesh). */
const limbCrease = (len: number, r0: number, r1: number) => [-0.25 * r0, 0.6 * r0, -len + 0.25 * r1, 0.6 * r1] as const;

// -------------------------------------------------------------------------------------------------------------
export function sizeClass(h: number): SizeClass { return h < 6 ? 'S' : h < 10 ? 'M' : h < 25 ? 'L' : 'XL'; }

// head radius per size class: small titans keep an oversized head (uncanny), but not a cartoon one
const HEAD_R: Record<SizeClass, number> = { S: 1.22, M: 1.12, L: 1.04, XL: 1.0 };

function makeDims(build: BuildKey, size: SizeClass): Dims {
  const B = BUILDS[build];
  const headR = HEAD_R[size] * B.head;
  const thighLen = 2.15 * B.legs, shinLen = 1.75 * B.legs, ankleH = 0.34;
  const hipY = thighLen + shinLen + ankleH;
  const spineY = 0.45;
  const neckY = 2.75 * B.torsoH, neckLen = B.behemoth ? 0.35 : 0.55;
  const cy = 0.9 * headR * B.faceH, cz = 0.12 * headR;
  const rx = headR * B.faceW, ry = headR * 1.12 * B.faceH, rz = headR * 1.04;
  const headTop = cy + ry;
  return {
    B, build, size, headR,
    thighLen, shinLen, ankleH, hipY,
    hipX: 0.62 * B.torsoW,
    spineY,
    shoulderX: 1.38 * B.torsoW * B.shoulder, shoulderY: 2.4 * B.torsoH,
    neckY, neckLen,
    upperLen: 2.15 * B.arms, foreLen: 2.05 * B.arms,
    limb: B.limb,
    handS: Math.sqrt(B.limb) * (B.behemoth ? 1.1 : 1.0),
    cy, cz, rx, ry, rz, headTop,
    total: hipY + spineY + neckY + neckLen + headTop,
    // jaw hinge (head-local)
    jawPivot: new V3(0, cy - 0.3 * ry, cz - 0.42 * headR),
    mouthLocal: new V3(0, cy - 0.42 * ry, cz + 0.82 * headR),
    // nape (head-local), generous
    napeC: new V3(0, 0.06, -0.58 * headR * Math.max(0.7, B.neckW)),
    napeHalf: new V3(0.36, 0.46, 0.27),
  };
}

// -------------------------------------------------------------------------------------------------------------
function buildPelvis(d: Dims, skin: number): PartGeo {
  const P = bodyParts(d), B = d.B, tw = B.torsoW;
  ell(P, skin, [0, 0.05, 0], [0.86 * tw, 0.62, 0.64]);                 // hips
  ell(P, skin, [-0.4 * tw, -0.08, -0.38], [0.5, 0.52, 0.5]);           // glutes
  ell(P, skin, [0.4 * tw, -0.08, -0.38], [0.5, 0.52, 0.5]);
  ell(P, skin, [0, 0.42, 0], [0.76 * tw, 0.6, 0.56]);                  // waist
  const belly = B.belly;
  if (belly > 0.05) ell(P, skin, [0, 0.42, 0.18 + 0.28 * belly], [(0.7 + 0.45 * belly) * tw, 0.62 + 0.32 * belly, 0.55 + 0.7 * belly], { ao: 0.35, hs: 12 });
  return P.build();
}
function buildSpine(d: Dims, skin: number, muscleCol: number | null): PartGeo {
  const P = bodyParts(d), B = d.B, tw = B.torsoW, th = B.torsoH;
  ell(P, skin, [0, 0.35, 0], [0.8 * tw, 0.6, 0.6]);
  ell(P, skin, [0, 1.5 * th, 0], [1.2 * tw, 1.45 * th, 0.86], { ws: 18, hs: 12 });             // rib cage
  for (const s of [-1, 1]) ell(P, skin, [s * d.shoulderX, d.shoulderY, 0], [0.5 * d.limb * B.shoulder + 0.1, 0.55 * d.limb * B.shoulder + 0.05, 0.5 * d.limb * B.shoulder + 0.05]);
  ell(P, skin, [0, d.neckY - 0.45, -0.12], [0.95 * tw, 0.42, 0.58]);                                // traps
  if (B.female && muscleCol !== null) {
    // bare muscle down the flanks and over the shoulders; skin over the chest
    for (const s of [-1, 1]) {
      ell(P, muscleCol, [s * 0.95 * tw, 1.4 * th, 0.1], [0.32 * tw, 0.95 * th, 0.6], { ao: 0.35 });
      ell(P, muscleCol, [s * d.shoulderX * 0.95, d.shoulderY + 0.05, 0], [0.42 * d.limb + 0.08, 0.4 * d.limb + 0.05, 0.42 * d.limb + 0.05], { ao: 0.3 });
      ell(P, skin, [s * 0.42 * tw, 1.95 * th, 0.56], [0.38 * tw, 0.32, 0.32], { ao: 0.3 });
    }
  } else if (B.muscle) {
    for (const s of [-1, 1]) {
      ell(P, muscleCol || skin, [s * 0.5 * tw, 2.0 * th, 0.42], [0.56 * tw, 0.48, 0.42], { ao: 0.3 });
      ell(P, muscleCol || skin, [s * 0.62 * tw, 1.1 * th, 0.55], [0.5 * tw, 0.34, 0.3], { ao: 0.4 });
      ell(P, muscleCol || skin, [s * 0.35 * tw, 0.55 * th, 0.5], [0.38 * tw, 0.3, 0.26], { ao: 0.4 });
    }
  }
  if (B.ribs) {                          // gaunt: visible ribs
    for (let i = 0; i < 5; i++) {
      const y = (0.9 + i * 0.34) * th;
      const k = Math.sqrt(Math.max(0.05, 1 - ((y - 1.5 * th) / (1.45 * th)) ** 2));
      P.add(new THREE.TorusGeometry(1, 0.07, 6, 18, Math.PI * 0.9), skin, { pos: [0, y, 0], rot: [Math.PI / 2, 0, 0], scl: [1.2 * tw * k + 0.03, 0.86 * k + 0.03, 1], ao: 0.6 });
    }
  }
  return P.build();
}

function buildHead(d: Dims, st: Expr, skinC: number, hairC: number, rnd: () => number, withHair: boolean): { head: PartGeo; jaw: PartGeo } {
  const P = bodyParts(d);
  const PJ = bodyParts(d);
  const B = d.B, R = d.headR, cy = d.cy, cz = d.cz, rx = d.rx, ry = d.ry, rz = d.rz;
  const skin = skinC, faceH = B.faceH, beh = !!B.behemoth;
  const surf = (x: number, y: number) => { const a = (x / rx) ** 2 + ((y - cy) / ry) ** 2; return cz + rz * Math.sqrt(Math.max(0.04, 1 - a)); };
  const normalAt = (x: number, y: number, z: number, out = new V3()) => out.set(x / (rx * rx), (y - cy) / (ry * ry), (z - cz) / (rz * rz)).normalize();
  const orient = (pos: Vec3, n: Vec3) => new M4().lookAt(n, new V3(), UPV).setPosition(pos);
  const toothH = st.tooth * R;
  const smile = (x: number) => st.smile * R * 0.55 * (x / rx) ** 2;            // rim rise towards the mouth corners
  const yU = cy - 0.12 * ry;                                      // upper rim (centre)
  const yL = yU - 2 * toothH;                                            // lower rim (centre), jaw closed
  const jawP = d.jawPivot;
  const mw = st.mouthW * rx;
  const N = st.nT;
  const crease = new THREE.Color(skin).multiplyScalar(0.62).getHex();   // skin folds: the skin tone, in shadow
  const socket = new THREE.Color(skin).multiplyScalar(0.8).getHex();
  const browC = new THREE.Color(skin).multiplyScalar(0.5).lerp(new THREE.Color(hairC), withHair ? 0.75 : 0.45).getHex();   // sparse brows on a bald head

  // ---- neck, cranium shell (cut at the upper rim), back-of-head underside, ears
  P.add(new THREE.CylinderGeometry(0.55 * R * B.neckW, 0.68 * R * B.neckW, 1.5 * R, 14), skin, { pos: [0, -0.4 * R, 0.0], ao: 0.3 });
  const thU = Math.acos(THREE.MathUtils.clamp((yU - cy) / ry, -1, 1));
  P.add(new THREE.SphereGeometry(1, 30, 20, 0, Math.PI * 2, 0, thU), skin, {
    pos: [0, cy, cz], scl: [rx, ry, rz], ao: 0.25,
    fix: (g) => { const p = g.attributes.position; for (let i = 0; i < p.count; i++) { const y = Math.max(p.getY(i), yU + smile(p.getX(i))); p.setY(i, y); } },
  });
  const yLmax = yL + smile(rx);
  const thL = Math.acos(THREE.MathUtils.clamp((yLmax - cy) / ry, -1, 1));
  const phiHalf = 1.75;
  // back part of the lower head (static): phi range behind the jaw
  P.add(new THREE.SphereGeometry(1, 20, 10, Math.PI / 2 + phiHalf, Math.PI * 2 - 2 * phiHalf, thL, Math.PI - thL), skin, { pos: [0, cy, cz], scl: [rx, ry, rz], ao: 0.4 });
  for (const s of [-1, 1]) ell(P, skin, [s * (rx * 0.97), cy - 0.12 * R, cz - 0.1 * R], [0.07 * R, 0.27 * R, 0.16 * R], { ao: 0.2, rot: [0, 0, s * 0.12] });

  // ---- jaw shell (front part of the lower ellipsoid), built in head space then moved to hinge space
  PJ.add(new THREE.SphereGeometry(1, 22, 10, Math.PI / 2 - phiHalf, 2 * phiHalf, thL, Math.PI - thL), skin, {
    pos: [0, cy, cz], scl: [rx, ry, rz], ao: 0.25,
    fix: (g) => { const p = g.attributes.position; for (let i = 0; i < p.count; i++) { p.setXYZ(i, p.getX(i) - jawP.x, Math.min(p.getY(i), yL + smile(p.getX(i))) - jawP.y, p.getZ(i) - jawP.z); } },
  });

  // ---- a closed mouth (the Huntress): skin and lips over the gap between the cranium and the jaw, so the teeth and
  // the dark mouth show only when the jaw really opens (the upper lip stays with the head, the lower one goes with the jaw)
  if (st.calm) {
    const th = (y: number) => Math.acos(THREE.MathUtils.clamp((y - cy) / ry, -1, 1));
    const tU = th(yU + 0.02 * R), tM = th(yU - toothH), tL = th(yL - 0.02 * R), al = Math.asin(Math.min(0.95, (mw + 0.04 * R) / rx));
    const band = (t0: number, t1: number, p0: number, pl: number, col: number, jaw: boolean) => (jaw ? PJ : P).add(new THREE.SphereGeometry(1, 28, 3, p0, pl, t0, t1 - t0), col, {
      pos: jaw ? new V3(0, cy, cz).sub(jawP).toArray() : [0, cy, cz], scl: [rx * 1.01, ry * 1.01, rz * 1.01], detail: true, ao: 0.2 });
    const LIP = new THREE.Color(skin).lerp(new THREE.Color(0xb06a62), 0.32).getHex();
    band(tU, tL, Math.PI / 2 + al, Math.PI * 2 - 2 * al, skin, false);        // the cheeks round to the back
    band(tU, tM, Math.PI / 2 - al, 2 * al, LIP, false);                       // upper lip
    band(tM, tL, Math.PI / 2 - al, 2 * al, LIP, true);                        // lower lip, on the jaw
    capsule(P, 0x5a2e2a, [-mw * 0.9, yU - toothH, surf(0, yU - toothH) * 1.0 + 0.02 * R], [mw * 0.9, yU - toothH, surf(0, yU - toothH) + 0.02 * R], 0.012 * R, { detail: true, ao: 0 });
  }

  // ---- mouth interior (dark, recessed ellipsoid) + tongue
  P.add(sphere(1, 18, 12), MOUTH, { pos: [0, cy - 0.1 * R, cz], scl: [rx * 0.93, ry * 0.9, rz * 0.9], detail: true, ao: 0 });
  PJ.add(sphere(1, 12, 8), TONGUE, { pos: new V3(0, yL + 0.04 * R, cz + 0.32 * R).sub(jawP).toArray(), scl: [0.5 * R, 0.1 * R, 0.4 * R], detail: true, ao: 0.1 });
  PJ.add(sphere(1, 12, 8), MOUTH, { pos: new V3(0, yL - 0.02 * R, cz - 0.1 * R).sub(jawP).toArray(), scl: [rx * 0.8, 0.14 * R, rz * 0.6], detail: true, ao: 0 });

  // ---- eyes (sclera + iris + pupil), lids, brows
  const eR = st.eye * R, eyeX = 0.42 * rx, eyeY = cy + 0.26 * ry;
  for (const s of [-1, 1]) {
    const ez = surf(s * eyeX, eyeY);
    const n = normalAt(s * eyeX, eyeY, ez);
    const ec = new V3(s * eyeX, eyeY, ez).addScaledVector(n, -0.45 * eR);
    // the socket: a shallow, darker rim of skin round a sunken eye
    P.add(sphere(1, 12, 8), socket, { pos: ec.toArray(), scl: [eR * 1.32, eR * 1.24, eR * 0.8], ao: 0.6 });
    P.add(sphere(1, 14, 10), SCLERA, { pos: ec.toArray(), scl: [eR, eR * 1.04, eR], detail: true, ao: 0.1 });
    const dir = new V3(-s * 0.05, -0.02, 1).normalize();
    const ip = ec.clone().addScaledVector(dir, eR * 0.88);
    P.add(sphere(1, 12, 8), beh ? 0xd6ccb4 : st.irisC ?? IRIS, { matrix: orient(ip, dir).scale(new V3(eR * st.iris * 1.2, eR * st.iris * 1.2, eR * st.iris * 0.6)), detail: true, ao: 0 });
    const pp = ec.clone().addScaledVector(dir, eR * 1.0);
    P.add(sphere(1, 8, 6), 0x050404, { matrix: orient(pp, dir).scale(new V3(eR * st.iris * 0.55, eR * st.iris * 0.55, eR * 0.25)), detail: true, ao: 0 });
    if (st.lid > 0.02) {
      P.add(new THREE.SphereGeometry(1, 14, 8, 0, Math.PI * 2, 0, (38 + st.lid * 40) * Math.PI / 180), skin,
        { matrix: orient(ec, dir).scale(new V3(eR * 1.14, eR * 1.14, eR * 1.14)).multiply(new M4().makeRotationX(50 * Math.PI / 180)), ao: 0.3 });
    }
    if (st.brow > 0.05 && !beh) {
      const yb = eyeY + eR * 1.45;
      const x0 = s * (eyeX - 0.30 * R), x1 = s * (eyeX + 0.34 * R);
      const inner = yb - 0.02 * R * st.brow, outer = yb + 0.06 * R;
      capsule(P, browC, [x0, inner, surf(x0, inner) + 0.005 * R], [x1, outer, surf(x1, outer) + 0.005 * R], 0.06 * R, { detail: true, ao: 0 });
    }
    // cheek bulge under the eye, pushed up by the grin + the smile fold
    const cxm = s * (mw * 0.95), cyy = yU + smile(mw) + 0.12 * R;
    if (!beh && !st.calm) ell(P, skin, [cxm, cyy, surf(cxm, cyy) - 0.04 * R], [0.3 * R, 0.2 * R, 0.22 * R], { ao: 0.35 });
    const c0 = new V3(s * (mw + 0.02 * R), (yU + yL) / 2 + smile(mw), 0), c1 = new V3(s * (mw + 0.12 * R), (yU + yL) / 2 + smile(mw) + 0.34 * R, 0);
    c0.z = surf(c0.x, c0.y) + 0.015 * R; c1.z = surf(c1.x, c1.y) + 0.03 * R;
    if (!beh && !st.calm) capsule(P, crease, c0.toArray(), c1.toArray(), 0.035 * R, { detail: true, ao: 0 });
  }
  // ---- nose
  if (!beh) {
    const ny = cy + 0.06 * ry, nz = surf(0, ny);
    ell(P, skin, [0, ny, nz + 0.0 * R], [0.12 * R, 0.16 * R, 0.14 * R], { ao: 0.3 });
    for (const s of [-1, 1]) P.add(sphere(1, 6, 5), 0x3a1a18, { pos: [s * 0.06 * R, ny - 0.12 * R, nz + 0.05 * R], scl: [0.045 * R, 0.035 * R, 0.045 * R], detail: true, ao: 0 });
  } else {
    for (const s of [-1, 1]) P.add(sphere(1, 6, 5), 0x1a0606, { pos: [s * 0.06 * R, cy + 0.04 * ry, surf(0, cy + 0.04 * ry) + 0.03 * R], scl: [0.035 * R, 0.1 * R, 0.04 * R], detail: true, ao: 0 });
    for (const s of [-1, 1]) ell(P, skin, [s * 0.55 * rx, cy - 0.12 * R * faceH, surf(s * 0.55 * rx, cy - 0.12 * R * faceH) - 0.06 * R], [0.28 * R, 0.16 * R, 0.2 * R], { ao: 0.4 });
  }

  // ---- hair: top cap + back cap + matted locks lying on the head (one rnd() per lock, so the teeth's random draws below don't depend on the hair style)
  if (withHair) {
    P.add(new THREE.SphereGeometry(1, 22, 10, 0, Math.PI * 2, 0, 62 * Math.PI / 180), hairC, { pos: [0, cy + 0.03 * R, cz - 0.08 * R], scl: [rx * 1.06, ry * 1.07, rz * 1.08], ao: 0.15, rot: [-0.15, 0, 0] });
    P.add(new THREE.SphereGeometry(1, 22, 10, 0, Math.PI * 2, 0, 80 * Math.PI / 180), hairC, { pos: [0, cy - 0.05 * R, cz - 0.07 * R], scl: [rx * 1.06, ry * 1.05, rz * 1.07], ao: 0.15, rot: [-Math.PI / 2 - 0.2, 0, 0] });
    // the Huntress: a soft fringe swept to one side (flat locks) over a smooth crown
    if (st.calm) for (let i = 0; i < 7; i++) {
      const a = -0.85 + (i / 6) * 1.7;
      const hx = Math.sin(a) * rx * 0.86, hy = cy + 0.6 * ry - 0.1 * R * Math.abs(a), hz = surf(hx, hy) - 0.02 * R;
      P.add(sphere(1, 10, 7), hairC, { pos: [hx + 0.06 * R, hy - 0.08 * R, hz], scl: [0.2 * R, 0.34 * R, 0.08 * R], rot: [-0.25, a * 0.4, 0.35], ao: 0.1 });
    }
    else for (let i = 0; i < 9; i++) {                         // fringe: lank, flattened locks along the hairline
      const a = -0.95 + (i / 8) * 1.9;
      const hx = Math.sin(a) * rx * 0.86, hy = cy + 0.62 * ry - 0.08 * R * Math.abs(a), hz = surf(hx, hy) - 0.01 * R;
      const len = (0.34 + rnd() * 0.16) * R;
      P.add(sphere(1, 8, 6), hairC, { pos: [hx, hy - 0.02 * R, hz], scl: [0.22 * R, len * 0.62, 0.1 * R], rot: [-0.3, a * 0.75, a * 0.2], ao: 0.1 });
    }
    if (st.bun) P.add(sphere(1, 12, 9), hairC, { pos: [0, cy + 0.42 * ry, cz - 1.0 * rz], scl: [0.42 * R, 0.36 * R, 0.36 * R], ao: 0.2 });
    if (st.sideLocks) for (const s of [-1, 1]) {
      P.add(sphere(1, 8, 6), hairC, { pos: [s * rx * 0.92, cy - 0.05 * ry, cz + 0.25 * rz], scl: [0.12 * R, 0.48 * R, 0.08 * R], rot: [-0.12, s * 0.35, s * 0.1], ao: 0.1 });
    }
    // shoulder-length locks hanging round the sides and the back of the head, lying flat against it
    if (st.longHair) for (let i = 0; i < 13; i++) {
      const a = Math.PI * (0.38 + (i / 12) * 1.24);              // from beside one cheek, round the back, to the other
      const hx = Math.sin(a) * rx * 0.98, hz = cz + Math.cos(a) * rz * 0.98, len = (0.95 + rnd() * 0.3) * R;
      P.add(sphere(1, 8, 6), hairC, { pos: [hx, cy + 0.2 * ry - len * 0.45, hz], scl: [0.2 * R, len * 0.5, 0.09 * R], rot: [-0.12, a, 0], ao: 0.15 });
    }
  }

  // ---- teeth rows: upper (head) + lower (jaw) + gums
  const jawMat = (mat: THREE.Matrix4) => { const m = mat.clone(); m.elements[12] -= jawP.x; m.elements[13] -= jawP.y; m.elements[14] -= jawP.z; return m; };
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) / N * 2 - 1, x = t * mw;
    const w = (2 * mw / N) * 0.94 * (1 - 0.2 * Math.abs(t));
    for (const upper of [true, false]) {
      const hh = toothH * (1 - 0.3 * Math.abs(t) ** 1.6) * (0.88 + rnd() * 0.24);
      const yEdge = (upper ? yU : yL) + smile(x);                       // rim line at this x
      const yc = upper ? yEdge - hh / 2 + 0.02 * R : yEdge + hh / 2 - 0.02 * R;
      const z = surf(x, yc) - (st.calm ? 0.13 * R : 0);   // (a closed mouth: the teeth sit behind the lips)
      const n = normalAt(x, yc, z);
      const tilt = (rnd() - 0.5) * 0.12;
      const mat = orient(new V3(x, yc, z), n).scale(new V3(w * 0.5, hh * 0.5, 0.075 * R * (beh ? 1.3 : 1)));
      mat.multiply(new M4().makeRotationZ(tilt));
      const gc = beh ? 0x7a2220 : GUM;
      const gy = upper ? yEdge + 0.02 * R : yEdge - 0.02 * R;
      const gp = new V3(x, gy, surf(x, gy) - (st.calm ? 0.14 : 0.01) * R);
      // a tooth: a low-poly rounded block, like a human tooth
      const tooth = () => new THREE.SphereGeometry(1.12, 6, 4).scale(1, 1, 0.9);
      if (upper) {
        P.add(tooth(), TEETH, { matrix: mat, detail: true, ao: 0.25 });
        P.add(sphere(1, 6, 5), gc, { pos: gp.toArray(), scl: [w * 0.6, 0.06 * R, 0.07 * R], detail: true, ao: 0.2 });
      } else {
        PJ.add(tooth(), TEETH, { matrix: jawMat(mat), detail: true, ao: 0.25 });
        PJ.add(sphere(1, 6, 5), gc, { pos: gp.sub(jawP).toArray(), scl: [w * 0.6, 0.06 * R, 0.07 * R], detail: true, ao: 0.2 });
      }
    }
  }
  return { head: P.build(), jaw: PJ.build() };
}

function buildArm(d: Dims, skin: number, mus: number | null): PartGeo {
  const P = bodyParts(d);
  const lm = d.limb, r0 = 0.52 * lm, r1 = 0.4 * lm;
  P.add(limbGeo(d.upperLen, r0, r1, 0.12, 0.3), skin, { ao: 0.3, crease: limbCrease(d.upperLen, r0, r1) });
  if (d.B.muscle) ell(P, mus || skin, [0, -d.upperLen * 0.32, 0.12 * lm], [0.46 * lm, 0.5 * lm, 0.46 * lm], { ao: 0.4 });
  return P.build();
}
function handParts(P: Parts, d: Dims, skin: number, side: number, fist: boolean): void {
  const hs = d.handS;
  const dir = -side;                         // palm faces the body centre
  // wrist -> palm
  P.add(limbGeo(0.4 * hs, 0.31 * d.limb + 0.04, 0.26 * hs, 0.0), skin, { pos: [0, -d.foreLen + 0.55 * hs, 0], ao: 0.3 });
  const y0 = -d.foreLen;                      // palm centre
  ell(P, skin, [0, y0 + 0.02, 0], [0.19 * hs, 0.36 * hs, 0.36 * hs], { ao: 0.3 });
  if (!fist) {
    for (let i = 0; i < 4; i++) {
      const z = (-0.25 + i * 0.165) * hs * 1.1;
      const l1 = (0.32 + (i === 1 || i === 2 ? 0.06 : 0)) * hs;
      const a = new V3(0, y0 - 0.24 * hs, z), b = new V3(dir * 0.06 * hs, y0 - 0.24 * hs - l1, z);
      const c = new V3(dir * 0.2 * hs, b.y - 0.26 * hs, z);
      capsule(P, skin, a.toArray(), b.toArray(), 0.075 * hs, { rs: 6, cs: 2, ao: 0.3 });
      capsule(P, skin, b.toArray(), c.toArray(), 0.065 * hs, { rs: 6, cs: 2, ao: 0.3 });
    }
    capsule(P, skin, [dir * 0.02, y0 + 0.08 * hs, 0.28 * hs], [dir * 0.1 * hs, y0 - 0.2 * hs, 0.5 * hs], 0.085 * hs, { rs: 6, cs: 2, ao: 0.3 }); // thumb (front)
  } else {
    // closed fist
    ell(P, skin, [dir * 0.14 * hs, y0 - 0.26 * hs, 0], [0.26 * hs, 0.26 * hs, 0.4 * hs], { ao: 0.35 });
    for (let i = 0; i < 4; i++) {
      const z = (-0.27 + i * 0.18) * hs;
      ell(P, skin, [dir * 0.22 * hs, y0 - 0.1 * hs, z], [0.1 * hs, 0.12 * hs, 0.1 * hs], { ao: 0.3, ws: 8, hs: 6 });
      capsule(P, skin, [dir * 0.2 * hs, y0 - 0.2 * hs, z], [dir * 0.1 * hs, y0 - 0.38 * hs, z], 0.075 * hs, { rs: 6, cs: 2, ao: 0.35 });
    }
    capsule(P, skin, [dir * 0.1 * hs, y0 + 0.06 * hs, 0.26 * hs], [dir * 0.27 * hs, y0 - 0.12 * hs, 0.14 * hs], 0.085 * hs, { rs: 6, cs: 2, ao: 0.3 });
  }
}
/**
 * A hand closed round a soldier: the palm against their back, four fingers curled round under and up their front,
 * the thumb over the top, all wrapped about a cylinder of radius `rl` (local units) along the knuckle line (z).
 * Small titans' hands are smaller than a human's waist, so the hand is scaled up (`g`) until the grip goes most of
 * the way round. Returns the grip centre (fore-local) as well; the soldier's waist goes there, body along z.
 */
function gripParts(P: Parts, d: Dims, skin: number, side: number, rl: number, g: number): Vec3 {
  const hs = d.handS * g, dir = -side;
  const wristY = -d.foreLen + 0.55 * d.handS, y0 = wristY - 0.55 * hs;
  P.add(limbGeo(0.4 * hs, 0.31 * d.limb + 0.04, 0.26 * hs, 0.0), skin, { pos: [0, wristY, 0], ao: 0.3 });
  ell(P, skin, [-dir * 0.02 * hs, y0 + 0.02, 0], [0.17 * hs, 0.36 * hs, 0.36 * hs], { ao: 0.3 });
  const C = new V3(dir * (0.15 * hs + rl), y0 - 0.06 * hs, 0);
  const arc = (a0: number, sweep: number, R: number, z0: number, z1: number, n: number, r0: number, r1: number, base: Vec3) => {
    let prev = base;
    for (let k = 1; k <= n; k++) {
      const t = k / n, a = a0 + sweep * t;
      const p = new V3(C.x + Math.cos(a) * R, C.y + Math.sin(a) * R, z0 + (z1 - z0) * t);
      capsule(P, skin, prev.toArray(), p.toArray(), r0 + (r1 - r0) * t, { rs: 6, cs: 2, ao: 0.3 });
      prev = p;
    }
  };
  // fingers: from the knuckles under the palm, round the far side of the waist
  for (let i = 0; i < 4; i++) {
    const z = (-0.27 + i * 0.18) * hs;
    const K = new V3(dir * 0.05 * hs, y0 - 0.3 * hs, z);
    const R = rl + 0.075 * hs;
    const a0 = Math.atan2(K.y - C.y, K.x - C.x);
    const len = (0.66 + (i === 1 || i === 2 ? 0.06 : 0) - (i === 3 ? 0.1 : 0)) * hs;
    arc(a0, dir * Math.min(len / R, 3.9), R, z, z * 0.9, 4, 0.08 * hs, 0.062 * hs, K);
  }
  // thumb: from the top of the palm, over the top of the waist
  const T = new V3(-dir * 0.02 * hs, y0 + 0.18 * hs, 0.22 * hs);
  const Rt = rl + 0.085 * hs;
  arc(Math.atan2(T.y - C.y, T.x - C.x), -dir * Math.min(0.5 * hs / Rt, 2.3), Rt, 0.22 * hs, 0.12 * hs, 3, 0.09 * hs, 0.07 * hs, T);
  return C;
}
const GRIP_R = 0.15;     // m: the soldier's waist, held tight
/** Forearm + a hand gripping a soldier (cached per archetype, side and titan scale). */
export function gripGeometry(arch: Archetype, side: number, scale: number): GripGeo {
  const d = arch.dims, rl = GRIP_R / scale;
  const key = `grip${side}:${rl.toFixed(2)}` as const;
  const cached = arch.geo[key];
  if (cached) return cached;
  const g = THREE.MathUtils.clamp(3.54 * rl / d.handS, 1, 1.7);
  const P = bodyParts(d);
  P.add(limbGeo(d.foreLen - 0.55 * d.handS, 0.4 * d.limb, 0.3 * d.limb + 0.02, 0.1, 0.25), arch.skin, { ao: 0.3 });
  const centre = gripParts(P, d, arch.skin, side, rl, g);
  const out: GripGeo = { ...P.build(), centre };
  return (arch.geo[key] = out);
}

function buildFore(d: Dims, skin: number, side: number, fist: boolean): PartGeo {
  const P = bodyParts(d);
  const lm = d.limb, len = d.foreLen - 0.55 * d.handS, r0 = 0.4 * lm, r1 = 0.3 * lm + 0.02;
  P.add(limbGeo(len, r0, r1, 0.1, 0.25), skin, { ao: 0.3, crease: [-0.25 * r0, 0.6 * r0, -1e9, 1] });
  handParts(P, d, skin, side, fist);
  return P.build();
}
function buildThigh(d: Dims, skin: number, mus: number | null): PartGeo {
  const P = bodyParts(d), lm = d.limb, r0 = 0.64 * lm, r1 = 0.46 * lm;
  P.add(limbGeo(d.thighLen, r0, r1, 0.14, 0.3, 14), skin, { ao: 0.3, crease: limbCrease(d.thighLen, r0, r1) });
  if (d.B.muscle) ell(P, mus || skin, [0, -d.thighLen * 0.4, 0.15 * lm], [0.6 * lm, 0.8 * lm, 0.58 * lm], { ao: 0.4 });
  return P.build();
}
function buildShin(d: Dims, skin: number): PartGeo {
  const P = bodyParts(d), lm = d.limb, r0 = 0.46 * lm, r1 = 0.28 * lm + 0.02;
  P.add(limbGeo(d.shinLen, r0, r1, 0.2, 0.25, 12), skin, { ao: 0.3, crease: limbCrease(d.shinLen, r0, r1) });
  ell(P, skin, [0, -d.shinLen * 0.3, -0.14 * lm], [0.38 * lm, 0.46 * lm, 0.36 * lm], { ao: 0.35 });                  // calf
  return P.build();
}
function buildFoot(d: Dims, skin: number): PartGeo {
  const P = bodyParts(d), lm = d.limb;
  const w = 0.3 * Math.sqrt(lm) + 0.1;
  ell(P, skin, [0, -0.02, 0.0], [0.3 * lm + 0.02, 0.3 * lm + 0.02, 0.34 * lm + 0.02], { ao: 0.3 });                   // ankle
  ell(P, skin, [0, -d.ankleH + 0.15 * lm + 0.07, 0.42], [w, 0.17 * lm + 0.1, 0.78], { ao: 0.35 });                      // sole + midfoot
  for (let i = 0; i < 5; i++) {
    const x = (i - 2) * 0.62 * w * 0.5;
    ell(P, skin, [x, -d.ankleH + 0.14, 1.04 - Math.abs(i - 2) * 0.05], [0.12 * Math.sqrt(lm) + 0.04, 0.1 * lm + 0.06, 0.15], { ao: 0.3, ws: 8, hs: 6 });
  }
  return P.build();
}

// =============================================================================================================
// Surface textures, generated once (a few ms). Skin wraps round each primitive by its own UVs: u wraps (tileable in
// x), v is clamped, and the top rows (v ~ 1) are a plain strip that detail parts (teeth, eyes, lips) sample. The
// Behemoth's muscle tiles both ways and is mapped triplanar in the shader.
// =============================================================================================================
/** Value noise on an integer lattice, tileable with period `px` cells in x (and `py` in y when given). */
function lattice(seed: number, px: number, py = 0) {
  const h = (ix: number, iy: number) => {
    if (py > 0) iy = ((iy % py) + py) % py;
    let n = Math.imul(((ix % px) + px) % px, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 2147483647);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  return (x: number, y: number) => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = h(ix, iy), b = h(ix + 1, iy), c = h(ix, iy + 1), d = h(ix + 1, iy + 1);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
}

/** RGBA bytes -> a mipmapped, x-repeating texture (y-clamped unless `tileY`). */
function dataTexture(data: Uint8Array, W: number, H: number, srgb: boolean, tileY = false): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping; tex.wrapT = tileY ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true; tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** Height field -> tangent-space normal map bytes (x wraps, y clamps or wraps); rows >= plainFrom are flat. */
function normalBytes(hgt: Float32Array, W: number, H: number, strength: number, plainFrom: number, tileY = false): Uint8Array {
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    let nx = 0, ny = 0;
    if (y < plainFrom) {
      const xl = (x + W - 1) % W, xr = (x + 1) % W;
      const yd = tileY ? (y + H - 1) % H : Math.max(0, y - 1), yu = tileY ? (y + 1) % H : Math.min(H - 1, y + 1);
      nx = (hgt[y * W + xl] - hgt[y * W + xr]) * strength;
      ny = (hgt[yd * W + x] - hgt[yu * W + x]) * strength;
    }
    const l = Math.sqrt(nx * nx + ny * ny + 1);
    out[i] = Math.round((nx / l * 0.5 + 0.5) * 255); out[i + 1] = Math.round((ny / l * 0.5 + 0.5) * 255);
    out[i + 2] = Math.round((1 / l * 0.5 + 0.5) * 255); out[i + 3] = 255;
  }
  return out;
}

/**
 * Titan skin: a near-white albedo (the vertex colour carries the skin tone) with blotchy capillary reds, sallow
 * patches, faint veins and fine speckle; the normal map has soft lumps and fine pores.
 */
function skinTextures(): { map: THREE.DataTexture; normalMap: THREE.DataTexture } {
  const W = 256, H = 256, plain = H - 5;
  const n1 = lattice(11, 6), n2 = lattice(23, 16), n3 = lattice(37, 48), n4 = lattice(51, 10), nv = lattice(71, 8);
  const col = new Uint8Array(W * H * 4), hgt = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x / W, v = y / H, i = y * W + x;
    if (y >= plain) { col.set([255, 255, 255, 255], i * 4); hgt[i] = 0; continue; }
    const blot = n1(u * 6, v * 6), mid = n2(u * 16, v * 16), fine = n3(u * 48, v * 48), sal = n4(u * 10 + 3.7, v * 10);
    // veins: thin dark-blue lines where a warped noise crosses 0.5
    const vn = nv(u * 8 + 0.6 * mid, v * 8 + 0.6 * blot);
    const vein = Math.max(0, 1 - Math.abs(vn - 0.5) * 28) * 0.55;
    const red = sm01((blot - 0.45) * 2.4) * 0.16, sallow = sm01((sal - 0.55) * 2.5) * 0.1;
    const lum = 0.9 + 0.07 * (mid - 0.5) + 0.06 * (fine - 0.5);
    let r = lum * (1 - 0.02 * red) - 0.02 * sallow, g = lum * (1 - red * 0.55) - 0.01 * sallow, b = lum * (1 - red * 0.6) - 0.09 * sallow;
    r -= vein * 0.07; g -= vein * 0.05; b += vein * 0.0;
    col[i * 4] = Math.round(255 * Math.min(1, r)); col[i * 4 + 1] = Math.round(255 * Math.min(1, g)); col[i * 4 + 2] = Math.round(255 * Math.min(1, b)); col[i * 4 + 3] = 255;
    hgt[i] = 0.6 * blot + 0.4 * mid + 0.3 * fine + 0.2 * vein;
  }
  return { map: dataTexture(col, W, H, true), normalMap: dataTexture(normalBytes(hgt, W, H, 1.2, plain), W, H, false) };
}

/**
 * The Behemoth: skinless muscle, tileable both ways (it is mapped triplanar in mesh space, see behemothPatch). Long
 * fibre bundles run along v, separated by dark wet crevices; pale tendon sheets streak along the fibres here and
 * there with fine sinew lines across them; colour runs from deep venous red to bright arterial red.
 */
function behemothTextures(): { map: THREE.DataTexture; normalMap: THREE.DataTexture } {
  const W = 512, H = 512, TAU2 = Math.PI * 2;
  const warp = lattice(5, 12, 4), bundle = lattice(9, 36, 3), fib = lattice(13, 150, 6), tone = lattice(17, 6, 6);
  const tend = lattice(29, 9, 2), spot = lattice(41, 64, 64);
  const col = new Uint8Array(W * H * 4), hgt = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x / W, v = y / H, i = y * W + x;
    // fibres: stretched along v, gently wavy
    const wx = u + 0.014 * (warp(u * 12, v * 4) - 0.5);
    const bu = bundle(wx * 36, v * 3), fi = fib(wx * 150, v * 6);
    const crevice = sm01((0.3 - bu) * 6);                    // dark gaps between bundles
    const ridge = 0.55 * bu + 0.45 * fi;
    // tendon sheets: pale streaks running with the fibres, crossed by fine sinew lines
    const tn = tend(wx * 9, v * 2);
    const sinew = 0.8 + 0.2 * Math.sin(v * TAU2 * 40 + 6 * fi);
    const tendon = sm01((tn - 0.8) * 9) * sinew;
    const t = tone(u * 6, v * 6), sp = spot(u * 64, v * 64);
    // muscle colour: deep venous red to arterial red, highlights along the fibre crests
    let r = 0.34 + 0.2 * t + 0.16 * ridge, g = 0.045 + 0.035 * t + 0.07 * fi * fi, b = 0.04 + 0.03 * t + 0.04 * fi * fi;
    r *= 1 - 0.7 * crevice; g *= 1 - 0.75 * crevice; b *= 1 - 0.65 * crevice;
    if (sp > 0.82) { r += 0.08; g += 0.05; b += 0.03; }                                     // fat flecks
    // tendon: pale ivory with a pink cast, a little fibre showing through
    r = r + (0.8 - 0.06 * fi - r) * tendon; g = g + (0.66 - 0.05 * fi - g) * tendon; b = b + (0.55 - 0.04 * fi - b) * tendon;
    col[i * 4] = Math.round(255 * Math.min(1, r)); col[i * 4 + 1] = Math.round(255 * Math.min(1, g)); col[i * 4 + 2] = Math.round(255 * Math.min(1, b)); col[i * 4 + 3] = 255;
    hgt[i] = (1.3 * ridge - 1.2 * crevice) * (1 - 0.6 * tendon) + 0.5 * tendon;
  }
  return { map: dataTexture(col, W, H, true, true), normalMap: dataTexture(normalBytes(hgt, W, H, 3.0, H, true), W, H, false, true) };
}

let _skinTex: ReturnType<typeof skinTextures> | null = null, _behTex: ReturnType<typeof behemothTextures> | null = null;
const skinTex = () => (_skinTex ||= skinTextures());
const behTex = () => (_behTex ||= behemothTextures());

/**
 * The live skin's shader edit. Physically based skin (MeshStandardMaterial) plus three cheap touches: large
 * world-space mottling so neighbouring titans of one archetype don't match, wet eyes and teeth (bright, non-skin
 * vertex colours get a low roughness), and a little warmth bleeding into the shadowed side (a subsurface cheat).
 * Only touches flesh (vertex colour = skin tone): eyes, teeth and hair keep their colours.
 */
function skinPatch(sh: THREE.WebGLProgramParametersWithUniforms): void {
  sh.vertexShader = 'varying vec3 vSkinW;\n' + sh.vertexShader.replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
    vSkinW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`);
  sh.fragmentShader = 'varying vec3 vSkinW;\n' + sh.fragmentShader
    .replace('#include <color_fragment>', `#include <color_fragment>
      float skinK = smoothstep( 0.05, 0.18, diffuseColor.r - diffuseColor.b ) * step( 0.35, diffuseColor.r );
      vec3 skinQ = vSkinW * 0.35;
      float skinMott = sin( skinQ.x * 1.3 + sin( skinQ.y * 1.7 ) ) * sin( skinQ.z * 1.1 + skinQ.y * 0.6 );
      diffuseColor.rgb *= 1.0 + 0.05 * skinMott * skinK;
      float skinWet = ( 1.0 - skinK ) * smoothstep( 0.45, 0.7, dot( diffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) ) );`)
    .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
      roughnessFactor = mix( roughnessFactor, 0.26, skinWet );`)
    .replace('#include <opaque_fragment>', `
      {
        float skinLum = dot( outgoingLight, vec3( 0.299, 0.587, 0.114 ) ), skinBase = dot( diffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
        float skinShade = clamp( 1.0 - skinLum / max( skinBase, 1e-3 ), 0.0, 1.0 );
        outgoingLight = mix( outgoingLight, outgoingLight * vec3( 1.22, 0.9, 0.8 ), skinShade * skinK * 0.85 );
      }
      #include <opaque_fragment>`);
}

/**
 * The Behemoth's shader edit: its muscle texture is mapped triplanar in mesh-local space (fibres run along a hanging
 * limb, no pinching at the poles of the body's ellipsoids), normals included (whiteout blend). Detail parts (teeth,
 * eyes) carry an out-of-range UV and keep their vertex colour and smooth normal. One material on one giant: the six
 * texture reads are cheap.
 */
const BEH_SCALE = '0.62';     // texture repeats per local unit (~7 m of muscle per tile on a 60 m giant)
function behemothPatch(sh: THREE.WebGLProgramParametersWithUniforms): void {
  sh.vertexShader = 'varying vec3 vBehP;\nvarying vec3 vBehN;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
    vBehP = position; vBehN = objectNormal;`);
  sh.fragmentShader = `uniform mat3 normalMatrix;
varying vec3 vBehP;
varying vec3 vBehN;
vec3 behBlend( vec3 n ) { vec3 b = pow( abs( n ), vec3( 4.0 ) ); return b / ( b.x + b.y + b.z ); }
` + sh.fragmentShader
    .replace('#include <map_fragment>', `
      #ifdef USE_MAP
      {
        vec3 bB = behBlend( normalize( vBehN ) ), bQ = vBehP * ${BEH_SCALE};
        vec4 bC = texture2D( map, bQ.zy ) * bB.x + texture2D( map, bQ.xz ) * bB.y + texture2D( map, bQ.xy ) * bB.z;
        diffuseColor *= mix( bC, vec4( 1.0 ), step( vMapUv.x, -0.5 ) );
      }
      #endif`)
    .replace('#include <normal_fragment_maps>', `
      #ifdef USE_NORMALMAP_TANGENTSPACE
      {
        vec3 bN = normalize( vBehN ), bB = behBlend( bN ), bQ = vBehP * ${BEH_SCALE};
        vec3 tX = texture2D( normalMap, bQ.zy ).xyz * 2.0 - 1.0;
        vec3 tY = texture2D( normalMap, bQ.xz ).xyz * 2.0 - 1.0;
        vec3 tZ = texture2D( normalMap, bQ.xy ).xyz * 2.0 - 1.0;
        tX.xy *= normalScale; tY.xy *= normalScale; tZ.xy *= normalScale;
        vec3 nX = vec3( tX.xy + bN.zy, abs( tX.z ) * bN.x );
        vec3 nY = vec3( tY.xy + bN.xz, abs( tY.z ) * bN.y );
        vec3 nZ = vec3( tZ.xy + bN.xy, abs( tZ.z ) * bN.z );
        vec3 bObj = normalize( nX.zyx * bB.x + nY.xzy * bB.y + nZ * bB.z );
        normal = normalize( normalMatrix * mix( bObj, bN, step( vNormalMapUv.x, -0.5 ) ) );
        #ifdef DOUBLE_SIDED
        normal *= faceDirection;
        #endif
      }
      #endif`);
}
const SKIN_KEY = 'titan-skin-v2', BEH_KEY = 'titan-behemoth-v3';

/** A body material: shared base (no tint) or one titan's own copy tinted by `tint` (same shader program). */
function makeBody(behemoth: boolean, tint?: THREE.Color): THREE.MeshStandardMaterial {
  const tex = behemoth ? behTex() : skinTex();
  const m = new THREE.MeshStandardMaterial({
    color: tint ? tint.clone() : 0xffffff, vertexColors: true, map: tex.map, normalMap: tex.normalMap,
    roughness: behemoth ? 0.4 : 0.6, metalness: 0,
  });
  m.normalScale.setScalar(behemoth ? 1.0 : 0.55);
  if (!behemoth) { m.onBeforeCompile = skinPatch; m.customProgramCacheKey = () => SKIN_KEY; }
  else { m.onBeforeCompile = behemothPatch; m.customProgramCacheKey = () => BEH_KEY; }
  return m;
}

let _matPlain: THREE.MeshStandardMaterial | null = null, _matBeh: THREE.MeshStandardMaterial | null = null;
/** The shared body material (or, given a tint, a new per-titan copy of it). */
export function bodyMaterial(behemoth: boolean, tint?: THREE.Color): THREE.MeshStandardMaterial {
  if (tint) return makeBody(behemoth, tint);
  if (behemoth) return (_matBeh ||= makeBody(true));
  return (_matPlain ||= makeBody(false));
}

const _cache = new Map<string, Archetype>();
/** Builds (once) and returns the geometry set for a design + size class. */
export function getArchetype(spec: TitanSpec & { size: SizeClass }): Archetype {
  const key = [spec.build, spec.size, spec.skin, spec.hair === false ? 'x' : spec.hair, spec.expr].join('|');
  const hit = _cache.get(key);
  if (hit) return hit;
  const rnd = mulberry(hashStr(key));
  const d = makeDims(spec.build, spec.size);
  const behemoth = !!d.B.behemoth;
  const st = EXPR[spec.expr] || EXPR.grin;
  const skin = behemoth ? 0xffffff : (SKINS[spec.skin] ?? SKINS.beige);
  const hairIdx = typeof spec.hair === 'number' ? spec.hair : 0;
  const hairC = HAIRS[hairIdx % HAIRS.length];
  const muscleCol = behemoth ? 0xf0dcd0 : d.B.female ? 0xb8604f : null;
  const { head, jaw } = buildHead(d, st, skin, hairC, rnd, spec.hair !== false && !behemoth);
  const geo: ArchGeo = {
    pelvis: buildPelvis(d, skin),
    spine: buildSpine(d, skin, muscleCol),
    head, jaw,
    arm: buildArm(d, skin, muscleCol),
    foreL: buildFore(d, skin, 1, false), foreR: buildFore(d, skin, -1, false),
    foreLFist: buildFore(d, skin, 1, true), foreRFist: buildFore(d, skin, -1, true),
    thigh: buildThigh(d, skin, d.B.female ? muscleCol : null), shin: buildShin(d, skin), foot: buildFoot(d, skin),
  };
  const arch: Archetype = { key, dims: d, st, geo, material: bodyMaterial(behemoth), behemoth, jawRest: st.open, skin };
  _cache.set(key, arch);
  return arch;
}

// =============================================================================================================
// Death: the body evaporates. A charred skeleton (per archetype, cached) sits inside the flesh, and the flesh /
// bone materials of a dying titan dissolve with a noise erosion while the flesh darkens to raw red.
// =============================================================================================================
const BONE = 0x3a2420, SOCKET = 0x080303, BONE_TEETH = 0x6a5644;

/** Joint-local skeleton geometry for an archetype. */
export function skeletonGeometry(arch: Archetype): Record<BoneKey, THREE.BufferGeometry> {
  if (arch.bones) return arch.bones;
  const d = arch.dims, B = d.B, lm = d.limb, tw = B.torsoW, th = B.torsoH, R = d.headR;
  const cy = d.cy, cz = d.cz, rx = d.rx, ry = d.ry, rz = d.rz;
  const mk = (fn: (P: Parts) => void) => { const P = new Parts(); fn(P); return P.build().full; };
  const out: Record<BoneKey, THREE.BufferGeometry> = {
    head: mk((P) => {
      ell(P, BONE, [0, cy + 0.08 * ry, cz - 0.06 * R], [0.8 * rx, 0.78 * ry, 0.8 * rz], { ws: 16, hs: 12 });          // cranium
      ell(P, BONE, [0, cy - 0.22 * ry, cz + 0.3 * rz], [0.56 * rx, 0.36 * ry, 0.48 * rz], { ws: 12, hs: 8 });         // maxilla
      for (const s of [-1, 1]) ell(P, SOCKET, [s * 0.36 * rx, cy + 0.04 * ry, cz + 0.62 * rz], [0.2 * R, 0.21 * R, 0.16 * R], { ao: 0, ws: 10, hs: 8 });
      ell(P, SOCKET, [0, cy - 0.16 * ry, cz + 0.72 * rz], [0.07 * R, 0.11 * R, 0.08 * R], { ao: 0, ws: 8, hs: 6 });   // nose
      ell(P, BONE_TEETH, [0, cy - 0.36 * ry, cz + 0.5 * rz], [0.46 * rx, 0.08 * ry, 0.3 * rz], { ao: 0, ws: 12, hs: 6 });
    }),
    jaw: mk((P) => {
      const j = d.jawPivot;
      ell(P, BONE, [0, cy - 0.5 * ry - j.y, cz + 0.28 * rz - j.z], [0.5 * rx, 0.11 * ry, 0.44 * rz], { ws: 12, hs: 6 });
    }),
    neck: mk((P) => capsule(P, BONE, [0, -0.3, -0.15], [0, d.neckLen + 0.2, -0.1], 0.17 * B.neckW, { rs: 8 })),
    spine: mk((P) => {
      capsule(P, BONE, [0, -0.1, -0.42], [0, d.neckY, -0.3], 0.15, { rs: 8 });                                          // column
      for (let i = 0; i < 6; i++) {                                                                                     // ribs
        const y = (0.85 + 0.3 * i) * th;
        const k = Math.sqrt(Math.max(0.08, 1 - ((y - 1.5 * th) / (1.45 * th)) ** 2));
        P.add(new THREE.TorusGeometry(1, 0.075, 5, 20), BONE, { pos: [0, y, -0.02], rot: [Math.PI / 2, 0, 0], scl: [0.98 * tw * k + 0.05, 0.66 * k + 0.05, 1.4] });
      }
      capsule(P, BONE, [0, 0.95 * th, 0.6], [0, 2.15 * th, 0.62], 0.08, { rs: 6 });                                    // sternum
      for (const s of [-1, 1]) {
        capsule(P, BONE, [s * 0.12, d.shoulderY + 0.12, 0.35], [s * d.shoulderX * 0.95, d.shoulderY + 0.05, 0.02], 0.085, { rs: 6 });
        ell(P, BONE, [s * 0.55 * tw, d.shoulderY - 0.35, -0.5], [0.34, 0.45, 0.08], { ws: 10, hs: 6 });                // scapula
        ell(P, BONE, [s * d.shoulderX, d.shoulderY, 0], [0.17 * lm + 0.06, 0.17 * lm + 0.06, 0.17 * lm + 0.06], { ws: 10, hs: 6 });
      }
    }),
    pelvis: mk((P) => {
      for (const s of [-1, 1]) ell(P, BONE, [s * 0.42 * tw, 0.15, -0.05], [0.36 * tw, 0.38, 0.2], { rot: [0, 0, s * 0.4], ws: 10, hs: 8 });
      ell(P, BONE, [0, 0.05, -0.3], [0.24, 0.34, 0.14], { ws: 10, hs: 6 });
      ell(P, BONE, [0, -0.2, 0.22], [0.34 * tw, 0.12, 0.12], { ws: 10, hs: 6 });
      capsule(P, BONE, [0, 0, -0.38], [0, 0.6, -0.42], 0.15, { rs: 8 });
    }),
    arm: mk((P) => {
      capsule(P, BONE, [0, 0, 0], [0, -d.upperLen + 0.1, 0], 0.11 * lm + 0.04, { rs: 7 });
      ell(P, BONE, [0, -d.upperLen + 0.1, 0], [0.18 * lm + 0.04, 0.1, 0.12 * lm + 0.04], { ws: 8, hs: 6 });
    }),
    fore: mk((P) => {
      const y1 = -(d.foreLen - 0.55 * d.handS), hs = d.handS;
      for (const s of [-1, 1]) capsule(P, BONE, [s * 0.08 * lm, -0.05, 0], [s * 0.08 * lm, y1, 0], 0.065 * lm + 0.03, { rs: 6 });
      ell(P, BONE, [0, y1 - 0.2 * hs, 0], [0.12 * hs, 0.28 * hs, 0.26 * hs], { ws: 8, hs: 6 });
      for (let i = 0; i < 4; i++) { const z = (i - 1.5) * 0.13 * hs; capsule(P, BONE, [0, y1 - 0.4 * hs, z], [0, y1 - 0.85 * hs, z * 1.1], 0.045 * hs, { rs: 5, cs: 2 }); }
    }),
    thigh: mk((P) => {
      ell(P, BONE, [0, 0, 0], [0.17 * lm + 0.06, 0.17 * lm + 0.06, 0.17 * lm + 0.06], { ws: 10, hs: 6 });
      capsule(P, BONE, [0, 0, 0], [0, -d.thighLen, 0], 0.13 * lm + 0.05, { rs: 7 });
      ell(P, BONE, [0, -d.thighLen + 0.05, 0], [0.22 * lm + 0.05, 0.12, 0.18 * lm + 0.05], { ws: 8, hs: 6 });
    }),
    shin: mk((P) => {
      capsule(P, BONE, [0, 0, 0.03], [0, -d.shinLen, 0], 0.1 * lm + 0.04, { rs: 7 });
      capsule(P, BONE, [0.12 * lm, -0.1, -0.05], [0.1 * lm, -d.shinLen + 0.1, -0.03], 0.04 * lm + 0.02, { rs: 5 });
    }),
    foot: mk((P) => {
      const w = 0.3 * Math.sqrt(lm) + 0.1;
      ell(P, BONE, [0, -d.ankleH + 0.15 * lm + 0.07, 0.4], [0.62 * w, 0.1 * lm + 0.06, 0.62], { ws: 10, hs: 6 });
    }),
  };
  arch.bones = out;
  return out;
}

// ---- dissolve shader: mesh-local fbm noise; `uErode` 0..1 eats the surface away, `uDark` chars the flesh
const EVAP_NOISE = `
uniform float uErode; uniform float uDark; uniform float uSeed;
varying vec3 vEvapP;
float evH( vec3 p ) { p = fract( p * 0.3183099 + 0.1 ); p *= 17.0; return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) ); }
float evN( vec3 x ) {
  vec3 i = floor( x ), f = fract( x ); f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( mix( evH( i ), evH( i + vec3( 1, 0, 0 ) ), f.x ), mix( evH( i + vec3( 0, 1, 0 ) ), evH( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
              mix( mix( evH( i + vec3( 0, 0, 1 ) ), evH( i + vec3( 1, 0, 1 ) ), f.x ), mix( evH( i + vec3( 0, 1, 1 ) ), evH( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
}
float evF( vec3 p ) { p += uSeed; return 0.55 * evN( p * 0.9 ) + 0.3 * evN( p * 2.3 ) + 0.15 * evN( p * 6.1 ); }
`;
const EVAP_CUT = `
  float evn = evF( vEvapP );
  float evThr = uErode > 0.0 ? mix( 0.14, 0.95, uErode ) : -1.0;
  if ( evn < evThr ) discard;
  float evEdge = uErode > 0.0 ? 1.0 - smoothstep( 0.0, 0.07, evn - evThr ) : 0.0;
`;
export interface EvapUniforms { uErode: { value: number }; uDark: { value: number }; uSeed: { value: number } }
type Shader = THREE.WebGLProgramParametersWithUniforms;

function evapVertex(sh: Shader): void {
  sh.vertexShader = 'varying vec3 vEvapP;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vEvapP = position;');
}
function evapUniforms(sh: Shader, U: EvapUniforms): void { sh.uniforms.uErode = U.uErode; sh.uniforms.uDark = U.uDark; sh.uniforms.uSeed = U.uSeed; }
function evapLit(sh: Shader, U: EvapUniforms, flesh: boolean): void {
  evapUniforms(sh, U); evapVertex(sh);
  sh.fragmentShader = EVAP_NOISE + sh.fragmentShader
    .replace('#include <color_fragment>', `#include <color_fragment>
      ${EVAP_CUT}
      {
        // the flesh chars: blotchy deep red-brown, raw bright red where it is eroding
        float evD = clamp( uDark * ( 0.7 + 0.6 * evN( vEvapP * 1.7 + 3.1 ) ), 0.0, 1.0 );
        diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.3, 0.05, 0.035 ), evD * ${flesh ? '0.93' : '0.0'} );
        diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.75, 0.12, 0.07 ), evEdge );
      }`)
    .replace('#include <opaque_fragment>', `outgoingLight += vec3( 0.9, 0.25, 0.12 ) * evEdge * 0.3;
      #include <opaque_fragment>`);
}

export interface EvapMaterials {
  body: THREE.MeshStandardMaterial;
  bone: THREE.MeshStandardMaterial;
  uniforms: EvapUniforms;
  boneUniforms: EvapUniforms;
  /** the skeleton meshes slipped inside the flesh (set by Titan._beginFade) */
  bonesMeshes: THREE.Mesh[];
  noShadow?: boolean;
}

/**
 * Fresh materials for one dying titan, all driven by the returned `uniforms` (shared shader programs).
 * `arch` needs only { behemoth, material } (titans.ts warms the programs up with bodyMaterial()); the body keeps
 * the material's tint.
 */
export function evapMaterials(arch: { behemoth: boolean; material: THREE.MeshStandardMaterial }): EvapMaterials {
  const U: EvapUniforms = { uErode: { value: 0 }, uDark: { value: 0 }, uSeed: { value: R.fx() * 50 } };
  const UB: EvapUniforms = { uErode: { value: 0 }, uDark: { value: 0 }, uSeed: U.uSeed };
  const body = makeBody(arch.behemoth, arch.material.color);
  if (arch.behemoth) {
    body.onBeforeCompile = (sh) => { behemothPatch(sh); evapLit(sh, U, true); };
    body.customProgramCacheKey = () => 'titan-evap-beh-v3';
  } else {
    body.onBeforeCompile = (sh) => { skinPatch(sh); evapLit(sh, U, true); };
    body.customProgramCacheKey = () => 'titan-evap-v2';
  }
  const bone = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.9, metalness: 0 });
  bone.onBeforeCompile = (sh) => evapLit(sh, UB, false);
  bone.customProgramCacheKey = () => 'titan-evap-bone-v2';
  return { body, bone, uniforms: U, boneUniforms: UB, bonesMeshes: [] };
}
