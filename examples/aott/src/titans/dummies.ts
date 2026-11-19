// TRAINING YARD: wooden titan dummies set up at the edge of the Greatwood for cadets to practise the cut on.
// Plank cutouts with a crude painted face and a dark leather pad on the back of the neck (the target). Seven stand
// on posts in the gaps between the giant trees, three hang from pulleys and slide back and forth along ropes strung
// between two trunks. The course is laid out at runtime from the real trunk colliders.
//
//   const course = new TrainingCourse(game);
//   course.start();                 // build once, reset all dummies, register colliders
//   course.update(dt);              // every frame (then collision.updateDynamic(), as for titans)
//   course.titans / hitTest(center, radius) / remaining / total / spawn
//   course.stop();                  // hide, remove every collider it added
//
// Dummy (duck-types a Titan): { kind: 'dummy', alive, dying: false, height, position, velocity, root, napeHp,
//   napeWorld() -> { center, normal } (a per-dummy cached object, copy it if you keep it),
//   applyHit({ part, damage, point, dir }) -> { killed, effect: 'kill' | 'shallow' | 'none' } }
// Events: game.events.emit('training:cut', { dummy, damage, point }).
//
// Look: weathered pine planks (vertex-coloured per board, a procedural grain texture laid along each board's
// length), hemp rope with a twisted-fibre texture, an oiled leather pad, and the face daubed on in chipped paint.
import * as THREE from 'hull/three';
import { mergeGeometries } from 'hull/three';
import { litMaterial } from '../core/style';
import { FS } from '../world/terrain';
import type { Game, HitResult } from '../types';
import type { BoxCollider, CollisionWorld, CylinderCollider, ShapeCollider } from '../core/collision';
import { R } from '../sim';
import { makeCanvas } from '../canvas';

// Math.hypot is variadic and boxes its arguments in hot loops (it was the top source of garbage); this doesn't.
const hypot = (a: number, b: number, c = 0): number => Math.sqrt(a * a + b * b + c * c);

type V3 = THREE.Vector3;
const V3 = THREE.Vector3;
type Triple = [number, number, number];
/** A box in model units: centre and half extents. */
interface ModelBox { c: Triple; h: Triple }

const UP = new V3(0, 1, 0);
const GRAVITY = 14.5;
export const CUT_DAMAGE = 260;      // nape damage needed to cut the pad (~17 m/s with fresh blades)
const H0 = 10;                      // dummies are modelled 10 units tall and scaled to their height
const T = 0.24;                     // plank thickness (model units)
const HANG = 1.8;                   // metres of rope between the pulley and the top of a hanging dummy
const PAD_C: Triple = [0, 7.95, -(T / 2 + 0.09)];                 // leather pad centre (model units)
const NAPE_BOX: ModelBox = { c: [0, 7.95, -0.2], h: [0.62, 0.52, 0.24] };
// body plank boxes in model units (hit test + hookable 'wood' colliders)
const BODY_BOXES: ModelBox[] = [
  { c: [-0.64, 2.15, 0], h: [0.5, 2.15, 0.16] },          // legs
  { c: [0.64, 2.15, 0], h: [0.5, 2.15, 0.16] },
  { c: [0, 5.85, -0.05], h: [1.62, 1.78, 0.24] },         // torso + back battens
  { c: [-1.95, 5.35, 0.07], h: [0.6, 2.05, 0.17] },       // arms
  { c: [1.95, 5.35, 0.07], h: [0.6, 2.05, 0.17] },
  { c: [0, 8.8, 0], h: [1.12, 1.3, 0.15] },               // neck + head
];

// weathered pine: greyed, sun-bleached boards with a few fresher ones
const WOOD = [0xb08a5e, 0xbf9868, 0xa27c55, 0xc8a470, 0x9a7a58, 0xb69062];
const DARK = 0x6e5136, POST = 0x5a432c, ROPE = 0xc4ad84, NAIL = 0x2b2622;

// ---------------------------------------------------------------------------------------------- temps
const _v0 = new V3(), _v1 = new V3(), _v2 = new V3(), _v3 = new V3();
const _q0 = new THREE.Quaternion(), _m0 = new THREE.Matrix4(), _e0 = new THREE.Euler(), _c0 = new THREE.Color();
const _inv = new THREE.Matrix4();

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const shade = (hex: number, k: number): number => _c0.set(hex).multiplyScalar(k).getHex();

// ---------------------------------------------------------------------------------------------- geometry bag
// Collects vertex-coloured primitives and merges them into one BufferGeometry (one draw call per material).
// UVs are in metres-ish (model units × UV_K) and run along each piece's length, so the grain textures follow
// every board and rope the way real grain and fibre do.
const UV_K = 0.35;
class Bag {
  list: THREE.BufferGeometry[] = [];
  _paint(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
    const n = g.attributes.position.count, a = new Float32Array(n * 3);
    _c0.set(hex);
    for (let i = 0; i < n; i++) { a[i * 3] = _c0.r; a[i * 3 + 1] = _c0.g; a[i * 3 + 2] = _c0.b; }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    this.list.push(g);
    return g;
  }
  /** Box UVs laid along the box's longest side on every face (before it is rotated and moved). */
  static _boxUV(g: THREE.BufferGeometry, sx: number, sy: number, sz: number, off: number): void {
    const p = g.attributes.position as THREE.BufferAttribute, nrm = g.attributes.normal as THREE.BufferAttribute, uv = g.attributes.uv as THREE.BufferAttribute;
    const size: Triple = [sx, sy, sz];
    for (let i = 0; i < p.count; i++) {
      const ax = Math.abs(nrm.getX(i)) > 0.5 ? 0 : Math.abs(nrm.getY(i)) > 0.5 ? 1 : 2;   // the face's normal axis
      const t1 = ax === 0 ? 1 : 0, t2 = ax === 2 ? 1 : 2;                                  // its two tangent axes
      const [along, across] = size[t1] >= size[t2] ? [t1, t2] : [t2, t1];
      const c = [p.getX(i), p.getY(i), p.getZ(i)];
      uv.setXY(i, c[along] * UV_K + off, c[across] * UV_K + off * 0.37);
    }
  }
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, hex: number, rz = 0, ry = 0, rx = 0): THREE.BufferGeometry {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    Bag._boxUV(g, sx, sy, sz, (cx * 7.1 + cy * 3.3 + cz * 5.7) % 1);
    if (rx || ry || rz) g.applyMatrix4(_m0.makeRotationFromEuler(_e0.set(rx, ry, rz)));
    g.translate(cx, cy, cz);
    return this._paint(g, hex);
  }
  /** a plank in an XY plane (depth z) from (ax, ay) to (bx, by) */
  strut(ax: number, ay: number, bx: number, by: number, z: number, w: number, t: number, hex: number): THREE.BufferGeometry {
    const dx = bx - ax, dy = by - ay;
    return this.box((ax + bx) / 2, (ay + by) / 2, z, w, hypot(dx, dy), t, hex, Math.atan2(-dx, dy));
  }
  /** a round rod (log, rope) between two points */
  rod(a: V3, b: V3, r: number, hex: number, seg = 6): THREE.BufferGeometry {
    const d = _v0.subVectors(b, a), len = d.length();
    const g = new THREE.CylinderGeometry(r, r, len, seg, 1);
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.max(1, 2 * Math.PI * r * UV_K * 4), uv.getY(i) * len * UV_K);
    g.applyQuaternion(_q0.setFromUnitVectors(UP, d.multiplyScalar(1 / len)));
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    return this._paint(g, hex);
  }
  /** a horizontal rope ring (lashing around a trunk) */
  ring(x: number, y: number, z: number, r: number, tube: number, hex: number): THREE.BufferGeometry {
    const g = new THREE.TorusGeometry(r, tube, 5, 24);
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2 * Math.PI * r * UV_K * 3, uv.getY(i));
    g.rotateX(Math.PI / 2); g.translate(x, y, z);
    return this._paint(g, hex);
  }
  merge(): THREE.BufferGeometry | null {
    if (!this.list.length) return null;
    const m = mergeGeometries(this.list, false);
    for (const g of this.list) g.dispose();
    this.list.length = 0;
    if (!m) return null;
    m.computeBoundingSphere();
    return m;
  }
}

// ---------------------------------------------------------------------------------------------- materials
interface Mats { wood: THREE.MeshStandardMaterial; rope: THREE.MeshStandardMaterial; pad: THREE.MeshStandardMaterial; face: THREE.MeshStandardMaterial }
let MATS: Mats | null = null;
function mats(): Mats {
  if (MATS) return MATS;
  const tile = (t: THREE.CanvasTexture | null): THREE.CanvasTexture | null => { if (t) { t.wrapS = t.wrapT = THREE.RepeatWrapping; } return t; };
  MATS = {
    wood: litMaterial(0xffffff, { vertexColors: true, map: tile(grainTexture('wood')), roughness: 0.82 }),
    rope: litMaterial(0xffffff, { vertexColors: true, map: tile(grainTexture('rope')), roughness: 0.95 }),
    pad: litMaterial(0xffffff, { vertexColors: true, map: tile(grainTexture('leather')), roughness: 0.62 }),
    face: litMaterial(0xffffff, { map: faceTexture(), alphaTest: 0.5, roughness: 0.88, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  };
  return MATS;
}

/**
 * A tiling greyscale detail texture multiplied over the vertex colours (mostly near white, so the board colours
 * stay in charge): 'wood' long wavy grain lines and the odd knot along u, 'rope' twisted diagonal strands, 'leather'
 * a fine pebbled grain.
 */
function grainTexture(kind: 'wood' | 'rope' | 'leather'): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const S = 512, cv = makeCanvas();
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  if (!g) return null;
  const r = mulberry(kind === 'wood' ? 11 : kind === 'rope' ? 23 : 37);
  const img = g.createImageData(S, S), d = img.data;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S;
    let k: number;
    if (kind === 'wood') {
      // grain lines running along u, wobbling, with tight dark late-wood bands
      const w = v * 46 + 0.6 * Math.sin(u * Math.PI * 2 + v * 7) + 0.08 * Math.sin(u * Math.PI * 10 + 2);
      const band = Math.pow(0.5 + 0.5 * Math.sin(w * Math.PI * 2), 8), fibre = Math.sin(v * S * 1.7 + Math.sin(u * 9) * 3);
      k = 0.97 - 0.16 * band - 0.03 * fibre + (r() - 0.5) * 0.05;
    } else if (kind === 'rope') {
      // three-strand twist: diagonal strands with dark grooves between them, fibres along the strands
      const s = (u * 3 + v * 6) % 1, groove = Math.pow(Math.abs(Math.sin(s * Math.PI)), 0.6);
      k = 0.62 + 0.38 * groove + (r() - 0.5) * 0.12;
    } else {
      k = 0.9 + (r() - 0.5) * 0.16;
    }
    const c = Math.max(0, Math.min(255, Math.round(k * 255))), i = (y * S + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = c; d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  if (kind === 'wood') {
    // a few knots: dark rings the grain bends round
    for (let n = 0; n < 3; n++) {
      const kx = r() * S, ky = r() * S, kr = 5 + r() * 7;
      for (let ring = 3; ring >= 0; ring--) {
        g.fillStyle = `rgba(60,40,25,${0.12 + ring * 0.05})`;
        g.beginPath(); g.ellipse(kx, ky, kr * (1 + ring * 0.9) * 2.2, kr * (1 + ring * 0.6), 0, 0, Math.PI * 2); g.fill();
      }
    }
  } else if (kind === 'leather') {
    g.fillStyle = 'rgba(30,20,12,0.18)';
    for (let n = 0; n < 900; n++) { g.beginPath(); g.arc(r() * S, r() * S, 0.6 + r() * 1.4, 0, Math.PI * 2); g.fill(); }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Crude titan face daubed on the boards in black, bone-white and rust-red paint, worn and chipped. */
function faceTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const S = 256, cv = makeCanvas();
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  if (!g) return null;
  const r = mulberry(77);
  g.lineCap = 'round'; g.lineJoin = 'round';
  const stroke = (pts: [number, number][], w: number, col: string, jit = 2.5, passes = 2): void => {
    g.strokeStyle = col;
    for (let p = 0; p < passes; p++) {
      g.lineWidth = w * (0.8 + r() * 0.35);
      g.beginPath();
      pts.forEach(([x, y], i) => { const jx = x + (r() - 0.5) * jit, jy = y + (r() - 0.5) * jit; if (i) g.lineTo(jx, jy); else g.moveTo(jx, jy); });
      g.stroke();
    }
  };
  const blob = (x: number, y: number, rx: number, ry: number, col: string, rot = 0): void => { g.fillStyle = col; g.beginPath(); g.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2); g.fill(); };
  const BLACK = '#211a15', BONE = '#ddd3bd', RED = '#7e2b20';
  // eyes: wide, mismatched, staring
  blob(80, 96, 33, 24, BONE, -0.08); blob(180, 92, 30, 27, BONE, 0.1);
  blob(86, 99, 10, 11, BLACK); blob(174, 96, 11, 12, BLACK);
  stroke([[46, 98], [60, 76], [84, 70], [108, 78], [116, 98], [100, 116], [74, 120], [50, 110], [46, 98]], 7, BLACK);
  stroke([[148, 92], [158, 70], [182, 64], [206, 74], [212, 94], [198, 116], [172, 120], [152, 108], [148, 92]], 7, BLACK);
  // brows and nose
  stroke([[40, 66], [76, 54], [112, 62]], 11, BLACK, 4);
  stroke([[146, 60], [186, 48], [218, 60]], 11, BLACK, 4);
  stroke([[128, 108], [122, 140], [132, 146], [142, 140]], 6, BLACK);
  // the grin: a wide bone-white crescent full of teeth
  g.fillStyle = BONE; g.beginPath();
  g.moveTo(36, 168); g.quadraticCurveTo(128, 150, 222, 164); g.quadraticCurveTo(130, 226, 36, 168); g.fill();
  stroke([[34, 168], [80, 160], [128, 156], [176, 158], [224, 164]], 6, BLACK);
  stroke([[36, 170], [80, 196], [128, 206], [178, 198], [222, 166]], 7, BLACK);
  stroke([[40, 176], [100, 180], [160, 180], [216, 172]], 3, BLACK, 1.5, 1);
  for (let i = 0; i < 12; i++) { const x = 52 + i * 14.5; stroke([[x, 160 - Math.sin(i / 11 * Math.PI) * 4], [x + (r() - 0.5) * 3, 196 + Math.sin(i / 11 * Math.PI) * 8]], 2.5, BLACK, 1.5, 1); }
  // rust-red cheek slashes and drips (cadet graffiti)
  stroke([[26, 130], [58, 142]], 6, RED, 3); stroke([[26, 144], [54, 152]], 5, RED, 3);
  stroke([[204, 138], [234, 128]], 6, RED, 3);
  for (const [x, y, l] of [[70, 202, 26], [150, 204, 34], [196, 186, 18]]) stroke([[x, y], [x + 1, y + l]], 4, BLACK, 1, 1);
  // weathering: chips where the paint has flaked off the boards (alpha-tested away) and dirt in the rest
  g.globalCompositeOperation = 'destination-out';
  for (let n = 0; n < 160; n++) { g.beginPath(); g.ellipse(r() * S, r() * S, 0.8 + r() * 3.2, 0.6 + r() * 1.6, r() * Math.PI, 0, Math.PI * 2); g.fill(); }
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = 'rgba(70,55,40,0.22)';
  for (let n = 0; n < 500; n++) { g.beginPath(); g.arc(r() * S, r() * S, 0.5 + r() * 2, 0, Math.PI * 2); g.fill(); }
  g.globalCompositeOperation = 'source-over';
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// ---------------------------------------------------------------------------------------------- dummy model
/**
 * Builds one dummy's merged geometries in model units (10 tall, facing +z, nape pad on -z).
 * opt.postBottom: model-unit y of the bottom of the ground posts (post dummies), opt.pivotY: pulley rope y (hangers).
 */
interface DummyGeometry { wood: THREE.BufferGeometry | null; rope: THREE.BufferGeometry | null; pad: THREE.BufferGeometry | null }
function buildDummyGeometry(rnd: () => number, opt: { postBottom?: number; pivotY?: number }): DummyGeometry {
  const W = new Bag(), R = new Bag(), P = new Bag();
  const plank = () => shade(WOOD[Math.floor(rnd() * WOOD.length)], 0.88 + rnd() * 0.22);
  const dark = () => shade(DARK, 0.85 + rnd() * 0.25);
  const rope = () => shade(ROPE, 0.9 + rnd() * 0.15);
  const zb = -T * 0.95;   // depth of the back battens

  // legs: two boards each, a foot block, lashings
  for (const sx of [-1, 1]) {
    for (const k of [0, 1]) {
      const top = 4.25 + rnd() * 0.25;
      W.box(sx * (0.42 + k * 0.45), top / 2, 0, 0.43, top, T, plank(), (rnd() - 0.5) * 0.025);
    }
    W.box(sx * 0.66, 0.17, 0.2, 1.08, 0.34, 0.72, dark());
    for (const y of [0.75, 2.2, 3.95]) R.box(sx * 0.64, y, 0, 1.0, 0.11, T + 0.08, rope());
  }
  // torso: horizontal planks from the waist out to the chest, a bit crooked
  const n = 8;
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1), w = 2.3 + 0.85 * Math.sin(f * Math.PI * 0.5) + (rnd() - 0.5) * 0.2;
    const y = 4.3 + i * 0.44;
    W.box((rnd() - 0.5) * 0.12, y, 0, w, 0.4, T, plank(), (rnd() - 0.5) * 0.05);
    for (const sx of [-1, 1]) W.box(sx * 1.0, y + (rnd() - 0.5) * 0.08, T / 2 + 0.012, 0.075, 0.075, 0.03, NAIL);
  }
  // back battens holding the planks
  for (const sx of [-1, 1]) W.box(sx * 1.0, 5.8, zb, 0.3, 4.1, 0.2, dark());
  if (opt.pivotY) W.strut(-0.95, 4.3, 0.95, 7.2, zb - 0.1, 0.22, 0.16, dark());
  // arms: upper arm + forearm boards, a block hand, lashed at shoulder and elbow
  for (const sx of [-1, 1]) {
    const sh = [sx * 1.5, 7.3], el = [sx * (2.0 + rnd() * 0.12), 5.35 + rnd() * 0.25], ha = [sx * (2.18 + rnd() * 0.15), 3.75] as const;
    W.strut(sh[0], sh[1], el[0], el[1], 0.05, 0.62, T, plank());
    W.strut(el[0], el[1], ha[0], ha[1], 0.09, 0.52, T, plank());
    W.box(ha[0], ha[1] - 0.3, 0.09, 0.82, 0.76, T + 0.05, plank(), sx * 0.08);
    R.box(el[0], el[1], 0.07, 0.72, 0.13, T + 0.14, rope(), Math.atan2(-(ha[0] - sh[0]), ha[1] - sh[1]) + Math.PI / 2);
    R.box(sh[0], sh[1] - 0.15, 0.03, 0.74, 0.13, T + 0.14, rope(), sx * 0.2);
  }
  // neck and head (three boards), ears, head battens
  W.box(0, 7.98, 0, 0.82, 1.0, T, dark());
  R.box(0, 7.52, 0, 0.94, 0.11, T + 0.08, rope());
  for (const sx of [-1, 0, 1]) { const top = 9.95 + rnd() * 0.15; W.box(sx * 0.62, (8.35 + top) / 2, 0, 0.6, top - 8.35, T, plank(), (rnd() - 0.5) * 0.03); }
  for (const sx of [-1, 1]) W.box(sx * 1.03, 9.05, -0.02, 0.24, 0.55, T * 0.8, plank());
  for (const y of [8.62, 9.68]) W.box(0, y, zb, 2.0, 0.22, 0.18, dark());

  // ground posts (post dummies): two logs behind the legs, kick braces, lashings
  if (opt.postBottom != null) {
    const pb = opt.postBottom, gy = pb + 0.6, pz = -(T / 2 + 0.19);
    for (const sx of [-1, 1]) {
      W.rod(new V3(sx * 0.64, pb, pz), new V3(sx * 0.64, 7.05, pz), 0.17, shade(POST, 0.9 + rnd() * 0.2), 7);
      W.rod(new V3(sx * 0.64, gy - 0.2, pz - 2.6), new V3(sx * 0.64, Math.min(3.2, gy + 3.6), pz - 0.05), 0.12, shade(POST, 0.95), 6);
      for (const y of [1.0, 3.2, 5.0, 6.7]) if (y > gy + 0.3) R.box(sx * 0.64, y, -0.17, 0.58, 0.1, 0.62, rope());
    }
    W.box(0, gy + 0.25, pz, 1.9, 0.22, 0.24, dark());
  }
  // pulley hanger: battens up to a yoke, ropes to a pulley block riding the line
  if (opt.pivotY) {
    const py = opt.pivotY, z = -0.35;
    for (const sx of [-1, 1]) W.box(sx * 0.85, 9.0, zb - 0.12, 0.26, 3.2, 0.18, dark());
    W.box(0, 10.55, z, 2.9, 0.26, 0.26, dark());
    for (const sx of [-1, 1]) {
      R.rod(new V3(sx * 1.3, 10.6, z), new V3(0, py - 0.85, z), 0.07, ROPE, 5);
      R.box(sx * 1.3, 10.55, z, 0.2, 0.36, 0.36, rope());
    }
    W.box(0, py - 0.62, z, 0.46, 0.62, 0.44, 0x4a3220);
    W.rod(new V3(0, py - 0.3, z - 0.11), new V3(0, py - 0.3, z + 0.11), 0.3, 0x3a2a1c, 12);
  }

  // leather nape pad (its own mesh: it flies off when cut). Local origin = pad centre, outer face toward -z.
  P.box(0, 0, 0.02, 1.06, 0.8, 0.12, 0x3b2617);
  P.box(0, 0, -0.05, 0.84, 0.58, 0.12, 0x4a301c);
  for (const sy of [-1, 1]) P.box(0, sy * 0.34, -0.045, 0.94, 0.03, 0.02, 0xc9a26a);
  for (const sx of [-1, 1]) P.box(sx * 0.47, 0, -0.045, 0.03, 0.66, 0.02, 0xc9a26a);
  for (const sy of [-1, 1]) P.box(0, sy * 0.25, 0.19, 0.94, 0.09, 0.38, 0x2a1a10);

  return { wood: W.merge(), rope: R.merge(), pad: P.merge() };
}

let FACE_GEO: THREE.PlaneGeometry | null = null;

/** A rope line between two trunks with a dummy sliding along it. */
interface Pulley {
  a: V3; b: V3; dir: V3; L: number;
  /** centre of the slide and its half-length (m along dir from a) */
  mid: number; amp: number;
  omega: number; phase0: number; phase: number;
  /** which way the trolley's acceleration swings the board (root-local x vs the rope) */
  sgn: number;
  /** pendulum length (m) */
  len: number;
}
/** A giant tree, gathered from its trunk colliders. */
interface Tree {
  x: number; z: number;
  segs: { y0: number; y1: number; r: number }[];
  cols: CylinderCollider[];
  gy: number; r: number; top: number;
  rAt(y: number): number;
}
interface Span { A: Tree; B: Tree; a: V3; b: V3; dir: V3; L: number; y: number; h: number; hw: number }
type DummySpec = { height: number; yaw: number } & (
  | { pulley: Pulley; span: Span; elevation?: undefined; ground?: undefined }
  | { pulley?: undefined; elevation: number; ground: V3 }
);
interface Tower { x: number; z: number; gy: number; deck: number; yaw: number }
interface CoursePlan { specs: DummySpec[]; spans: Span[]; tower: Tower; trees: Tree[] }
interface StaticBox { center: V3; halfExtents: V3; quaternion: THREE.Quaternion }
export interface DummyHit { titan: Dummy; part: 'nape' | 'body'; point: V3 }

export class Dummy {
  course: TrainingCourse;
  game: Game;
  index: number;
  readonly kind = 'dummy';
  pulley: Pulley | null;
  height: number;
  /** model scale (height / 10) */
  s: number;
  alive = true;
  dying = false;
  readonly isBehemoth = false;
  napeHp = CUT_DAMAGE;
  position = new V3();
  velocity = new V3();
  yaw: number;
  root: THREE.Group;
  pivot: THREE.Group;
  body: THREE.Group;
  postBottom = 0;
  meshes: { wood: THREE.Mesh; rope: THREE.Mesh; face: THREE.Mesh; pad: THREE.Mesh };
  pad: THREE.Mesh;
  boxes: ModelBox[];
  colliders: BoxCollider[] = [];
  t = 0; cutT = 0;
  tilt = 0; tiltV = 0; tiltRest = 0; tiltDirX = 0; tiltDirZ = 1;
  swing = 0; swingV = 0;
  shakeT = 0;
  padFlying = false; padResting = false;
  padVel = new V3(); padSpin = new V3();
  amp = 1;
  _nape = { center: new V3(), normal: new V3() };
  /** bounding centre (world) */
  _bc = new V3();
  /** bounding radius */
  br: number;

  constructor(course: TrainingCourse, spec: DummySpec, index: number) {
    this.course = course; this.game = course.game; this.index = index;
    this.pulley = spec.pulley || null;
    this.height = spec.height;
    this.s = spec.height / H0;
    this.yaw = spec.yaw;
    const s = this.s, rnd = mulberry(1000 + index * 77);

    // hierarchy: root (ground point or pulley point, yawed) -> pivot (sway / swing) -> body (scaled model)
    this.root = new THREE.Group(); this.root.name = 'dummy' + index;
    this.pivot = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.pivot); this.pivot.add(this.body);
    this.root.rotation.y = spec.yaw;
    this.body.scale.setScalar(s);
    let geo: DummyGeometry;
    if (spec.pulley) {
      const pivotY = H0 + HANG / s;
      geo = buildDummyGeometry(rnd, { pivotY });
      this.body.position.set(0, -pivotY * s, 0.35 * s);
      this.root.position.copy(spec.pulley.a);
    } else {
      const e = spec.elevation;
      geo = buildDummyGeometry(rnd, { postBottom: -(e / s) - 0.6 });
      this.body.position.set(0, e, 0);
      this.root.position.copy(spec.ground);
      this.postBottom = -(e / s) - 0.6;
    }
    const M = mats();
    const wood = new THREE.Mesh(geo.wood ?? undefined, M.wood); wood.castShadow = true; wood.receiveShadow = true;
    const rope = new THREE.Mesh(geo.rope ?? undefined, M.rope); rope.castShadow = true;
    if (!FACE_GEO) FACE_GEO = new THREE.PlaneGeometry(1.9, 1.75);
    const face = new THREE.Mesh(FACE_GEO, M.face); face.position.set(0, 9.2, T / 2 + 0.012);
    const pad = new THREE.Mesh(geo.pad ?? undefined, M.pad); pad.castShadow = true;
    pad.position.set(PAD_C[0], PAD_C[1], PAD_C[2]);
    this.body.add(wood, rope, face, pad);
    this.meshes = { wood, rope, face, pad };
    this.pad = pad;

    // colliders (model units); posts/yoke extra
    this.boxes = BODY_BOXES.slice();
    if (this.pulley) this.boxes.push({ c: [0, 10.55, -0.35], h: [1.45, 0.14, 0.14] });
    else {
      const pb = this.postBottom + 0.6;   // ground level in model units
      for (const sx of [-1, 1]) this.boxes.push({ c: [sx * 0.64, (7.05 + pb) / 2, -(T / 2 + 0.19)], h: [0.18, (7.05 - pb) / 2, 0.18] });
    }
    this.br = 6.2 * s;
    this.reset();
  }

  // ----------------------------------------------------------- lifecycle
  reset(): void {
    this.alive = true; this.dying = false;
    this.t = 0; this.cutT = 0;
    this.tilt = 0; this.tiltV = 0; this.tiltRest = 0;
    this.swing = 0; this.swingV = 0; this.shakeT = 0; this.amp = 1;
    this.padFlying = false; this.padResting = false;
    const pad = this.pad;
    if (pad.parent !== this.body) this.body.add(pad);
    pad.position.set(PAD_C[0], PAD_C[1], PAD_C[2]);
    pad.rotation.set(0, 0, 0); pad.scale.setScalar(1);
    this.pivot.rotation.set(0, 0, 0);
    this.velocity.set(0, 0, 0);
    if (this.pulley) { this.pulley.phase = this.pulley.phase0; this._placeOnRope(); }
    this._sync();
  }
  _sync(): void {
    this.root.updateMatrixWorld(true);
    this.position.setFromMatrixPosition(this.body.matrixWorld);
    this._bc.set(0, 5.2, 0).applyMatrix4(this.body.matrixWorld);
  }
  addColliders(col: CollisionWorld): void {
    this.removeColliders(col);
    this._sync();
    const dyn = !!this.pulley;
    const userData = { titan: this, dummy: this, part: 'body' };
    const mw = this.body.matrixWorld, s = this.s;
    if (!dyn) this.body.getWorldQuaternion(_q0);
    for (const b of this.boxes) {
      const center = new V3(b.c[0], b.c[1], b.c[2]), half = new V3(b.h[0], b.h[1], b.h[2]);
      if (dyn) this.colliders.push(col.addBox({ center, halfExtents: half, object3D: this.body, dynamic: true, material: 'wood', hookable: true, userData }));
      else this.colliders.push(col.addBox({ center: center.applyMatrix4(mw), halfExtents: half.multiplyScalar(s), quaternion: _q0.clone(), material: 'wood', hookable: true, userData }));
    }
  }
  removeColliders(col: CollisionWorld): void {
    for (const c of this.colliders) col.remove(c);
    this.colliders.length = 0;
  }

  // ----------------------------------------------------------- per frame
  _placeOnRope(): number {
    const p = this.pulley;
    if (!p) return 0;
    const u = p.mid + p.amp * this.amp * Math.sin(p.phase);
    this.root.position.copy(p.a).addScaledVector(p.dir, u);
    return u;
  }
  update(dt: number): void {
    this.t += dt;
    let moved = false;
    if (this.pulley) {
      const p = this.pulley;
      if (!this.alive) this.amp = Math.max(0, this.amp - dt * 0.35);
      const u0 = p.mid + p.amp * this.amp * Math.sin(p.phase);
      p.phase += p.omega * dt;
      const u1 = this._placeOnRope();
      const vAlong = (u1 - u0) / dt;
      this.velocity.copy(p.dir).multiplyScalar(vAlong);
      // pendulum in the rope's vertical plane (rotation about the root's local z), driven by the trolley
      const acc = -p.amp * this.amp * p.omega * p.omega * Math.sin(p.phase) * p.sgn;
      const L = p.len, k = 4, h = dt / k;
      for (let i = 0; i < k; i++) {
        this.swingV += (-(GRAVITY / L) * Math.sin(this.swing) - (acc / L) * Math.cos(this.swing) - 0.6 * this.swingV) * h;
        this.swing += this.swingV * h;
      }
      this.pivot.rotation.z = this.swing;
      moved = true;
    }
    if (this.tilt !== 0 || this.tiltV !== 0) {
      // damped sway after a cut, settling at a slight lean
      const a = -40 * (this.tilt - this.tiltRest) - 2.2 * this.tiltV;
      this.tiltV += a * dt; this.tilt += this.tiltV * dt;
      if (Math.abs(this.tiltV) < 1e-3 && Math.abs(this.tilt - this.tiltRest) < 1e-3) { this.tilt = this.tiltRest; this.tiltV = 0; }
      if (!this.pulley) { this.pivot.rotation.x = this.tilt * this.tiltDirZ; this.pivot.rotation.z = -this.tilt * this.tiltDirX; }
      moved = true;
    }
    if (this.shakeT > 0 && this.pad.parent === this.body) {
      this.shakeT = Math.max(0, this.shakeT - dt);
      const k = this.shakeT * 0.5;
      this.pad.position.set(PAD_C[0] + Math.sin(this.t * 61) * 0.06 * k, PAD_C[1] + Math.sin(this.t * 47 + 1) * 0.05 * k, PAD_C[2]);
      this.pad.rotation.z = Math.sin(this.t * 53) * 0.12 * k;
      moved = true;
    }
    if (this.padFlying) this._padPhysics(dt);
    if (moved) this._sync();
  }
  _padPhysics(dt: number): void {
    const pad = this.pad, v = this.padVel;
    v.y -= GRAVITY * dt;
    v.multiplyScalar(1 - Math.min(1, 0.4 * dt));
    pad.position.addScaledVector(v, dt);
    pad.rotation.x += this.padSpin.x * dt; pad.rotation.y += this.padSpin.y * dt; pad.rotation.z += this.padSpin.z * dt;
    const gh = this.game.collision.groundHeight(pad.position.x, pad.position.z) + 0.07 * this.s;
    if (pad.position.y < gh) {
      pad.position.y = gh;
      if (v.y < 0) v.y = -v.y * 0.3;
      v.x *= 0.55; v.z *= 0.55; this.padSpin.multiplyScalar(0.45);
      if (v.lengthSq() < 0.8) {
        this.padFlying = false; this.padResting = true;
        pad.rotation.set(-Math.PI / 2, 0, pad.rotation.z);   // lie flat, stitched face up
        pad.position.y = gh;
      }
    }
    pad.updateMatrixWorld();
  }

  // ----------------------------------------------------------- titan duck type
  napeWorld(): { center: V3; normal: V3 } {
    const mw = this.body.matrixWorld;
    this._nape.center.set(PAD_C[0], PAD_C[1], PAD_C[2] - 0.08).applyMatrix4(mw);
    this.body.getWorldQuaternion(_q0);
    this._nape.normal.set(0, 0.15, -1).normalize().applyQuaternion(_q0);
    return this._nape;
  }
  hitTest(center: V3, radius: number, out: DummyHit[]): DummyHit[] {
    if (!this.alive) return out;
    const R = this.br + radius;
    if (this._bc.distanceToSquared(center) > R * R) return out;
    _inv.copy(this.body.matrixWorld).invert();
    const p = _v0.copy(center).applyMatrix4(_inv), rl = radius / this.s;
    const dn = boxDist(p, NAPE_BOX, _v1);
    if (dn <= rl) out.push({ titan: this, part: 'nape', point: _v1.clone().applyMatrix4(this.body.matrixWorld) });
    let best = Infinity;
    for (const b of BODY_BOXES) {
      const d = boxDist(p, b, _v2);
      if (d < best) { best = d; _v3.copy(_v2); }
    }
    if (best <= rl) out.push({ titan: this, part: 'body', point: _v3.clone().applyMatrix4(this.body.matrixWorld) });
    return out;
  }
  applyHit({ part = 'body', damage = 0, point = null, dir = null }: { part?: string; damage?: number; point?: V3 | null; dir?: V3 | null } = {}): HitResult {
    if (!this.alive || !this.course.active) return { killed: false, effect: 'none' };
    const g = this.game, nw = this.napeWorld();
    const pt = point || nw.center;
    if (part === 'nape') {
      if (damage >= CUT_DAMAGE) {
        this._cut(pt, dir, damage);
        return { killed: true, effect: 'kill' };
      }
      this.shakeT = 0.7;
      g.fx?.impact?.(pt, nw.normal, 'wood');
      g.audio?.hookHit?.('wood', pt);
      return { killed: false, effect: 'shallow' };
    }
    // a wooden thunk: chips fly off the face of the board that was struck
    _inv.copy(this.body.matrixWorld).invert();
    const front = _v1.copy(pt).applyMatrix4(_inv).z >= 0 ? 1 : -1;
    g.fx?.impact?.(pt, _v0.set(0, 0, front).applyQuaternion(this.body.getWorldQuaternion(_q0)), 'wood');
    g.audio?.hookHit?.('wood', pt);
    return { killed: false, effect: 'none' };
  }
  _cut(point: V3, dir: V3 | null, damage: number): void {
    const g = this.game, nw = this.napeWorld();
    this.alive = false; this.cutT = this.t;
    // the pad tears off: reparent to the course root at its current world pose and give it a tumble
    const pad = this.pad;
    pad.position.set(PAD_C[0], PAD_C[1], PAD_C[2]); pad.rotation.set(0, 0, 0);
    this.body.updateMatrixWorld(true);
    pad.updateMatrixWorld(true);
    pad.matrixWorld.decompose(_v0, _q0, _v1);
    this.course.group.add(pad);
    pad.position.copy(_v0); pad.quaternion.copy(_q0); pad.scale.copy(_v1);
    const d = dir ? _v2.copy(dir) : _v2.copy(nw.normal).negate();
    d.y = 0; if (d.lengthSq() < 1e-6) d.copy(nw.normal); d.normalize();
    const r = R.sim;
    this.padVel.copy(nw.normal).multiplyScalar(4 + r() * 2).addScaledVector(d, 6 + r() * 4).add(this.velocity);
    this.padVel.y += 5 + r() * 3;
    this.padSpin.set((r() - 0.5) * 18, (r() - 0.5) * 14, (r() - 0.5) * 18);
    this.padFlying = true; this.padResting = false;
    // the board rocks with the blow
    this.root.getWorldQuaternion(_q0).invert();
    _v3.copy(d).applyQuaternion(_q0);   // hit direction in root space
    this.tiltDirX = _v3.x; this.tiltDirZ = _v3.z;
    const n = hypot(this.tiltDirX, this.tiltDirZ) || 1; this.tiltDirX /= n; this.tiltDirZ /= n;
    if (this.pulley) {
      this.swingV += -Math.sign(this.tiltDirX || 1) * (0.6 + Math.min(damage, 900) / 900);
    } else {
      this.tiltV = 0.9 + Math.min(damage, 900) / 1500; this.tiltRest = 0.05 + r() * 0.05; this.tilt = 1e-4;
    }
    g.fx?.impact?.(point, nw.normal, 'wood');
    g.fx?.impact?.(nw.center, _v0.copy(nw.normal).add(UP).normalize(), 'wood');
    g.audio?.napeKill?.();
    g.audio?.hookHit?.('wood', point);
    g.events?.emit?.('training:cut', { dummy: this, damage, point: point.clone() });
    this._sync();
  }
}

/** distance from point p to an axis-aligned model-space box, closest point written to out */
function boxDist(p: V3, b: ModelBox, out: V3): number {
  const cx = Math.min(Math.max(p.x, b.c[0] - b.h[0]), b.c[0] + b.h[0]);
  const cy = Math.min(Math.max(p.y, b.c[1] - b.h[1]), b.c[1] + b.h[1]);
  const cz = Math.min(Math.max(p.z, b.c[2] - b.h[2]), b.c[2] + b.h[2]);
  out.set(cx, cy, cz);
  return hypot(p.x - cx, p.y - cy, p.z - cz);
}

// ---------------------------------------------------------------------------------------------- course layout
const N_DUMMIES = 10;
const PULLEY_SLOTS = [2, 5, 8];
const POST_HEIGHTS = [7.5, 9, 12, 8, 10.5, 6.5, 11];
const route = (t: number, out: V3): V3 => out.set(-12 + 78 * Math.sin(t * Math.PI * 1.9 + 0.35), 0, 212 + FS + 258 * t);

function gatherTrees(col: CollisionWorld): Tree[] {
  const map = new Map<string, Tree>();
  for (const c of col.statics) {
    if (c.type !== 'cylinder' || c.material !== 'bark') continue;
    const key = Math.round(c.x * 100) + ',' + Math.round(c.z * 100);
    let t = map.get(key);
    if (!t) {
      const tree: Tree = { x: c.x, z: c.z, segs: [], cols: [], gy: 0, r: 0, top: 0, rAt: () => 0 };
      map.set(key, t = tree);
    }
    t.segs.push({ y0: c.y0, y1: c.y1, r: c.r / 0.97 });
    t.cols.push(c);
  }
  const trees: Tree[] = [];
  for (const t of map.values()) {
    t.segs.sort((a, b) => a.y0 - b.y0);
    t.gy = t.segs[0].y0 + 2; t.r = t.segs[0].r; t.top = t.segs[t.segs.length - 1].y1;
    t.rAt = (y: number): number => { for (const s of t.segs) if (y >= s.y0 && y <= s.y1) return s.r; return t.segs[t.segs.length - 1].r; };
    trees.push(t);
  }
  return trees;
}
function segDist2D(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  return hypot(px - (ax + dx * t), pz - (az + dz * t));
}

function planCourse(col: CollisionWorld): CoursePlan {
  const trees = gatherTrees(col).filter((t) => Math.abs(t.x) < 260 && t.z > 120 + FS && t.z < 560 + FS);
  const clearOf = (x: number, z: number): number => { let m = Infinity; for (const t of trees) m = Math.min(m, hypot(t.x - x, t.z - z) - t.r); return m; };
  const blocked = (p: V3, r: number, ignore?: Set<ShapeCollider>): boolean => col.querySphere(p, r, { dynamic: false }).some((c) => !ignore || !ignore.has(c));
  const stations: V3[] = [];
  for (let i = 0; i < N_DUMMIES; i++) stations.push(route((i + 0.5) / N_DUMMIES, new V3()));
  const specs: (DummySpec | null)[] = new Array<DummySpec | null>(N_DUMMIES).fill(null);
  const spans: Span[] = [];

  // --- pulley lines: two trunks 28-62 m apart near the station, a clear line and a clear sweep under it
  for (const i of PULLEY_SLOTS) {
    const S = stations[i];
    const near = trees.filter((t) => hypot(t.x - S.x, t.z - S.z) < 70);
    const pairs: { A: Tree; B: Tree; D: number; score: number }[] = [];
    for (let a = 0; a < near.length; a++) for (let b = a + 1; b < near.length; b++) {
      const A = near[a], B = near[b], D = hypot(A.x - B.x, A.z - B.z);
      if (D < 28 || D > 62) continue;
      const mx = (A.x + B.x) / 2, mz = (A.z + B.z) / 2, md = hypot(mx - S.x, mz - S.z);
      if (md > 30 || Math.abs(mx) > 150 || mz < 200 + FS || mz > 470 + FS) continue;
      if (trees.some((t) => t !== A && t !== B && segDist2D(t.x, t.z, A.x, A.z, B.x, B.z) < t.r + 5)) continue;
      if (spans.some((sp) => segDist2D(mx, mz, sp.A.x, sp.A.z, sp.B.x, sp.B.z) < 30)) continue;
      pairs.push({ A, B, D, score: md + Math.abs(D - 42) * 0.4 });
    }
    pairs.sort((p, q) => p.score - q.score);
    const H = [6.5, 7.5, 6.0][PULLEY_SLOTS.indexOf(i)], s = H / H0;
    let found: { span: Span; H: number } | null = null;
    for (const pr of pairs.slice(0, 14)) {
      const { A, B } = pr, ignore = new Set<ShapeCollider>([...A.cols, ...B.cols]);
      for (const h of [22, 20, 24, 18, 26, 17, 28]) {
        const y = (A.gy + B.gy) / 2 + h;
        const dir = new V3(B.x - A.x, 0, B.z - A.z).normalize();
        const a = new V3(A.x, y, A.z).addScaledVector(dir, A.rAt(y) + 0.15);
        const b = new V3(B.x, y, B.z).addScaledVector(dir, -(B.rAt(y) + 0.15));
        const L = a.distanceTo(b), hw = 2.75 * s + 1.6;
        if (L - 2 * hw < 8) continue;
        let ok = true;
        for (let u = 1; u < L - 1 && ok; u += 2.5) if (blocked(_v0.copy(a).addScaledVector(dir, u), 0.6, ignore)) ok = false;
        for (let u = hw; u <= L - hw && ok; u += 2) {
          const c = _v0.copy(a).addScaledVector(dir, u); c.y -= HANG + H * 0.5;
          if (blocked(c, H * 0.55, ignore)) ok = false;
        }
        if (!ok) continue;
        if (y - HANG - H - col.groundHeight((a.x + b.x) / 2, (a.z + b.z) / 2) < 5) continue;
        const span: Span = { A, B, a, b, dir, L, y, h, hw };
        found = { span, H };
        break;
      }
      if (found) break;
    }
    if (!found) { console.warn('[training] no pulley line near station', i); continue; }
    const { span, H: Hd } = found;
    spans.push(span);
    const amp = Math.min(14, (span.L - 2 * span.hw) / 2), mid = span.L / 2;
    const vmax = 5 + (i % 3);
    const omega = Math.min(Math.PI * 2 / 6, Math.max(Math.PI * 2 / 14, vmax / Math.max(amp, 1)));
    specs[i] = { pulley: { a: span.a, b: span.b, dir: span.dir, L: span.L, mid, amp, omega, phase0: i * 1.3, phase: 0, sgn: 1, len: HANG + Hd * 0.55 }, height: Hd, span, yaw: 0 };
  }

  // --- post dummies: nearest clear gap to each station
  const placed: V3[] = [];
  const isClearPost = (x: number, z: number, H: number, e: number): boolean => {
    const s = H / H0;
    if (Math.abs(x) > 158 || z < 192 + FS || z > 478 + FS) return false;
    if (clearOf(x, z) < 2.9 * s + 4.2) return false;
    for (const p of placed) if (hypot(p.x - x, p.z - z) < 24) return false;
    for (const sp of spans) if (segDist2D(x, z, sp.a.x, sp.a.z, sp.b.x, sp.b.z) < 10) return false;
    const gy = col.groundHeight(x, z);
    if (blocked(_v1.set(x, gy + e + H * 0.5, z), H * 0.5 + 1)) return false;
    if (blocked(_v1.set(x, gy + e * 0.5, z), Math.max(1.5, e * 0.5 + 0.5))) return false;
    return true;
  };
  let hk = 0;
  for (let i = 0; i < N_DUMMIES; i++) {
    if (specs[i]) continue;
    const S = stations[i], H = POST_HEIGHTS[hk++ % POST_HEIGHTS.length], e = 0.8 + ((i * 7) % 5) * 0.55;
    let pos: V3 | null = null;
    outer: for (let rad = 0; rad <= 40; rad += 2.5) {
      const n = rad === 0 ? 1 : Math.max(6, Math.round(rad * 0.8));
      for (let k = 0; k < n; k++) {
        const ang = (k / n) * Math.PI * 2 + i;
        const x = S.x + Math.cos(ang) * rad, z = S.z + Math.sin(ang) * rad;
        if (isClearPost(x, z, H, e)) { pos = new V3(x, col.groundHeight(x, z), z); break outer; }
      }
    }
    if (!pos) { console.warn('[training] no clear gap near station', i); pos = new V3(S.x, col.groundHeight(S.x, S.z), S.z); }
    placed.push(pos);
    specs[i] = { height: H, elevation: e, ground: pos, yaw: 0 };
  }
  // pulley stations also block later posts (handled via spans); now orient everyone along the flow
  const all = specs as DummySpec[];   // (every slot is filled now)
  const anchorOf = (sp: DummySpec): V3 => sp.pulley ? _v2.copy(sp.pulley.a).lerp(sp.pulley.b, 0.5) : _v2.copy(sp.ground);
  const pts = all.map((sp) => anchorOf(sp).clone());

  // --- start tower at the forest edge, before the first dummy
  const first = pts[0];
  let tower: Omit<Tower, 'yaw'> | null = null;
  const t0 = route(-0.07, new V3());
  for (let rad = 0; rad <= 30 && !tower; rad += 3) {
    const n = rad === 0 ? 1 : 10;
    for (let k = 0; k < n; k++) {
      const x = t0.x + Math.cos(k / n * Math.PI * 2) * rad, z = t0.z + Math.sin(k / n * Math.PI * 2) * rad;
      if (clearOf(x, z) < 8) continue;
      const gy = col.groundHeight(x, z);
      if (blocked(_v1.set(x, gy + 8, z), 5.5) || blocked(_v1.set(x, gy + 17, z), 5)) continue;
      if (pts.some((p) => hypot(p.x - x, p.z - z) < 20)) continue;
      tower = { x, z, gy, deck: gy + 16 };
      break;
    }
  }
  if (!tower) { const gy = col.groundHeight(t0.x, t0.z); tower = { x: t0.x, z: t0.z, gy, deck: gy + 16 }; }
  const tw: Tower = { ...tower, yaw: Math.atan2(first.x - tower.x, first.z - tower.z) };

  // approach direction for each dummy: from the previous station (or the tower)
  for (let i = 0; i < N_DUMMIES; i++) {
    const prev = i === 0 ? _v0.set(tw.x, 0, tw.z) : _v0.copy(pts[i - 1]);
    const ax = pts[i].x - prev.x, az = pts[i].z - prev.z;
    const ay = Math.atan2(ax, az);
    const sp = all[i];
    if (sp.pulley) {
      // the board slides in its own plane: front perpendicular to the rope, nape toward the incoming cadet
      const d = sp.pulley.dir;
      let fx = -d.z, fz = d.x;
      if (fx * ax + fz * az < 0) { fx = -fx; fz = -fz; }
      sp.yaw = Math.atan2(fx, fz);
      const rx = Math.cos(sp.yaw), rz = -Math.sin(sp.yaw);   // root local +x in world
      sp.pulley.sgn = Math.sign(d.x * rx + d.z * rz) || 1;
    } else {
      sp.yaw = ay + (i % 2 ? 1 : -1) * (0.95 + ((i * 13) % 5) * 0.08);   // nape visible from the side as you come in
    }
  }
  return { specs: all, spans, tower: tw, trees };
}

// ---------------------------------------------------------------------------------------------- course
export class TrainingCourse {
  game: Game;
  /** the dummies, in course order */
  titans: Dummy[] = [];
  active = false;
  built = false;
  group: THREE.Group;
  staticColliders: BoxCollider[] = [];
  staticBoxes: StaticBox[] = [];
  _spawn: { position: V3; yaw: number } = { position: new V3(0, 50.6, 0), yaw: 0 };
  /** each dummy's position when built (course order) */
  route: V3[] = [];
  plan: CoursePlan | null = null;

  constructor(game: Game) {
    this.game = game;
    this.group = new THREE.Group(); this.group.name = 'trainingCourse';
    this.group.visible = false;
  }
  /** Where a run starts: on the launch tower's deck, facing the first dummy. */
  get spawn(): { position: V3; yaw: number } { this._build(); return this._spawn; }
  set spawn(v: { position: V3; yaw: number }) { this._spawn = v; }
  get remaining(): number { let n = 0; for (const d of this.titans) if (d.alive) n++; return n; }
  get total(): number { return this.titans.length; }
  /** the first uncut dummy in course order (for a HUD pointer) */
  nextTarget(): Dummy | null { for (const d of this.titans) if (d.alive) return d; return null; }

  _build(): void {
    if (this.built) return;
    this.built = true;
    const g = this.game, col = g.collision;
    const plan = planCourse(col);
    this.plan = plan;
    plan.specs.forEach((sp, i) => {
      const d = new Dummy(this, sp, i);
      this.titans.push(d);
      this.group.add(d.root);
    });
    this._buildStatics(plan);
    for (const d of this.titans) this.route.push(d.position.clone());
    g.scene?.add(this.group);
  }

  _buildStatics(plan: CoursePlan): void {
    const W = new Bag(), R = new Bag(), rnd = mulberry(4242);
    const plank = () => shade(WOOD[Math.floor(rnd() * WOOD.length)], 0.85 + rnd() * 0.2);
    // ---- launch tower: four log legs, braces, a planked deck with rails on three sides, a ladder
    const tw = plan.tower, S = 5.6, hs = S / 2 - 0.3;
    const yaw = tw.yaw, cy = Math.cos(yaw), sy = Math.sin(yaw);
    const L = (lx: number, lz: number): [number, number] => [tw.x + lx * cy + lz * sy, tw.z - lx * sy + lz * cy];   // tower local -> world (local +z = facing)
    const corners: [number, number][] = [[-hs, -hs], [hs, -hs], [hs, hs], [-hs, hs]];
    const legTop = tw.deck - 0.35;
    const legs = corners.map(([lx, lz]) => { const [x, z] = L(lx, lz); return { x, z, gy: this.game.collision.groundHeight(x, z) }; });
    for (const l of legs) W.rod(new V3(l.x, l.gy - 0.5, l.z), new V3(l.x, tw.deck + 1.3, l.z), 0.26, shade(POST, 0.9 + rnd() * 0.2), 8);
    for (let k = 0; k < 4; k++) {
      const a = legs[k], b = legs[(k + 1) % 4];
      for (const [y0, y1] of [[tw.gy + 1.5, tw.gy + 8], [tw.gy + 8, tw.gy + 1.5], [tw.gy + 8.5, legTop - 0.5], [legTop - 0.5, tw.gy + 8.5]]) W.rod(new V3(a.x, y0, a.z), new V3(b.x, y1, b.z), 0.12, shade(DARK, 0.9 + rnd() * 0.2), 5);
      W.rod(new V3(a.x, tw.gy + 8.2, a.z), new V3(b.x, tw.gy + 8.2, b.z), 0.14, DARK, 5);
      for (const y of [tw.gy + 1.5, tw.gy + 8.2, legTop - 0.5]) R.ring(a.x, y, a.z, 0.32, 0.06, ROPE);
    }
    // deck boards (along the facing direction), joists
    const nb = 7, bw = S / nb;
    for (let i = 0; i < nb; i++) {
      const lx = -S / 2 + bw * (i + 0.5); const [x, z] = L(lx, 0);
      W.box(x, tw.deck - 0.12, z, bw - 0.05, 0.22, S + (rnd() - 0.5) * 0.3, plank(), 0, yaw);
    }
    for (const lz of [-hs, 0, hs]) { const [x, z] = L(0, lz); W.box(x, tw.deck - 0.38, z, S + 0.3, 0.3, 0.3, DARK, 0, yaw); }
    // rails on the back and sides (the front is open toward the course)
    for (const [lx, lz, w, d] of [[0, -hs, S, 0.14], [-hs, 0, 0.14, S], [hs, 0, 0.14, S]] as const) {
      for (const y of [0.55, 1.1]) { const [x, z] = L(lx, lz); W.box(x, tw.deck + y, z, w, 0.12, d, plank(), 0, yaw); }
    }
    // ladder up the back
    { const [x0, z0] = L(-0.45, -hs - 0.35), [x1, z1] = L(0.45, -hs - 0.35);
      const gy = this.game.collision.groundHeight(x0, z0);
      W.rod(new V3(x0, gy, z0), new V3(x0, tw.deck + 1.1, z0), 0.07, DARK, 5); W.rod(new V3(x1, gy, z1), new V3(x1, tw.deck + 1.1, z1), 0.07, DARK, 5);
      for (let y = gy + 0.4; y < tw.deck; y += 0.45) W.rod(new V3(x0, y, z0), new V3(x1, y, z1), 0.045, plank(), 4);
    }
    // a red signal pennant on the front-left leg
    { const l = legs[3]; W.box(l.x, tw.deck + 1.95, l.z, 0.07, 1.4, 0.07, DARK); W.box(l.x, tw.deck + 2.3, l.z, 0.04, 0.55, 0.9, 0x9c2a1c, 0, yaw); }
    this.staticBoxes.push(
      { center: new V3(tw.x, tw.deck - 0.2, tw.z), halfExtents: new V3(S / 2, 0.25, S / 2), quaternion: new THREE.Quaternion().setFromAxisAngle(UP, yaw) },
      ...legs.map((l) => ({ center: new V3(l.x, (l.gy + tw.deck) / 2, l.z), halfExtents: new V3(0.28, (tw.deck - l.gy) / 2, 0.28), quaternion: new THREE.Quaternion().setFromAxisAngle(UP, yaw) })),
    );
    for (const [lx, lz, w, d] of [[0, -hs, S / 2, 0.1], [-hs, 0, 0.1, S / 2], [hs, 0, 0.1, S / 2]] as const) {
      const [x, z] = L(lx, lz);
      this.staticBoxes.push({ center: new V3(x, tw.deck + 0.65, z), halfExtents: new V3(w, 0.6, d), quaternion: new THREE.Quaternion().setFromAxisAngle(UP, yaw) });
    }
    const [sx, sz] = L(0, 0.9);
    this._spawn = { position: new V3(sx, tw.deck + 0.6, sz), yaw };

    // ---- pulley lines: rope collars round both trunks, a guide block on each, the line itself, a haul line to the ground
    for (const sp of plan.spans) {
      for (const [T0, end, sgn] of [[sp.A, sp.a, 1], [sp.B, sp.b, -1]] as const) {
        const r = T0.rAt(sp.y);
        for (const dy of [-0.25, 0, 0.25]) R.ring(T0.x, sp.y + dy, T0.z, r + 0.05, 0.09, ROPE);
        const bp = new V3(end.x, sp.y - 0.25, end.z).addScaledVector(sp.dir, sgn * 0.25);
        W.box(bp.x, bp.y, bp.z, 0.6, 0.8, 0.5, 0x4a3220, 0, Math.atan2(sp.dir.x, sp.dir.z));
        R.rod(new V3(bp.x, bp.y - 0.4, bp.z), new V3(T0.x, T0.gy + 1.2, T0.z).addScaledVector(sp.dir, sgn * (T0.r + 0.3)), 0.05, ROPE, 4);
        R.ring(T0.x, T0.gy + 1.2, T0.z, T0.r + 0.06, 0.08, ROPE);
      }
      R.rod(sp.a, sp.b, 0.075, shade(ROPE, 0.85), 5);
    }
    const M = mats();
    const wg = W.merge(), rg = R.merge();
    if (wg) { const m = new THREE.Mesh(wg, M.wood); m.castShadow = m.receiveShadow = true; m.name = 'trainingWood'; this.group.add(m); }
    if (rg) { const m = new THREE.Mesh(rg, M.rope); m.castShadow = true; m.name = 'trainingRope'; this.group.add(m); }
  }

  start(): void {
    this._build();
    const col = this.game.collision;
    this._removeColliders();
    for (const d of this.titans) d.reset();
    for (const b of this.staticBoxes) this.staticColliders.push(col.addBox({ ...b, material: 'wood', hookable: true, userData: { training: true } }));
    for (const d of this.titans) d.addColliders(col);
    this.group.visible = true;
    this.active = true;
    this.group.updateMatrixWorld(true);
  }
  stop(): void {
    this._removeColliders();
    this.group.visible = false;
    this.active = false;
  }
  _removeColliders(): void {
    const col = this.game.collision;
    for (const c of this.staticColliders) col.remove(c);
    this.staticColliders.length = 0;
    for (const d of this.titans) d.removeColliders(col);
  }
  update(dt: number): void {
    if (!this.active || !(dt > 0)) return;
    for (const d of this.titans) d.update(dt);
  }
  /** -> [{ titan: dummy, part: 'nape' | 'body', point }] */
  hitTest(center: V3, radius: number): DummyHit[] {
    const out: DummyHit[] = [];
    if (!this.active) return out;
    for (const d of this.titans) d.hitTest(center, radius, out);
    return out;
  }
}
