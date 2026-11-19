// AOTT: the Outrider soldier (procedural, physically based) with tether gear, two blades and a cloth-sim cloak.
//
//   const model = new PlayerModel(game);      // game.scene gets model.root added by the CORE (we only build the Group)
//   model.update(dt, state);                  // see ModelState; positions itself from state.position (body centre,
//                                             // feet at position.y - 0.9) and orients itself from forward/up.
//   model.hookOrigin(side, outVec3)           // world position of the anchor launcher barrel (0 left, 1 right)
//   model.gasNozzle(outPos, outDir)           // world position + unit ejection direction of the gas jet
//
// Extras (not in the contract): model.autoGas (default true: update() calls game.fx.gas() itself while boosting;
// set false if the core calls fx.gas(gasNozzle…) on its own), model.setVisible(bool), model.dispose().
//
// Frames: model +Z = the way the chest faces, +Y = head, +X = the soldier's LEFT. The pelvis (body centre) is the pivot
// of the whole body; `root` only translates, the `pivot` child carries the orientation. The cloak is simulated in the
// root-relative world-aligned frame (a translating, non-rotating frame): inertial pseudo-force = -body acceleration
// (clamped), air drag against the apparent wind (-velocity), so it streams behind at speed and flutters.
//
// Draw calls: the soldier is modelled as ~100 small parts on 15 animated joint groups (+ the two blade groups), then
// _bake() packs them: every static part is baked into ONE rigidly skinned body mesh (each vertex weighted 1.0 to its
// joint group, so it moves exactly like the per-part meshes did) with per-vertex colour, surface (roughness,
// metalness, grain) and emissive on one shared PBR material (materials.ts). Each blade is one mesh. Colour pass:
// 1 body + 2 blades + 2 cloak + face = 6 calls (+1 gas jet while boosting); shadow pass: body, 2 blades, cloak = 4.
import * as THREE from 'hull/three';
import type { Game } from '../types';
import { grainMaterial, clothGrainCanvas, SURF, type Surface } from './materials';
import { EMBLEM_BONE, EMBLEM_GREEN, EMBLEM_GRAPHITE } from '../ui/emblem';
import { R } from '../sim';
import { makeCanvas, makePath } from '../canvas';
import { config } from 'hull';

// Math.hypot is variadic and boxes its arguments in hot loops (it was the top source of garbage); this doesn't.
const hypot = (a: number, b: number, c = 0): number => Math.sqrt(a * a + b * b + c * c);

const TAU = Math.PI * 2;
const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const sstep = (a: number, b: number, x: number): number => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const finite = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

// ──────────────────────────────────────────────── the AOTT emblem ───────────────────────────────────────────
// The same mark as the DOM UI's emblemSVG() (src/ui/emblem.ts), drawn from the same path data (its 100 × 120 box).
/** Emblem colours: fg = the device and border (bone), bg = the shield field (deep green; null leaves it unfilled). */
export interface EmblemColors { fg?: string; bg?: string | null }
export { EMBLEM_BONE, EMBLEM_GREEN, EMBLEM_GRAPHITE };

const EP = {
  shield: makePath('M8 6 H92 V50 C92 80 74 100 50 115 C26 100 8 80 8 50 Z'),
  inner: makePath('M15.5 13 H84.5 V50 C84.5 75 69 92.5 50 105.5 C31 92.5 15.5 75 15.5 50 Z'),
  wall: makePath('M17 71 H25 V62 H33 V71 H46 V62 H54 V71 H67 V62 H75 V71 H83'),
  blade: makePath('M50 12 L55.5 22 V78 H44.5 V22 Z'),
  hilt: (() => { const p = makePath(); p.rect(34, 78, 32, 5); p.rect(47, 83, 6, 13); p.moveTo(53.8, 99.5); p.arc(50, 99.5, 3.8, 0, TAU); return p; })(),
  fuller: makePath('M50 25 V74'),
  tetherLine: makePath('M67.6 41 C73 55 70 70 63 78'),
  slivers: makePath('M43 31 H44.5 V41 H43 Z M55.5 31 H57 V41 H55.5 Z'),
  patch: makePath('M44.5 31 H55.5 V41 H44.5 Z'),
  patchLine: makePath('M50 31 V41'),
};

/**
 * The AOTT emblem centred at (cx, cy), S = shield width: a pointed heater shield; in it a single upright sword, point
 * up, crossing a wall line with three crenellations; a thin ring (the tether) loops from the guard round the blade.
 * Two-tone: bone on deep green (cloak, flags) by default; pass { bg: EMBLEM_GRAPHITE } for the HUD, or bg null to
 * draw on cloth that is already the field colour.
 */
export function drawEmblem(ctx: CanvasRenderingContext2D, cx: number, cy: number, S: number, colors: EmblemColors = {}): void {
  const fg = colors.fg ?? EMBLEM_BONE, bg = colors.bg === undefined ? EMBLEM_GREEN : colors.bg;
  const field = bg ?? EMBLEM_GREEN;               // the cut-out outlines need a colour even on bare cloth
  const k = S / 84;
  ctx.save();
  ctx.translate(cx, cy); ctx.scale(k, k); ctx.translate(-50, -60.5);
  ctx.lineJoin = 'round';
  if (bg) { ctx.fillStyle = bg; ctx.fill(EP.shield); }
  ctx.strokeStyle = fg; ctx.lineWidth = 4; ctx.stroke(EP.shield);
  ctx.globalAlpha = 0.32; ctx.lineWidth = 1.2; ctx.stroke(EP.inner); ctx.globalAlpha = 1;
  ctx.lineCap = 'square'; ctx.lineWidth = 3.2; ctx.stroke(EP.wall);
  // the sword, cut out of the wall by a field-coloured outline
  ctx.strokeStyle = field; ctx.lineWidth = 3;
  ctx.stroke(EP.blade); ctx.stroke(EP.hilt);
  ctx.fillStyle = fg; ctx.fill(EP.blade); ctx.fill(EP.hilt);
  ctx.lineWidth = 1.1; ctx.stroke(EP.fuller);
  // the tether ring round the blade (in front below, behind above) and its line down to the guard
  ctx.strokeStyle = fg; ctx.lineWidth = 2.2;
  ctx.save(); ctx.translate(50, 44); ctx.rotate(-14 * Math.PI / 180);
  ctx.beginPath(); ctx.ellipse(0, 0, 19, 7.5, 0, 0, TAU); ctx.stroke(); ctx.restore();
  ctx.lineCap = 'round'; ctx.lineWidth = 1.6; ctx.stroke(EP.tetherLine);
  ctx.fillStyle = field; ctx.fill(EP.slivers);
  ctx.fillStyle = fg; ctx.fill(EP.patch);
  ctx.strokeStyle = field; ctx.lineWidth = 1.1; ctx.stroke(EP.patchLine);
  ctx.restore();
}

/** The cloak: deep green wool with a twill grain, soft folds, a worn hem and seams, the emblem stitched on the back. */
function makeCapeTexture(): { map: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  const W = 512, H = 800;
  const cv = makeCanvas(); cv.width = W; cv.height = H;
  const c = cv.getContext('2d')!;
  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#2f4a38'); g.addColorStop(0.55, '#2a4232'); g.addColorStop(1, '#22372a');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  // soft vertical folds: long, low-contrast light and shade bands
  for (let i = 0; i < 28; i++) {
    const x = R.fx() * W, w = 14 + R.fx() * 40;
    const fold = c.createLinearGradient(x, 0, x + w, 0);
    const dark = R.fx() < 0.5;
    fold.addColorStop(0, 'rgba(0,0,0,0)');
    fold.addColorStop(0.5, dark ? `rgba(8,20,12,${(0.08 + R.fx() * 0.1).toFixed(3)})` : `rgba(120,150,120,${(0.04 + R.fx() * 0.05).toFixed(3)})`);
    fold.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = fold; c.fillRect(x, 0, w, H);
  }
  // seams down the sides and a turned hem, worn and grimy at the bottom
  c.fillStyle = 'rgba(10,22,14,0.55)'; c.fillRect(0, 0, 9, H); c.fillRect(W - 9, 0, 9, H);
  c.fillStyle = 'rgba(10,22,14,0.5)'; c.fillRect(0, H - 30, W, 30);
  c.strokeStyle = 'rgba(200,205,185,0.22)'; c.lineWidth = 2; c.setLineDash([6, 5]);
  c.beginPath(); c.moveTo(0, H - 34); c.lineTo(W, H - 34); c.moveTo(13, 0); c.lineTo(13, H - 34); c.moveTo(W - 13, 0); c.lineTo(W - 13, H - 34); c.stroke();
  c.setLineDash([]);
  const grime = c.createLinearGradient(0, H - 160, 0, H);
  grime.addColorStop(0, 'rgba(40,32,20,0)'); grime.addColorStop(1, 'rgba(40,32,20,0.35)');
  c.fillStyle = grime; c.fillRect(0, H - 160, W, 160);
  // the emblem, stitched on (the field is the cloak itself, so no fill)
  drawEmblem(c, W / 2, 330, 290, { bg: null });
  // the weave over everything (emblem included, so it reads as embroidered into the cloth)
  const grain = clothGrainCanvas(256, 7);
  c.globalCompositeOperation = 'overlay'; c.globalAlpha = 0.55;
  for (let y = 0; y < H; y += 256) for (let x = 0; x < W; x += 256) c.drawImage(grain, x, y);
  c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
  const map = new THREE.CanvasTexture(cv);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  const bump = new THREE.CanvasTexture(clothGrainCanvas(128, 3));
  bump.wrapS = bump.wrapT = THREE.RepeatWrapping; bump.repeat.set(5, 8);
  return { map, bump };
}
let _capeTex: { map: THREE.CanvasTexture; bump: THREE.CanvasTexture } | null = null;
/** One cloak texture set, shared by every soldier. */
const capeTextures = (): { map: THREE.CanvasTexture; bump: THREE.CanvasTexture } => (_capeTex ||= makeCapeTexture());

// ───────────────────────────────────────────────── cape cloth sim ───────────────────────────────────────────
const CC = 9, CR = 10, CN = CC * CR;
const CAPE_LEN = 1.22, CAPE_W0 = 0.46, CAPE_W1 = 0.98;
const CAPE_UPDRAFT = 3;   // m/s: the most upward apparent wind the cape feels (a fall)

class CapeSim {
  pos: Float32Array; pred: Float32Array; vel: Float32Array;
  /** current pin targets (root-relative) and last frame's */
  anchor: Float32Array; anchorPrev: Float32Array;
  nrm: Float32Array;
  /** flat rest layout (x, y, 0) */
  rest0: Float32Array;
  inited: boolean;
  ia: Uint16Array; ib: Uint16Array; rest: Float32Array; k: Float32Array; nCon: number;
  /** collision spheres: x, y, z, r, back-direction nx, ny, nz (root-relative) */
  spheres: Float32Array; nSph: number;
  /** low-passed body acceleration */
  accel: THREE.Vector3; prevVel: THREE.Vector3; hasPrev: boolean;
  t: number;
  /** substep rate (Hz) and constraint iterations (comrades far off use fewer) */
  hz = 120; iters = 5;
  /** 0..1: cloth above the shoulders is pulled down behind them (standing, landing) */
  settle = 0;

  constructor() {
    this.pos = new Float32Array(CN * 3);
    this.pred = new Float32Array(CN * 3);
    this.vel = new Float32Array(CN * 3);
    this.anchor = new Float32Array(CC * 3);      // current pin targets (root-relative)
    this.anchorPrev = new Float32Array(CC * 3);
    this.nrm = new Float32Array(CN * 3);
    this.rest0 = new Float32Array(CN * 3);        // flat rest layout (x, y, 0)
    this.inited = false;
    // constraints
    const ia: number[] = [], ib: number[] = [], rest: number[] = [], k: number[] = [];
    const idx = (r: number, c: number): number => r * CC + c;
    const rp = this.rest0;
    for (let r = 0; r < CR; r++) {
      const w = lerp(CAPE_W0, CAPE_W1, r / (CR - 1));
      for (let c = 0; c < CC; c++) {
        const i = idx(r, c) * 3;
        rp[i] = (0.5 - c / (CC - 1)) * w; rp[i + 1] = -r * (CAPE_LEN / (CR - 1)); rp[i + 2] = 0;
      }
    }
    const add = (a: number, b: number, stiff: number): void => {
      const dx = rp[a * 3] - rp[b * 3], dy = rp[a * 3 + 1] - rp[b * 3 + 1];
      ia.push(a); ib.push(b); rest.push(hypot(dx, dy)); k.push(stiff);
    };
    for (let r = 0; r < CR; r++) for (let c = 0; c < CC; c++) {
      if (c + 1 < CC) add(idx(r, c), idx(r, c + 1), 1.0);
      if (r + 1 < CR) add(idx(r, c), idx(r + 1, c), 1.0);
      if (r + 1 < CR && c + 1 < CC) { add(idx(r, c), idx(r + 1, c + 1), 0.6); add(idx(r, c + 1), idx(r + 1, c), 0.6); }
      if (c + 2 < CC) add(idx(r, c), idx(r, c + 2), 0.12);
      if (r + 2 < CR) add(idx(r, c), idx(r + 2, c), 0.12);
    }
    this.ia = Uint16Array.from(ia); this.ib = Uint16Array.from(ib); this.rest = Float32Array.from(rest); this.k = Float32Array.from(k);
    this.nCon = ia.length;
    this.spheres = new Float32Array(12 * 7);       // x,y,z,r, back-direction nx,ny,nz (root-relative)
    this.nSph = 0;
    this.accel = new THREE.Vector3();             // low-passed body acceleration
    this.prevVel = new THREE.Vector3();
    this.hasPrev = false;
    this.t = 0;
  }

  /** lay the cape out streaming away from the apparent wind (or hanging when still), on the back side of the body. */
  reset(windX: number, windY: number, windZ: number, backX: number, backY: number, backZ: number): void {
    const a = this.anchor, p = this.pos;
    let dx = windX * 0.05, dy = windY * 0.05 - 3.5, dz = windZ * 0.05;
    const l = hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
    const dy2 = CAPE_LEN / (CR - 1);
    for (let r = 0; r < CR; r++) for (let c = 0; c < CC; c++) {
      const i = (r * CC + c) * 3, ai = c * 3;
      const spread = 1 + 0.9 * r / (CR - 1);
      p[i] = a[ai] * spread + dx * r * dy2 + backX * (0.03 + 0.012 * r);
      p[i + 1] = a[ai + 1] + dy * r * dy2 + backY * (0.03 + 0.012 * r);
      p[i + 2] = a[ai + 2] + dz * r * dy2 + backZ * (0.03 + 0.012 * r);
      this.vel[i] = this.vel[i + 1] = this.vel[i + 2] = 0;
    }
    this.pred.set(p);
    this.anchorPrev.set(a);
    this.inited = true;
  }

  /** smooth outward normals (-Z side) from the grid, written into `out` (Float32Array CN*3). Allocation-free. */
  normals(P: Float32Array, out: Float32Array): void {
    for (let r = 0; r < CR; r++) {
      const r0 = Math.max(r - 1, 0), r1 = Math.min(r + 1, CR - 1);
      for (let c = 0; c < CC; c++) {
        const c0 = Math.max(c - 1, 0), c1 = Math.min(c + 1, CC - 1);
        const a = (r * CC + c1) * 3, b = (r * CC + c0) * 3, d = (r1 * CC + c) * 3, e = (r0 * CC + c) * 3;
        const ux = P[a] - P[b], uy = P[a + 1] - P[b + 1], uz = P[a + 2] - P[b + 2];
        const vx = P[d] - P[e], vy = P[d + 1] - P[e + 1], vz = P[d + 2] - P[e + 2];
        const nx = vy * uz - vz * uy, ny = vz * ux - vx * uz, nz = vx * uy - vy * ux;
        const l = hypot(nx, ny, nz) || 1;
        const o = (r * CC + c) * 3;
        out[o] = nx / l; out[o + 1] = ny / l; out[o + 2] = nz / l;
      }
    }
  }

  /** advance by dt. wind = apparent air velocity in the frame (−body velocity), accel = body acceleration. */
  step(dt: number, windX: number, windY: number, windZ: number, speedFrac: number, bkX: number, bkY: number, bkZ: number): void {
    const nSub = clamp(Math.ceil(dt * this.hz), 1, 6);
    const h = dt / nSub;
    const P = this.pos, Q = this.pred, V = this.vel, N = this.nrm;
    // air drag pulls the cloth to the apparent wind (so it trails behind where you're going, rather than being
    // flung out sideways when you turn); gravity a little under g keeps it lively
    const fT = 1 - Math.exp(-3.2 * h), fN = 1 - Math.exp(-9 * h);
    const damp = Math.exp(-0.5 * h);
    const gy = -9.8 * 0.8;
    // inertial pseudo-force. Falling, the body accelerates down at the game's (stronger) gravity, which would more
    // than cancel the cloth's own weight and float it up over the head with no wind at all: the upward part is held
    // to most of the cloth's weight, so a falling cape only rises as far as the updraft lifts it
    const ax = -this.accel.x, ay = Math.min(-this.accel.y, -gy * 0.6), az = -this.accel.z;
    // settling (feet-first for a landing, or on the ground): cloth above the shoulders is pulled down off the head
    const settle = this.settle, pinY = this.anchor[4 * 3 + 1], ceil = pinY + lerp(CAPE_LEN, 0.02, settle);
    const ia = this.ia, ib = this.ib, rest = this.rest, kk = this.k, nCon = this.nCon;
    const sph = this.spheres, nSph = this.nSph;
    // flutter and billow come from the apparent wind only: standing still, the cape just hangs under gravity
    const gustAmp = 32.5 * speedFrac, lift = 60.0 * speedFrac;
    for (let sub = 0; sub < nSub; sub++) {
      const al = (sub + 1) / nSub;
      this.t += h;
      // pins slide from the previous anchor to the current one across the frame
      for (let c = 0; c < CC; c++) {
        const i = c * 3;
        Q[i] = P[i] = this.anchorPrev[i] + (this.anchor[i] - this.anchorPrev[i]) * al;
        Q[i + 1] = P[i + 1] = this.anchorPrev[i + 1] + (this.anchor[i + 1] - this.anchorPrev[i + 1]) * al;
        Q[i + 2] = P[i + 2] = this.anchorPrev[i + 2] + (this.anchor[i + 2] - this.anchorPrev[i + 2]) * al;
        V[i] = V[i + 1] = V[i + 2] = 0;
      }
      // surface normals from the current positions
      for (let r = 0; r < CR; r++) {
        const r0 = Math.max(r - 1, 0), r1 = Math.min(r + 1, CR - 1);
        for (let c = 0; c < CC; c++) {
          const c0 = Math.max(c - 1, 0), c1 = Math.min(c + 1, CC - 1);
          const a = (r * CC + c1) * 3, b = (r * CC + c0) * 3, d = (r1 * CC + c) * 3, e = (r0 * CC + c) * 3;
          const ux = P[a] - P[b], uy = P[a + 1] - P[b + 1], uz = P[a + 2] - P[b + 2];
          const vx = P[d] - P[e], vy = P[d + 1] - P[e + 1], vz = P[d + 2] - P[e + 2];
          let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
          const l = hypot(nx, ny, nz) || 1;
          const o = (r * CC + c) * 3;
          N[o] = nx / l; N[o + 1] = ny / l; N[o + 2] = nz / l;
        }
      }
      // forces → predicted positions
      for (let r = 1; r < CR; r++) {
        for (let c = 0; c < CC; c++) {
          const i = (r * CC + c) * 3;
          let vx = V[i], vy = V[i + 1], vz = V[i + 2];
          // gust: flutter along the normal, stronger lower down and with speed
          const ph = this.t * 11 + r * 0.85 + c * 1.35 + Math.sin(this.t * 2.3 + c) * 1.5;
          const sn = Math.sin(ph);
          const edge = 0.55 + 0.45 * Math.abs(c - 4) / 4;                  // the corners whip more than the centre
          const gust = sn * gustAmp * (0.25 + r / CR) * edge;
          const lf = lift * (0.5 + 0.5 * Math.sin(ph * 0.8 - c * 0.5)) * Math.pow(r / CR, 1.4) * edge;   // billow away from the back
          vx += (ax + N[i] * gust + bkX * lf) * h; vy += (gy + ay + N[i + 1] * gust + bkY * lf) * h; vz += (az + N[i + 2] * gust + bkZ * lf) * h;
          if (settle > 0 && P[i + 1] > pinY + 0.05) vy -= settle * 30 * h;
          // drag against the wind: isotropic part + extra along the normal (cloth catches air)
          const rx = windX - vx, ry = windY - vy, rz = windZ - vz;
          const nd = N[i] * rx + N[i + 1] * ry + N[i + 2] * rz;
          vx += rx * fT + N[i] * nd * fN; vy += ry * fT + N[i + 1] * nd * fN; vz += rz * fT + N[i + 2] * nd * fN;
          const sp = vx * vx + vy * vy + vz * vz;
          if (sp > 22500) { const s = 150 / Math.sqrt(sp); vx *= s; vy *= s; vz *= s; }
          V[i] = vx; V[i + 1] = vy; V[i + 2] = vz;
          Q[i] = P[i] + vx * h; Q[i + 1] = P[i + 1] + vy * h; Q[i + 2] = P[i + 2] + vz * h;
        }
      }
      // constraints + collisions
      for (let it = 0, nIt = this.iters; it < nIt; it++) {
        for (let j = 0; j < nCon; j++) {
          const a = ia[j], b = ib[j];
          const A = a * 3, B = b * 3;
          let dx = Q[B] - Q[A], dy = Q[B + 1] - Q[A + 1], dz = Q[B + 2] - Q[A + 2];
          const d = hypot(dx, dy, dz);
          if (d < 1e-7) continue;
          const diff = (d - rest[j]) / d * kk[j];
          const wa = a < CC ? 0 : 1, wb = b < CC ? 0 : 1;
          const ws = wa + wb;
          if (ws === 0) continue;
          const fa = diff * wa / ws, fb = diff * wb / ws;
          Q[A] += dx * fa; Q[A + 1] += dy * fa; Q[A + 2] += dz * fa;
          Q[B] -= dx * fb; Q[B + 1] -= dy * fb; Q[B + 2] -= dz * fb;
        }
        for (let i = CC; i < CN; i++) {
          const o = i * 3;
          // settling, the cloth can only ride so far above the shoulders: what would stand higher folds back behind
          // them instead (never draped over the head)
          if (settle > 0 && Q[o + 1] > ceil) { const ex = Q[o + 1] - ceil; Q[o + 1] = ceil; Q[o] += bkX * ex; Q[o + 2] += bkZ * ex; }
          for (let s = 0; s < nSph; s++) {
            const so = s * 7;
            const dx = Q[o] - sph[so], dy = Q[o + 1] - sph[so + 1], dz = Q[o + 2] - sph[so + 2];
            const rr = sph[so + 3];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < rr * rr) {
              // always leave through the BACK of the body (the cape never ends up on the belly side)
              const nx = sph[so + 4], ny = sph[so + 5], nz = sph[so + 6];
              const dn = dx * nx + dy * ny + dz * nz;
              const tt = -dn + Math.sqrt(Math.max(dn * dn - d2 + rr * rr, 0));
              Q[o] += nx * tt; Q[o + 1] += ny * tt; Q[o + 2] += nz * tt;
            }
          }
        }
      }
      // velocity from the corrected positions
      for (let i = CC * 3; i < CN * 3; i++) { V[i] = (Q[i] - P[i]) / h * damp; P[i] = Q[i]; }
    }
    this.anchorPrev.set(this.anchor);
  }
}

// ───────────────────────────────────────────────── the model ────────────────────────────────────────────────
// pose channels (all in the body-local joint frame; arms/legs in radians)
const SPX = 0, SPY = 1, SPZ = 2, HDX = 3, HDY = 4,
  LSX = 5, LSZ = 6, LSY = 7, LEX = 8, LWX = 9,
  RSX = 10, RSZ = 11, RSY = 12, REX = 13, RWX = 14,
  LHX = 15, LHZ = 16, LKX = 17, LAX = 18,
  RHX = 19, RHZ = 20, RKX = 21, RAX = 22,
  BOB = 23, NCH = 24;

// five keys at fixed times (mount sequences); eased between keys
const MT = [0, 0.22, 0.5, 0.78, 1];
type Keys5 = readonly [number, number, number, number, number];
const k5 = (q: number, a: Keys5): number => { let i = 0; while (i < 3 && q > MT[i + 1]) i++; return lerp(a[i], a[i + 1], sstep(MT[i], MT[i + 1], q)); };
// Getting on a horse. Absolute joint targets per key; key 4 is exactly the seated riding pose (gallop 0).
// 'run': plant a hand on the saddle, spring, swing the horse-side leg high over its back, drop astride, sit up.
// 'air': come down legs spread, hit the saddle and fold forward over the neck, then sit up.
// Legs: o = the leg that goes over / on the horse's side, p = the other. Arms: n = horse-side hand, f = far hand.
interface MountKeys {
  SPX: Keys5; SPZ: Keys5; HDX: Keys5; BOB: Keys5;
  oHX: Keys5; oHZ: Keys5; oKX: Keys5; oAX: Keys5;
  pHX: Keys5; pHZ: Keys5; pKX: Keys5; pAX: Keys5;
  nSX: Keys5; nSZ: Keys5; nEX: Keys5;
  fSX: Keys5; fSZ: Keys5; fEX: Keys5;
}
const MOUNT: Record<'run' | 'air', MountKeys> = {
  run: {
    SPX: [0.1, 0.5, 0.78, 0.45, 0.12], SPZ: [0, 0.22, 0.3, 0.08, 0], HDX: [0, -0.35, -0.55, -0.3, -0.1], BOB: [0, -0.28, 0.02, -0.12, 0],
    oHX: [-0.15, -0.25, 0.75, -0.7, -1.42], oHZ: [0.05, 0.25, 1.5, 1.0, 0.58], oKX: [0.3, 0.7, 0.45, 1.2, 1.6], oAX: [0, -0.2, -0.5, -0.3, -0.3],
    pHX: [0.1, -1.0, 0.35, -1.0, -1.42], pHZ: [0.05, 0.08, 0.15, 0.45, 0.58], pKX: [0.3, 1.6, 0.25, 1.35, 1.6], pAX: [0, -0.6, 0.55, -0.3, -0.3],
    nSX: [-0.3, -1.25, -1.0, -0.7, -0.6], nSZ: [0.15, -0.2, 0.0, 0.1, 0.12], nEX: [0.5, 0.35, 0.7, 1.05, 1.15],
    fSX: [-0.3, -0.8, -0.35, -0.6, -0.6], fSZ: [0.15, 0.35, 0.75, 0.25, 0.12], fEX: [0.5, 0.6, 0.35, 0.95, 1.15],
  },
  air: {
    SPX: [0.2, 0.9, 0.55, 0.3, 0.12], SPZ: [0, 0, 0, 0, 0], HDX: [-0.2, -0.7, -0.45, -0.2, -0.1], BOB: [0, -0.3, -0.12, -0.03, 0],
    oHX: [-0.9, -1.55, -1.5, -1.45, -1.42], oHZ: [0.8, 0.66, 0.6, 0.58, 0.58], oKX: [1.1, 1.95, 1.75, 1.65, 1.6], oAX: [-0.2, -0.45, -0.35, -0.3, -0.3],
    pHX: [-0.9, -1.55, -1.5, -1.45, -1.42], pHZ: [0.8, 0.66, 0.6, 0.58, 0.58], pKX: [1.1, 1.95, 1.75, 1.65, 1.6], pAX: [-0.2, -0.45, -0.35, -0.3, -0.3],
    nSX: [-1.0, -1.05, -0.8, -0.65, -0.6], nSZ: [0.6, 0.25, 0.15, 0.12, 0.12], nEX: [0.3, 0.55, 0.9, 1.1, 1.15],
    fSX: [-1.0, -1.05, -0.8, -0.65, -0.6], fSZ: [0.6, 0.25, 0.15, 0.12, 0.12], fEX: [0.3, 0.55, 0.9, 1.1, 1.15],
  },
};

const kf = (q: number, v0: number, v1: number, v2: number, v3: number): number =>
  (q < 0.2 ? lerp(v0, v1, sstep(0, 0.2, q)) : q < 0.58 ? lerp(v1, v2, sstep(0.2, 0.58, q)) : lerp(v2, v3, sstep(0.58, 1, q)));

// ───────────────────────────────────────────── modelling parts ─────────────────────────────────────────────
/** A modelling material: its colour, surface and emissive are baked per vertex (bakeParts), so it is never drawn. */
type PartMaterial = THREE.MeshStandardMaterial;
function partMat(color: THREE.ColorRepresentation, surf: Surface, emissive: THREE.ColorRepresentation = 0x000000): PartMaterial {
  const m = new THREE.MeshStandardMaterial({ color, emissive, roughness: surf.roughness, metalness: surf.metalness });
  m.userData.surf = surf;
  return m;
}
// a modelling part: a temporary Mesh in the joint hierarchy; _bake() merges it away
function mesh(geo: THREE.BufferGeometry, mat: PartMaterial, parent: THREE.Object3D | null, x = 0, y = 0, z = 0): THREE.Mesh<THREE.BufferGeometry, PartMaterial> {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  if (parent) parent.add(m);
  return m;
}
function group(parent: THREE.Object3D | null, x = 0, y = 0, z = 0): THREE.Group {
  const g = new THREE.Group(); g.position.set(x, y, z); if (parent) parent.add(g); return g;
}

// ───────────────────────────────────────────── part baking (draw-call merge) ─────────────────────────────────
let _bodyMat: THREE.MeshStandardMaterial | null = null;
const bodyMaterial = (): THREE.MeshStandardMaterial => (_bodyMat ||= grainMaterial({ emissive: true }));

interface BakePart { m: THREE.Mesh; rel: THREE.Matrix4; bone: number }
/**
 * Bakes parts into one geometry: position, normal, colour (the part material's colour), aSurf (its roughness,
 * metalness, grain) and aEmis (its emissive; a part flagged userData.flash takes the material's flash uniform instead).
 * skinned: every vertex weighted 1.0 to its part's bone.
 */
function bakeParts(parts: BakePart[], skinned: boolean): THREE.BufferGeometry {
  const P: number[] = [], N: number[] = [], C: number[] = [], S: number[] = [], E: number[] = [], B: number[] = [], I: number[] = [];
  const nm = new THREE.Matrix3(), v = new THREE.Vector3(), n = new THREE.Vector3();
  const col = new THREE.Color(), em = new THREE.Color();
  for (const { m, rel, bone } of parts) {
    const g = m.geometry, mat = m.material as PartMaterial, pa = g.attributes.position, na = g.attributes.normal;
    nm.getNormalMatrix(rel);
    const flash = m.userData.flash ? 1 : 0;
    const surf: Surface = mat.userData.surf ?? SURF.cloth;
    col.copy(mat.color);
    if (flash) em.setRGB(0, 0, 0); else em.copy(mat.emissive);
    const base = P.length / 3;
    for (let i = 0; i < pa.count; i++) {
      v.fromBufferAttribute(pa, i); n.fromBufferAttribute(na, i);
      v.applyMatrix4(rel); n.applyNormalMatrix(nm);
      P.push(v.x, v.y, v.z); N.push(n.x, n.y, n.z); C.push(col.r, col.g, col.b);
      S.push(surf.roughness, surf.metalness, surf.grain); E.push(em.r, em.g, em.b, flash); B.push(bone);
    }
    const ix = g.index ? g.index.array : null, cnt = ix ? ix.length : pa.count;
    for (let k = 0; k < cnt; k++) I.push(base + (ix ? ix[k] : k));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  geo.setAttribute('aSurf', new THREE.Float32BufferAttribute(S, 3));
  geo.setAttribute('aEmis', new THREE.Float32BufferAttribute(E, 4));
  geo.setIndex(I);
  if (skinned) {
    const si = new Uint16Array(B.length * 4), sw = new Float32Array(B.length * 4);
    for (let i = 0; i < B.length; i++) { si[i * 4] = B[i]; sw[i * 4] = 1; }
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  }
  return geo;
}

// reusable scratch
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();
const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);

/** The face, painted once as a decal over the skull: lids and lashes, grey-green irises, brows, soft nose and lips. */
let _faceTex: THREE.CanvasTexture | null = null;
function faceTexture(): THREE.CanvasTexture {
  if (_faceTex) return _faceTex;
  const W = 256, H = 160, c = makeCanvas();
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  for (const side of [-1, 1]) {
    const cx = W / 2 + side * 40, cy = 74;
    // eye socket shading
    const sock = g.createRadialGradient(cx, cy - 2, 2, cx, cy - 2, 26);
    sock.addColorStop(0, 'rgba(110,60,40,0.22)'); sock.addColorStop(1, 'rgba(110,60,40,0)');
    g.fillStyle = sock; g.beginPath(); g.ellipse(cx, cy - 2, 26, 18, 0, 0, TAU); g.fill();
    // almond eye: the white (not pure), a small iris, the pupil
    g.save();
    g.beginPath(); g.moveTo(cx - 15, cy + 1); g.quadraticCurveTo(cx - 2, cy - 9, cx + 15, cy - 1); g.quadraticCurveTo(cx + 1, cy + 7, cx - 15, cy + 1); g.closePath();
    g.fillStyle = '#ddd5c8'; g.fill(); g.clip();
    const ir = g.createRadialGradient(cx - side * 1, cy - 1, 1, cx - side * 1, cy - 1, 6.5);
    ir.addColorStop(0, '#4f6a5c'); ir.addColorStop(0.75, '#3a5045'); ir.addColorStop(1, '#22302a');
    g.fillStyle = ir; g.beginPath(); g.arc(cx - side * 1, cy - 1, 6.5, 0, TAU); g.fill();
    g.fillStyle = '#121513'; g.beginPath(); g.arc(cx - side * 1, cy - 1, 2.6, 0, TAU); g.fill();
    g.restore();
    // upper lid and lash line, the lower lid a faint crease
    g.strokeStyle = 'rgba(40,24,16,0.9)'; g.lineCap = 'round'; g.lineWidth = 2.6;
    g.beginPath(); g.moveTo(cx - 16, cy + 1); g.quadraticCurveTo(cx - 2, cy - 10, cx + 16, cy - 1.5); g.stroke();
    g.strokeStyle = 'rgba(120,70,50,0.35)'; g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(cx - 12, cy + 4); g.quadraticCurveTo(cx, cy + 8, cx + 12, cy + 3); g.stroke();
    // lid crease
    g.strokeStyle = 'rgba(110,62,42,0.35)'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(cx - 13, cy - 6); g.quadraticCurveTo(cx, cy - 14, cx + 14, cy - 7); g.stroke();
    // brow: a short, level band of hair, thicker at the inner end
    g.fillStyle = 'rgba(42,28,20,0.85)';
    g.beginPath();
    g.moveTo(cx - side * 19, cy - 16); g.quadraticCurveTo(cx, cy - 24, cx + side * 20, cy - 20);
    g.lineTo(cx + side * 20, cy - 17); g.quadraticCurveTo(cx, cy - 20, cx - side * 19, cy - 12);
    g.closePath(); g.fill();
  }
  // nose: shade down one side and under the tip; nostrils
  const nose = g.createLinearGradient(W / 2 - 8, 0, W / 2 + 8, 0);
  nose.addColorStop(0, 'rgba(120,70,48,0)'); nose.addColorStop(1, 'rgba(120,70,48,0.28)');
  g.fillStyle = nose; g.fillRect(W / 2 - 2, 80, 10, 30);
  g.fillStyle = 'rgba(110,60,42,0.35)'; g.beginPath(); g.ellipse(W / 2, 112, 11, 4, 0, 0, TAU); g.fill();
  g.fillStyle = 'rgba(70,36,26,0.5)';
  for (const s of [-1, 1]) { g.beginPath(); g.ellipse(W / 2 + s * 5, 112, 2.6, 1.6, 0, 0, TAU); g.fill(); }
  // lips: a slightly darker, warmer mouth with the line between them
  g.fillStyle = 'rgba(150,80,70,0.45)'; g.beginPath(); g.ellipse(W / 2, 133, 13, 4.5, 0, 0, TAU); g.fill();
  g.strokeStyle = 'rgba(80,38,30,0.7)'; g.lineWidth = 1.6;
  g.beginPath(); g.moveTo(W / 2 - 12, 132); g.quadraticCurveTo(W / 2, 134, W / 2 + 12, 132); g.stroke();
  _faceTex = new THREE.CanvasTexture(c);
  _faceTex.colorSpace = THREE.SRGBColorSpace;
  _faceTex.anisotropy = 4;
  return _faceTex;
}

const _fdown = new THREE.Vector3(0, -1, 0);
const SOLE = 0.075;   // ankle joint height above the sole
// leg geometry (see _build): hip joint → knee 0.43, knee → ankle 0.4; standing, the hip is LEG_H above the ankle
// (THIGH, SHIN and the leg numbers that follow them are the rest values below, rescaled to the leg config/character/soldier.json gives)
const LEG_DEFAULT = { thigh: 0.43, shin: 0.4, reach: 0.815, legH: 0.805, hipH: 0.88, kneeReach: 0.8 };
let THIGH = LEG_DEFAULT.thigh, SHIN = LEG_DEFAULT.shin, LEG_REACH = LEG_DEFAULT.reach, LEG_H = LEG_DEFAULT.legH;
const FOOT_BALL = 0.15, MOVE_V = 0.35;
const _l1 = new THREE.Vector3(), _l2 = new THREE.Vector3(), _l3 = new THREE.Vector3(), _l4 = new THREE.Vector3(), _l5 = new THREE.Vector3();
const _l6 = new THREE.Vector3(), _lv = new THREE.Vector3(), _l1b = new THREE.Vector3(), _lm = new THREE.Matrix4(), _lq = new THREE.Quaternion(), _lq2 = new THREE.Quaternion();
const _sol = { hx: 0, hz: 0, kx: 0 };
const _up = new THREE.Vector3(0, 1, 0);
const HEEL = 0.06;          // heel contact behind the ankle joint
let HIP_H = LEG_DEFAULT.hipH;         // hip joint above the ground, standing
let REACH = LEG_DEFAULT.kneeReach;    // hip → ankle with the knee just off straight (touchdown / toe-off)

// ───────────────────────────── the soldier's skeleton: config/character/soldier.json ─────────────────────────────
// The joint offsets and the launcher and blade-box mounts are data. The file is in the engine's frame (facing -Z, the
// soldier's left on -X), the model's is +Z with the left on +X, so x and z change sign on the way in. A project
// without the file, or with one that is wrong, gets the numbers the model was drawn with.
type V3T = readonly [number, number, number];
export interface SoldierRig { spine: V3T; head: V3T; shoulder: V3T; elbow: V3T; wrist: V3T; hip: V3T; knee: V3T; ankle: V3T; launcher: V3T; bladeBox: V3T }
export const SOLDIER_DEFAULT: SoldierRig = {
  spine: [0, 0.08, 0], head: [0, 0.455, 0], shoulder: [0.215, 0.405, 0], elbow: [0, -0.28, 0], wrist: [0, -0.26, 0],
  hip: [0.09, -0.02, 0], knee: [0, -0.43, 0], ankle: [0, -0.4, 0], launcher: [0.205, 0.035, 0], bladeBox: [0.215, -0.21, -0.09],
};
const flip = (n: number): number => (n === 0 ? 0 : -n);
const inFrame = (t: readonly number[]): V3T => [flip(t[0]!), t[1]!, flip(t[2]!)];
const BONE_OF: Record<Exclude<keyof SoldierRig, 'launcher' | 'bladeBox'>, string> = { spine: 'spine', head: 'head', shoulder: 'armL', elbow: 'forearmL', wrist: 'handL', hip: 'legL', knee: 'shinL', ankle: 'footL' };
/** Reads the soldier's rig from config (or the defaults), and rescales the leg numbers of the gait to its leg length. */
export function soldierRig(): SoldierRig {
  const out: SoldierRig = { ...SOLDIER_DEFAULT };
  const id = 'character/soldier';
  if (config.has(id)) {
    try {
      const c = config.lookup('character', 'soldier');
      const bones = new Map((c.body.bones ?? []).map((b) => [b.name, b.offset]));
      for (const k of Object.keys(BONE_OF) as (keyof typeof BONE_OF)[]) {
        const off = bones.get(BONE_OF[k]);
        if (!off) throw new Error(`${id}#/body/bones: the soldier needs a bone "${BONE_OF[k]}"`);
        out[k] = inFrame(off);
      }
      const sock = c.sockets ?? {};
      if (sock['launcherL']?.offset) out.launcher = inFrame(sock['launcherL'].offset);
      if (sock['bladeBoxL']?.offset) out.bladeBox = inFrame(sock['bladeBoxL'].offset);
    } catch (e) {
      console.warn(String(e));
      return soldierRigApply({ ...SOLDIER_DEFAULT });
    }
  }
  return soldierRigApply(out);
}
function soldierRigApply(r: SoldierRig): SoldierRig {
  const thigh = Math.abs(r.knee[1]), shin = Math.abs(r.ankle[1]);
  const k = (thigh + shin) / (LEG_DEFAULT.thigh + LEG_DEFAULT.shin);
  THIGH = thigh; SHIN = shin;
  LEG_REACH = LEG_DEFAULT.reach * k; LEG_H = LEG_DEFAULT.legH * k; HIP_H = LEG_DEFAULT.hipH * k; REACH = LEG_DEFAULT.kneeReach * k;
  return r;
}

/** A part material: the project's material/soldier-<name> if it has one (colour, roughness, metalness), else the literals. */
function cfgMat(name: string, color: THREE.ColorRepresentation, surf: Surface, emissive: THREE.ColorRepresentation = 0x000000): PartMaterial {
  const id = `soldier-${name}`;
  if (!config.has(`material/${id}`)) return partMat(color, surf, emissive);
  const m = config.lookup('material', id);
  return partMat(m.color, { roughness: m.roughness ?? surf.roughness, metalness: m.metalness ?? surf.metalness, grain: surf.grain }, emissive);
}
export const SOLDIER_MATERIALS = ['jacket', 'jacketDark', 'trousers', 'boot', 'skin', 'hair', 'strap', 'brass', 'steel', 'steelDark', 'cravat', 'cape', 'blade', 'edge', 'grip'] as const;
const SKID_V = 13.5;        // on the ground faster than a run (a landing off the wires): a skid
/** Where the ankle sits relative to the contact point for a foot pitch (+ = toe down, pivot on the ball; − = toe up,
 *  pivot on the heel): f = along the foot (− = behind the ball), u = up. Written to _ao. */
const _ao = { f: 0, u: 0 };
function ankleOff(pitch: number): typeof _ao {
  if (pitch >= 0) { const c = Math.cos(pitch), s = Math.sin(pitch); _ao.f = -(FOOT_BALL * c - SOLE * s); _ao.u = FOOT_BALL * s + SOLE * c; }
  else { const a = -pitch, c = Math.cos(a), s = Math.sin(a); _ao.f = -(FOOT_BALL + HEEL) + HEEL * c - SOLE * s; _ao.u = HEEL * s + SOLE * c; }
  return _ao;
}
/** Ankle position for a foot whose ball rests at `ball` (on the ground line), pointing along `fd`, pitched by `pitch`. */
function ankleFromContact(ball: THREE.Vector3, fd: THREE.Vector3, pitch: number, up: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  ankleOff(pitch);
  return out.copy(ball).addScaledVector(fd, _ao.f).addScaledVector(up, _ao.u);
}

interface Foot {
  ball: THREE.Vector3; fd: THREE.Vector3;          // planted contact (ball of the foot) and its heading
  from: THREE.Vector3; fromRel: THREE.Vector3; fromPitch: number;   // lift-off: ankle (world, and from the hips), pitch
  to: THREE.Vector3; toBall: THREE.Vector3; toFd: THREE.Vector3; toPitch: number;   // next foothold
  swing: boolean; timed: boolean; committed: boolean;
  u: number; u0: number; t: number; dur: number; tRem: number; tSw: number;
  pitch: number; ankle: THREE.Vector3;
}
interface Gait {
  p: number; v: number; acc: number; hvPrev: number;
  cad: number; step: number; duty: number; stance: number; tdShare: number; base: number; drop: number;
  runK: number; sprint: number; wSkid: number; skidLead: number;
  pTD: number; pTO: number; pMid: number;
  moving: boolean; init: boolean;
  feet: [Foot, Foot];
}
const newFoot = (): Foot => ({
  ball: new THREE.Vector3(), fd: new THREE.Vector3(0, 0, 1), from: new THREE.Vector3(), fromRel: new THREE.Vector3(), fromPitch: 0,
  to: new THREE.Vector3(), toBall: new THREE.Vector3(), toFd: new THREE.Vector3(0, 0, 1), toPitch: 0,
  swing: false, timed: false, committed: false, u: 0, u0: 0, t: 0, dur: 0.3, tRem: 0, tSw: 0.3, pitch: 0, ankle: new THREE.Vector3(),
});
const newGait = (): Gait => ({
  p: 0, v: 0, acc: 0, hvPrev: -1, cad: 1.8, step: 0.6, duty: 0.6, stance: 0.7, tdShare: 0.5, base: 0.012, drop: 0,
  runK: 0, sprint: 0, wSkid: 0, skidLead: -1, pTD: 0, pTO: 0.5, pMid: 0, moving: false, init: false,
  feet: [newFoot(), newFoot()],
});
/**
 * Two-bone leg IK in the pivot frame: hip rotation (x = flexion, z = abduction, Euler XYZ as the joints use) and knee
 * flexion that put the ankle on `target` (world), knee forward. One correction pass takes up the small error the
 * abduction approximation leaves. Writes _sol.
 */
function solveLeg(L: LegJoints, pivot: THREE.Object3D, target: THREE.Vector3): void {
  _lm.copy(pivot.matrixWorld).invert();
  const tl = _l3.copy(target).applyMatrix4(_lm).sub(L.hip.position);
  const d = _l6.copy(tl);
  for (let pass = 0; pass < 3; pass++) {
    const D = clamp(d.length(), 0.25, THIGH + SHIN - 0.004);
    const down = Math.sqrt(d.y * d.y + d.z * d.z) || 1e-4;
    const hz = Math.atan2(d.x, down);
    const dn = d.x * Math.sin(hz) - d.y * Math.cos(hz);                  // along the abducted 'down'
    const line = Math.atan2(-d.z, dn);                                   // + = target behind the hip
    const beta = Math.acos(clamp((THIGH * THIGH + D * D - SHIN * SHIN) / (2 * THIGH * D), -1, 1));
    const gamma = Math.acos(clamp((THIGH * THIGH + SHIN * SHIN - D * D) / (2 * THIGH * SHIN), -1, 1));
    _sol.hx = line - beta; _sol.hz = hz; _sol.kx = Math.PI - gamma;
    if (pass === 2) break;
    // exact forward kinematics of that pose (hip = Rx(hx)·Rz(hz), knee = Rx(kx)), then aim off by the miss
    const sx = Math.sin(_sol.hx), cx = Math.cos(_sol.hx), sz = Math.sin(hz), cz = Math.cos(hz);
    const sk = Math.sin(_sol.kx), ck = Math.cos(_sol.kx);
    const lx = THIGH * sz + SHIN * ck * sz, ly = -THIGH * cz - SHIN * ck * cz, lz = -SHIN * sk;   // after Rz, knee
    const ax = lx, ay = ly * cx - lz * sx, az = ly * sx + lz * cx;
    d.x += tl.x - ax; d.y += tl.y - ay; d.z += tl.z - az;
  }
}
/** Ankle joint rotation (relative to the knee) that points the foot along `fd`, toe-down by `pitch`, foot up ≈ `up`. */
function footQuatLocal(kn: THREE.Object3D, fd: THREE.Vector3, pitch: number, up: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  const z = _l6.copy(fd).multiplyScalar(Math.cos(pitch)).addScaledVector(up, -Math.sin(pitch)).normalize();
  const x = _l3.crossVectors(up, z).normalize(), y = _l1b.crossVectors(z, x);
  out.setFromRotationMatrix(_lm.makeBasis(x, y, z));
  return out.premultiply(kn.getWorldQuaternion(_lq2).invert());
}

/**
 * A soldier (the player or a comrade) fires a signal round: draw, raise the arm, fire at 0.45 s, lower it. o.flareA is
 * set by fireFlare(); call each frame and pass the result as the model's `flare` weight.
 */
/** A signal round being fired (fireFlare sets it; flareStep runs it). */
export interface FlareShot { t: number; color: string; dir: THREE.Vector3 | null; fired: boolean }
/** Whoever fires one: the player or a comrade. */
export interface FlareShooter {
  flareA: FlareShot | null;
  game: Game;
  pos: THREE.Vector3;
  render?: THREE.Vector3;
  model?: { root?: THREE.Object3D; flareMuzzlePos?(out: THREE.Vector3): THREE.Vector3 } | null;
}
export function flareStep(o: FlareShooter, dt: number): number {
  const A = o.flareA;
  if (!A) return 0;
  A.t += dt;
  if (!A.fired && A.t > 0.45) {
    A.fired = true;
    const g = o.game, at = o.render || o.pos;
    const m = o.model?.flareMuzzlePos && o.model.root?.visible ? o.model.flareMuzzlePos(new THREE.Vector3()) : at.clone().setY(at.y + 2);
    g.fx?.flare?.(m, A.color, A.dir);
    g.fx?.sparks?.(m, new THREE.Vector3(0, 1, 0), 10);
    g.audio?.hookFire?.(1);
  }
  if (A.t > 2) o.flareA = null;
  return A.t < 1.5 ? 1 : Math.max(0, 1 - (A.t - 1.5) / 0.4);
}

/** A horse-mounting move, keyed: k 0..1 through it (≥ 1 = done), which way the horse is (side > 0: on our right). */
export interface MountState { k: number; kind?: 'run' | 'air' | string; side?: number }
/** A tether hook as the model sees it: attached ones pull the body's lean toward their anchors. */
export interface HookView { attached: boolean; anchor: THREE.Vector3 | null; state?: string }

/** Everything a body (the player, a comrade) tells the model each frame. Only position is required. */
export interface ModelState {
  /** body centre (the feet are 0.9 m below it standing) */
  position: THREE.Vector3;
  velocity?: THREE.Vector3;
  /** where the chest faces / which way is up for the body */
  forward?: THREE.Vector3;
  up?: THREE.Vector3;
  /** speed override (m/s); defaults to |velocity| */
  speed?: number;
  grounded?: boolean;
  /** 0..1 running weight (ground speed / run speed) */
  running?: number;
  /** 0..1 skidding or braking hard on the ground (also inferred from the deceleration) */
  skid?: number;
  crouch?: number;
  landPrep?: number;
  riding?: number;
  straddle?: number;
  horseGallop?: number;
  /** horse gait phase in cycles */
  horsePhase?: number;
  mount?: MountState | null;
  hooks?: readonly (HookView | null | undefined)[];
  boosting?: number;
  /** 0..1 through a slash, or < 0 when not slashing */
  slash?: number;
  spin?: boolean;
  grabbed?: boolean;
  /** blades drawn (false while swapping, or riding) */
  blades?: boolean;
  alive?: boolean;
  /** 0..1 weight of the signal-gun pose (flareStep) */
  flare?: number;
  /** false: don't plant the feet on the ground (no collision world, or a cutscene) */
  footIK?: boolean;
}

interface ArmJoints { sh: THREE.Group; el: THREE.Group; wr: THREE.Group; blade: THREE.Group; handle: THREE.Object3D[] }
interface LegJoints { hip: THREE.Group; kn: THREE.Group; an: THREE.Group }
interface Joints {
  spine: THREE.Group; chest: THREE.Group; head: THREE.Group;
  armL: ArmJoints; armR: ArmJoints; legL: LegJoints; legR: LegJoints;
  blades: THREE.Group[];
}
interface CapeCollider { o: THREE.Object3D; r: number }

export class PlayerModel {
  game: Game | null;
  /** update() calls game.fx.gas() itself while boosting (set false when the core draws the gas) */
  autoGas = true;
  root: THREE.Group;
  /** carries the body's orientation (root only translates) */
  pivot: THREE.Group;
  time = 0;
  j!: Joints;
  mats!: Record<string, PartMaterial>;
  cape: CapeSim;
  /** cloak LOD for comrades: simulate every Nth frame (with the summed time) */
  capeEvery = 1;
  _capeN = 0;
  _capeDt = 0;
  locks: THREE.Group[] = [];
  // smoothed weights
  wRide = 0; wCrouch = 0; wAir = 0; wSpin = 0; wGrab = 0; wSlash = 0; wHook = 0; wBoost = 0; wRun = 0; wLand = 0; wFlare = 0;
  theta = 0.05; roll = 0; spinAngle = 0; slashP = 0;
  up = new THREE.Vector3(0, 1, 0);
  heading = new THREE.Vector3(0, 0, 1);
  fwd = new THREE.Vector3(0, 0, 1);
  yawRate = 0; _prevHeading = new THREE.Vector3(0, 0, 1);
  /** gait phase (radians): the arms and the fallback leg cycle */
  phase = 0;
  speedS = 0;
  pos = new THREE.Vector3();
  q = new THREE.Quaternion();
  /** current (damped) joint values; targets per pose: ground, air, slash, spin, grabbed, combined; the stride swing */
  J = new Float32Array(NCH);
  TG = new Float32Array(NCH); TA = new Float32Array(NCH); TS = new Float32Array(NCH);
  TP = new Float32Array(NCH); TR = new Float32Array(NCH); TC = new Float32Array(NCH);
  TO = new Float32Array(NCH);
  /** the joint values actually applied this frame (J + the stride swing + wrist hold) */
  JF = new Float32Array(NCH);
  first = true;
  bladeFlash = 0;
  noBladeT = 0;
  gait: Gait | null = null;
  _gasPos = new THREE.Vector3(); _gasDir = new THREE.Vector3();
  // built parts
  _face: THREE.Mesh | null = null;
  flareGun!: THREE.Group;
  flareMuzzle!: THREE.Group;
  /** the tether-gear rig on the pelvis (reels, launchers, blade boxes) */
  gear!: THREE.Group;
  launcherL!: THREE.Object3D;
  launcherR!: THREE.Object3D;
  bladeBoxes: THREE.Group[] = [];
  nozzle!: THREE.Object3D;
  jet!: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial>;
  jetMat!: THREE.MeshBasicMaterial;
  col: CapeCollider[] = [];
  pins: THREE.Object3D[] = [];
  skeleton!: THREE.Skeleton;
  body!: THREE.SkinnedMesh;
  bladeMat!: THREE.MeshStandardMaterial;
  capeGeo!: THREE.BufferGeometry;
  capeMat!: THREE.MeshStandardMaterial;
  capeOuter!: THREE.Mesh;
  capeInner!: THREE.Mesh;

  constructor(game: Game | null) {
    this.game = game;
    this.root = new THREE.Group();
    this.root.name = 'PlayerModel';
    this.pivot = group(this.root);
    if (game && game.scene) game.scene.add(this.root);       // idempotent: the core may add it again
    this.cape = new CapeSim();
    this._construct();
    this._follow();
  }

  /** Builds the body, the cloak mesh, the face and the loose locks (again, on a config change). */
  _construct(): void {
    this._build();
    this._buildCapeMesh();
    if (this._face) this.j.head.add(this._face);
    // loose locks on top of the baked hair: they stream back with speed and flutter in the air
    {
      const hm = new THREE.MeshStandardMaterial({ color: 0x2a1f18, roughness: 0.55 });
      const lg = new THREE.SphereGeometry(0.03, 8, 5); lg.scale(1, 0.35, 1.6); lg.translate(0, 0, -0.035);
      for (let i = 0; i < 3; i++) {
        const piv = new THREE.Group();
        piv.position.set((i - 1) * 0.035, 0.243 - Math.abs(i - 1) * 0.008, 0.02 - Math.abs(i - 1) * 0.01);
        const m = new THREE.Mesh(lg, hm); m.castShadow = false;
        m.rotation.x = -0.25;                   // lying back over the crown
        piv.add(m); this.j.head.add(piv);
        this.locks.push(piv);
      }
    }
  }

  // ───────────────────────────── construction ─────────────────────────────
  _build(): void {
    const M = this.mats = {
      jacket: cfgMat('jacket', 0x86684a, SURF.cloth), jacketDark: cfgMat('jacketDark', 0x5c4630, SURF.leather), trousers: cfgMat('trousers', 0xd6cfbe, SURF.cloth),
      boot: cfgMat('boot', 0x34251a, SURF.leather), skin: cfgMat('skin', 0xd2a283, SURF.skin), hair: cfgMat('hair', 0x2a1f18, SURF.hair),
      strap: cfgMat('strap', 0x2c1e15, SURF.leather), brass: cfgMat('brass', 0xa8894c, SURF.brass),
      steel: cfgMat('steel', 0xa9b1b9, SURF.steel), steelDark: cfgMat('steelDark', 0x4b5159, SURF.darkSteel),
      cravat: cfgMat('cravat', 0xe0dccf, SURF.cloth), cape: cfgMat('cape', 0x2b4433, SURF.wool),
      blade: cfgMat('blade', 0xc8d0d8, SURF.blade), edge: cfgMat('edge', 0xeef2f6, { roughness: 0.12, metalness: 1, grain: 0.05 }), grip: cfgMat('grip', 0x1f1b18, SURF.leather),
    };
    this.jetMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    const P = this.pivot;
    const S = soldierRig();
    const J = {} as Joints;
    this.j = J;
    // the head is a little narrower than it is tall or deep (an adult's, not a child's)
    const HSX = 0.9;

    // ── pelvis / trousers / belt
    const pelvis = mesh(new THREE.BoxGeometry(0.31, 0.17, 0.2), M.trousers, P, 0, -0.025, 0);
    mesh(new THREE.CylinderGeometry(0.165, 0.17, 0.05, 18), M.strap, P, 0, 0.05, 0).scale.set(1.0, 1, 0.74);

    // ── spine / chest
    J.spine = group(P, ...S.spine);
    const chest = J.chest = group(J.spine, 0, 0, 0);
    const jacket = mesh(new THREE.CylinderGeometry(0.168, 0.15, 0.42, 20), M.jacket, chest, 0, 0.21, 0);
    jacket.scale.set(1.18, 1, 0.8);
    // cropped hem flare + stand-up collar
    mesh(new THREE.CylinderGeometry(0.152 * 1.18, 0.18 * 1.18, 0.09, 20), M.jacket, chest, 0, -0.025, 0).scale.set(1, 1, 0.78);
    const collar = mesh(new THREE.TorusGeometry(0.085, 0.024, 8, 20), M.jacketDark, chest, 0, 0.43, 0);
    collar.rotation.x = Math.PI / 2;
    // shoulders
    for (const sx of [1, -1]) mesh(new THREE.SphereGeometry(0.052, 12, 10), M.jacket, chest, sx * 0.215, 0.405, 0);

    // ── head
    const head = J.head = group(chest, ...S.head);
    mesh(new THREE.CylinderGeometry(0.043, 0.049, 0.08, 12), M.skin, head, 0, 0.0, 0);                    // neck
    const skull = mesh(new THREE.SphereGeometry(0.1, 24, 18), M.skin, head, 0, 0.145, 0.008);
    skull.scale.set(0.96 * HSX, 1.08, 1.0);
    mesh(new THREE.SphereGeometry(0.05, 12, 8), M.skin, head, 0, 0.1, 0.035).scale.set(1.1, 0.75, 1.0);     // jaw
    // short cropped hair: a cap over the crown and the back of the head, a fringe swept to one side, sideburns
    // (the cap is tipped back: the hairline sits high on the brow, the hair comes low at the nape)
    const hair = mesh(new THREE.SphereGeometry(0.106, 32, 16, 0, TAU, 0, 1.62), M.hair, head, 0, 0.148, -0.006);
    hair.scale.set(0.99 * HSX, 1.06, 1.05); hair.rotation.x = -0.42;
    const fringe = mesh(new THREE.SphereGeometry(0.06, 16, 8), M.hair, head, 0.012, 0.215, 0.06);
    fringe.scale.set(1.25, 0.32, 0.62); fringe.rotation.set(0.42, 0, -0.18);
    for (const sx of [1, -1]) {
      mesh(new THREE.BoxGeometry(0.012, 0.04, 0.022), M.hair, head, sx * 0.079, 0.142, 0.03);              // sideburns
      mesh(new THREE.SphereGeometry(0.017, 8, 6), M.skin, head, sx * 0.083, 0.14, 0).scale.set(0.6, 1.2, 1);   // ears
    }
    mesh(new THREE.ConeGeometry(0.014, 0.04, 6), M.skin, head, 0, 0.13, 0.1).rotation.x = 1.25;                 // nose
    // the face: lids, irises, brows, nose shading and mouth painted on a patch that hugs the skull
    {
      const face = new THREE.Mesh(
        new THREE.SphereGeometry(0.1, 24, 16, Math.PI / 2 - 0.95, 1.9, 0.95, 1.15),
        new THREE.MeshStandardMaterial({ map: faceTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, roughness: 0.6 }));
      face.position.set(0, 0.145, 0.008); face.scale.set(0.96 * HSX * 1.012, 1.08 * 1.012, 1.012);
      face.renderOrder = 1;
      this._face = face;    // attached after the bake (not merged into the body)
    }
    // cravat (the white jabot)
    const cr = mesh(new THREE.ConeGeometry(0.052, 0.13, 10), M.cravat, chest, 0, 0.375, 0.12);
    cr.rotation.x = Math.PI * 0.07; cr.rotation.z = Math.PI;
    mesh(new THREE.TorusGeometry(0.066, 0.016, 8, 16), M.cravat, chest, 0, 0.452, 0.0).rotation.x = Math.PI / 2;
    // hood (down): a bunched cowl behind the neck and over the shoulders
    const hood = mesh(new THREE.SphereGeometry(0.115, 14, 10), M.cape, chest, 0, 0.455, -0.1);
    hood.scale.set(1.55, 0.72, 0.85);
    const hood2 = mesh(new THREE.TorusGeometry(0.14, 0.03, 8, 20, Math.PI * 1.3), M.cape, chest, 0, 0.44, -0.015);
    hood2.rotation.x = Math.PI / 2; hood2.rotation.z = Math.PI * 0.85;

    // ── harness straps (tubes hugging the jacket), chest X, waist belts
    const surf = (phi: number, y: number): THREE.Vector3 => {
      const t = clamp(y / 0.42, 0, 1), a = 0.168 * 1.18 * lerp(0.9, 1.0, t) + 0.006, b = 0.168 * 0.8 * lerp(0.92, 1.0, t) + 0.006;
      return new THREE.Vector3(Math.sin(phi) * a, y, Math.cos(phi) * b);
    };
    const strap = (pts: THREE.Vector3[], r: number, mat: PartMaterial, parent: THREE.Object3D): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 28, r, 6, false), mat);
      parent.add(m); return m;
    };
    for (const sx of [1, -1]) {
      strap([surf(-sx * 0.75, 0.04), surf(-sx * 0.35, 0.16), surf(0.12 * sx, 0.31), surf(sx * 0.62, 0.42), surf(sx * 1.35, 0.4), surf(sx * 2.4, 0.26), surf(sx * 2.9, 0.1)], 0.014, M.strap, chest);
    }
    strap(Array.from({ length: 14 }, (_, i) => surf((i / 13) * TAU - Math.PI, 0.04)), 0.016, M.strap, chest).position.y = 0;
    strap(Array.from({ length: 14 }, (_, i) => surf((i / 13) * TAU - Math.PI, 0.3)), 0.012, M.strap, chest);
    mesh(new THREE.BoxGeometry(0.05, 0.04, 0.016), M.brass, chest, 0, 0.04, 0.138);        // belt buckle
    mesh(new THREE.BoxGeometry(0.03, 0.03, 0.014), M.brass, chest, 0, 0.215, 0.134);       // chest buckle

    // ── arms
    const arm = (side: 0 | 1): ArmJoints => {
      const sx = side === 0 ? 1 : -1;
      const sh = group(chest, sx * S.shoulder[0], S.shoulder[1], S.shoulder[2]);
      mesh(new THREE.CylinderGeometry(0.043, 0.037, 0.28, 12), M.jacket, sh, 0, -0.14, 0);
      const el = group(sh, ...S.elbow);
      mesh(new THREE.SphereGeometry(0.04, 10, 8), M.jacket, el, 0, 0, 0);
      mesh(new THREE.CylinderGeometry(0.037, 0.031, 0.26, 12), M.jacket, el, 0, -0.13, 0);
      mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.04, 12), M.strap, el, 0, -0.235, 0);  // cuff
      const wr = group(el, ...S.wrist);
      mesh(new THREE.SphereGeometry(0.042, 12, 10), M.skin, wr, 0, -0.025, 0.0).scale.set(0.85, 1.15, 1.1);   // fist
      // grip + guard + blade (blade points along the forearm: -Y)
      const grip = mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.15, 8), M.grip, wr, 0, -0.03, 0);
      // the hardened-steel blade: a long, broad, square-backed blade with a raked tip, scored into snap-off
      // segments, a darker back and a bright ground edge
      const blade = new THREE.Group(); wr.add(blade);
      mesh(new THREE.BoxGeometry(0.085, 0.03, 0.04), M.steelDark, blade, 0, -0.11, 0);           // guard
      mesh(new THREE.BoxGeometry(0.03, 0.05, 0.03), M.brass, blade, sx * 0.03, -0.085, 0);       // trigger block
      const L = 0.9, W = 0.064, T = 0.009;
      const sh2 = new THREE.Shape();
      sh2.moveTo(-W / 2, 0); sh2.lineTo(W / 2, 0); sh2.lineTo(W / 2, -L * 0.9); sh2.lineTo(-W / 2, -L); sh2.lineTo(-W / 2, 0);
      const bg = new THREE.ExtrudeGeometry(sh2, { depth: T, bevelEnabled: false });
      bg.translate(0, -0.125, -T / 2);
      const bm = mesh(bg, M.blade, blade); bm.userData.flash = true;
      mesh(new THREE.BoxGeometry(0.012, L * 0.97, T + 0.002), M.steelDark, blade, -W / 2 + 0.006, -0.125 - L * 0.485, 0);   // back
      mesh(new THREE.BoxGeometry(0.007, L * 0.88, T + 0.0015), M.edge, blade, W / 2 - 0.0035, -0.125 - L * 0.44, 0);       // edge
      for (let i = 1; i <= 7; i++) {               // the snap-off scores, raked like the tip
        const sc = mesh(new THREE.BoxGeometry(W * 0.86, 0.004, T + 0.002), M.steelDark, blade, 0.003, -0.125 - (L * 0.9) * i / 8.2, 0);
        sc.rotation.z = 0.1;
      }
      return { sh, el, wr, blade, handle: [grip] };
    };
    J.armL = arm(0); J.armR = arm(1);
    // the signal gun (a wide-barrelled flare pistol), in the right hand only while a smoke round is fired
    const gun = this.flareGun = group(J.armR.wr, 0, -0.02, 0.01); gun.visible = false;
    mesh(new THREE.CylinderGeometry(0.03, 0.033, 0.21, 10), M.steelDark, gun, 0, -0.13, 0);
    mesh(new THREE.CylinderGeometry(0.037, 0.037, 0.028, 10), M.brass, gun, 0, -0.24, 0);
    mesh(new THREE.BoxGeometry(0.032, 0.09, 0.05), M.grip, gun, 0, -0.02, 0.035);
    this.flareMuzzle = group(gun, 0, -0.27, 0);

    // ── legs
    const leg = (side: 0 | 1): LegJoints => {
      const sx = side === 0 ? 1 : -1;
      const hip = group(P, sx * S.hip[0], S.hip[1], S.hip[2]);
      mesh(new THREE.CylinderGeometry(0.083, 0.063, 0.43, 14), M.trousers, hip, 0, -0.215, 0);
      const kn = group(hip, ...S.knee);
      mesh(new THREE.SphereGeometry(0.064, 12, 8), M.trousers, kn, 0, 0, 0);
      mesh(new THREE.CylinderGeometry(0.06, 0.048, 0.1, 12), M.trousers, kn, 0, -0.05, 0);
      mesh(new THREE.CylinderGeometry(0.064, 0.05, 0.3, 14), M.boot, kn, 0, -0.2, 0);           // boot shaft
      mesh(new THREE.CylinderGeometry(0.07, 0.066, 0.025, 14), M.boot, kn, 0, -0.055, 0);       // boot cuff
      const an = group(kn, ...S.ankle);
      mesh(new THREE.BoxGeometry(0.088, 0.065, 0.25), M.boot, an, 0, -0.02, 0.06);
      mesh(new THREE.BoxGeometry(0.09, 0.02, 0.255), M.strap, an, 0, -0.05, 0.06);              // sole
      // harness: thigh rings + front strap, shin strap
      for (const y of [-0.1, -0.29]) { const t = mesh(new THREE.TorusGeometry(0.083 - (y < -0.2 ? 0.014 : 0), 0.013, 6, 16), M.strap, hip, 0, y, 0); t.rotation.x = Math.PI / 2; }
      mesh(new THREE.BoxGeometry(0.028, 0.032, 0.014), M.brass, hip, 0, -0.1, 0.082);
      mesh(new THREE.BoxGeometry(0.018, 0.38, 0.01), M.strap, hip, 0, -0.2, 0.074);
      const t2 = mesh(new THREE.TorusGeometry(0.062, 0.011, 6, 14), M.strap, kn, 0, -0.12, 0); t2.rotation.x = Math.PI / 2;
      return { hip, kn, an };
    };
    J.legL = leg(0); J.legR = leg(1);

    // ── tether gear: the reel unit on the lower back, a steel frame round the hips to the anchor launchers, and
    // under them the two long blade boxes hanging along the outer thighs, raked down and back, each holding spare
    // blades (tangs out of the front slot) with its gas cylinder strapped along the top. All on the pelvis (baked
    // into the body mesh, no extra draw calls): on the thigh bones the 0.5 m boxes would lever up into the back.
    const gear = group(P, 0, 0.0, 0);
    this.gear = gear;
    const tube = (pts: THREE.Vector3[], r: number, mat: PartMaterial, parent: THREE.Object3D): THREE.Mesh =>
      mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 12, r, 6, false), mat, parent);
    // central unit: mounting plate on the belt, twin wire reels (discs facing back), the gas regulator between them
    mesh(new THREE.BoxGeometry(0.25, 0.12, 0.05), M.steelDark, gear, 0, -0.03, -0.13);
    mesh(new THREE.BoxGeometry(0.2, 0.025, 0.06), M.steel, gear, 0, 0.035, -0.135);              // top rail
    for (const sx of [1, -1]) {
      const reel = mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.05, 18), M.steel, gear, sx * 0.07, -0.03, -0.18);
      reel.rotation.x = Math.PI / 2;
      mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.012, 16), M.steelDark, reel, 0, -0.028, 0);   // recessed face
      mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.02, 10), M.brass, reel, 0, -0.036, 0);      // hub
      mesh(new THREE.BoxGeometry(0.03, 0.03, 0.04), M.steelDark, gear, sx * 0.105, 0.03, -0.17);  // wire guide
    }
    const reg = mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.17, 12), M.steel, gear, 0, -0.035, -0.205);
    mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.02, 12), M.brass, reg, 0, 0.08, 0);
    mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.02, 12), M.brass, reg, 0, -0.03, 0);
    const nz = mesh(new THREE.CylinderGeometry(0.014, 0.024, 0.04, 10), M.steelDark, reg, 0, -0.1, 0); // gas nozzle
    nz.rotation.x = -0.3;
    const boxM = new THREE.Matrix4(), boxP = new THREE.Vector3();
    for (const sx of [1, -1]) {
      // frame arm from the unit round the hip to the launcher
      tube([new THREE.Vector3(sx * 0.11, 0.0, -0.14), new THREE.Vector3(sx * 0.17, 0.02, -0.1), new THREE.Vector3(sx * 0.2, 0.03, -0.04)], 0.014, M.steelDark, gear);
      // launcher at the hip, barrel forward
      const lh = group(gear, sx * S.launcher[0], S.launcher[1], S.launcher[2]);
      const drum = mesh(new THREE.CylinderGeometry(0.048, 0.048, 0.06, 14), M.steelDark, lh, 0, 0, -0.01);
      drum.rotation.z = Math.PI / 2;
      mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.066, 12), M.brass, drum, 0, 0, 0);
      mesh(new THREE.BoxGeometry(0.05, 0.07, 0.1), M.steelDark, lh, 0, -0.005, 0.045);
      const barrel = mesh(new THREE.CylinderGeometry(0.019, 0.024, 0.09, 10), M.steel, lh, 0, 0.005, 0.12);
      barrel.rotation.x = Math.PI / 2;
      const tip = new THREE.Object3D(); tip.position.set(0, 0.005, 0.165); lh.add(tip);
      if (sx > 0) this.launcherL = tip; else this.launcherR = tip;
      // blade box: a long bevel-nosed steel case, raked down towards the back and splayed a little at the tail
      const bx = group(gear, sx * S.bladeBox[0], S.bladeBox[1], S.bladeBox[2]);
      bx.rotation.set(-0.3, -sx * 0.1, 0);
      this.bladeBoxes.push(bx);
      const BL = 0.56, BH = 0.15, BW = 0.064;
      const prof = new THREE.Shape();
      prof.moveTo(-BL / 2, -BH / 2); prof.lineTo(BL / 2 - 0.035, -BH / 2); prof.lineTo(BL / 2, -0.01);
      prof.lineTo(BL / 2 - 0.02, BH / 2); prof.lineTo(-BL / 2 + 0.02, BH / 2); prof.lineTo(-BL / 2, BH / 2 - 0.03); prof.lineTo(-BL / 2, -BH / 2);
      const bg = new THREE.ExtrudeGeometry(prof, { depth: BW, bevelEnabled: false });
      bg.translate(0, 0, -BW / 2); bg.rotateY(-Math.PI / 2);              // profile x → +z (front), extrusion → x
      mesh(bg, M.steel, bx, 0, 0, 0);
      // outer-face panel, the dark lid over the front slot, and the spare blades' tangs standing out of it
      mesh(new THREE.BoxGeometry(0.006, BH * 0.62, BL * 0.7), M.steelDark, bx, sx * (BW / 2 + 0.001), -0.008, -0.04);
      mesh(new THREE.BoxGeometry(BW + 0.006, 0.02, 0.07), M.steelDark, bx, 0, BH / 2 - 0.004, BL / 2 - 0.05);
      for (let i = 0; i < 4; i++) {
        const tg = mesh(new THREE.BoxGeometry(0.008, 0.055, 0.045), i === 3 ? M.brass : M.steel, bx, (i - 1.5) * 0.014, 0.02, BL / 2 + 0.006);
        tg.rotation.x = 0.35;
      }
      // the gas cylinder along the top, held by two strap bands round box and cylinder
      const cyl = mesh(new THREE.CylinderGeometry(0.037, 0.037, 0.42, 14), M.steel, bx, 0, BH / 2 + 0.034, -0.05);
      cyl.rotation.x = Math.PI / 2;
      for (const e of [1, -1]) {
        const cap = mesh(new THREE.SphereGeometry(0.037, 14, 8, 0, TAU, 0, Math.PI / 2), M.steel, cyl, 0, e * 0.21, 0);
        if (e < 0) cap.rotation.x = Math.PI;
      }
      mesh(new THREE.CylinderGeometry(0.039, 0.039, 0.02, 14), M.brass, cyl, 0, 0.15, 0);
      mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.05, 8), M.brass, cyl, 0, -0.255, 0);       // valve (rear)
      for (const z of [0.1, -0.17]) mesh(new THREE.BoxGeometry(BW + 0.008, BH + 0.08, 0.024), M.strap, bx, 0, 0.032, z);
      // hanger from the launcher frame down to the box, and the gas hose from the valve to the regulator
      mesh(new THREE.BoxGeometry(0.03, 0.13, 0.04), M.steelDark, bx, -sx * 0.02, BH / 2 + 0.075, 0.13);
      bx.updateMatrix(); boxM.copy(bx.matrix);
      boxP.set(0, BH / 2 + 0.034, -0.05 - 0.28).applyMatrix4(boxM);
      tube([boxP.clone(), new THREE.Vector3(sx * 0.17, -0.12, -0.24), new THREE.Vector3(sx * 0.05, -0.06, -0.22), new THREE.Vector3(sx * 0.026, -0.04, -0.205)], 0.009, M.strap, gear);
      // the thigh hanger strap: belt → box (sits outside the trouser leg)
      mesh(new THREE.BoxGeometry(0.02, 0.12, 0.012), M.strap, gear, sx * 0.19, -0.04, 0.07);
    }
    // gas nozzle & jet cone
    this.nozzle = new THREE.Object3D(); this.nozzle.position.set(0, -0.06, -0.205); P.add(this.nozzle);
    const jet = new THREE.Mesh(new THREE.ConeGeometry(0.05, 1, 10, 1, true), this.jetMat);
    jet.userData.keep = true;                    // its own mesh (additive, scaled per frame), not baked
    jet.geometry.translate(0, -0.5, 0);           // apex at the nozzle, opens along -Y
    jet.rotation.x = 0.34;                       // along (0,-1,-0.35)
    jet.frustumCulled = false; jet.visible = false; jet.raycast = () => {};
    this.nozzle.add(jet); this.jet = jet;

    // collider reference points (cloak sim)
    const mk = (parent: THREE.Object3D, x: number, y: number, z: number): THREE.Object3D => { const o = new THREE.Object3D(); o.position.set(x, y, z); parent.add(o); return o; };
    this.col = [
      { o: mk(chest, 0, 0.24, -0.015), r: 0.165 }, { o: mk(chest, 0, 0.07, -0.03), r: 0.155 },
      { o: mk(gear, 0, -0.02, -0.16), r: 0.12 },
      // the blade boxes (mid and tail; the box groups stay in the hierarchy after the bake)
      ...this.bladeBoxes.flatMap((b) => [{ o: mk(b, 0, 0.04, -0.06), r: 0.085 }, { o: mk(b, 0, 0.035, -0.24), r: 0.08 }]),
      { o: mk(J.legL.hip, 0, -0.17, -0.005), r: 0.1 }, { o: mk(J.legR.hip, 0, -0.17, -0.005), r: 0.1 },
      { o: mk(J.legL.kn, 0, 0.0, -0.005), r: 0.085 }, { o: mk(J.legR.kn, 0, 0.0, -0.005), r: 0.085 },
      { o: mk(pelvis, 0, -0.02, -0.04), r: 0.14 },
    ];
    // cloak pin points (left shoulder → right shoulder across the nape)
    for (let c = 0; c < CC; c++) {
      const x = (0.5 - c / (CC - 1)) * 0.46;
      this.pins.push(mk(chest, x, 0.43 + 0.02 * (1 - Math.pow(x / 0.23, 2)) - 0.012 * Math.abs(x / 0.23), -0.02 - 0.085 * (1 - Math.pow(x / 0.23, 2))));
    }
    J.blades = [J.armL.blade, J.armR.blade];
    this._bake(J);
    this.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.receiveShadow = false; });
  }

  /** Merge every modelling part into the skinned body / blade meshes (see the header). Joint groups stay as they are. */
  _bake(J: Joints): void {
    const bones: THREE.Object3D[] = [this.pivot, J.spine, J.head];
    for (const a of [J.armL, J.armR]) bones.push(a.sh, a.el, a.wr);
    for (const l of [J.legL, J.legR]) bones.push(l.hip, l.kn, l.an);
    const boneIx = new Map(bones.map((b, i) => [b, i]));
    const blades: THREE.Object3D[] = J.blades;
    const body: (BakePart & { owner: THREE.Object3D })[] = [], bladeParts: (BakePart & { owner: THREE.Object3D })[][] = [[], []], meshes: THREE.Mesh[] = [];
    this.root.updateMatrixWorld(true);
    this.root.traverse((o) => { if ((o as THREE.Mesh).isMesh && !o.userData.keep) meshes.push(o as THREE.Mesh); });
    const inv = new THREE.Matrix4();
    for (const m of meshes) {
      let owner = m.parent!;
      while (!boneIx.has(owner) && !blades.includes(owner)) owner = owner.parent!;
      const rel = new THREE.Matrix4().multiplyMatrices(inv.copy(owner.matrixWorld).invert(), m.matrixWorld);
      const bi = blades.indexOf(owner);
      (bi >= 0 ? bladeParts[bi] : body).push({ m, rel, owner, bone: boneIx.get(owner) ?? 0 });
    }
    // non-mesh helpers hanging off a part (the pelvis cloak-collider point) move to the joint, same world transform
    for (const { m, owner } of [...body, ...bladeParts[0], ...bladeParts[1]]) {
      for (const c of [...m.children]) if (!(c as THREE.Mesh).isMesh) owner.attach(c);
    }
    for (const m of meshes) { m.removeFromParent(); m.geometry.dispose(); }
    for (const k in this.mats) this.mats[k].dispose();

    // body: one rigidly skinned mesh driven by the joint groups (identity bind: verts are joint-local)
    const geo = bakeParts(body, true);
    this.skeleton = new THREE.Skeleton(bones as THREE.Bone[], bones.map(() => new THREE.Matrix4()));
    const sm = new THREE.SkinnedMesh(geo, bodyMaterial());
    sm.bind(this.skeleton, new THREE.Matrix4());
    sm.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2.0);    // body-centred bound for culling (any pose)
    sm.castShadow = true;
    this.root.add(sm);
    this.body = sm;
    // blades: one mesh each, inside the blade group (shown / hidden with it); shine = this.bladeMat's flash uniform
    this.bladeMat = grainMaterial({ emissive: true, flash: 0x000000 });
    for (let i = 0; i < 2; i++) {
      const bm = new THREE.Mesh(bakeParts(bladeParts[i], false), this.bladeMat); bm.castShadow = true;
      J.blades[i].add(bm);
    }
  }

  _buildCapeMesh(): void {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(CN * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(CN * 3), 3).setUsage(THREE.DynamicDrawUsage));
    const uv = new Float32Array(CN * 2);
    for (let r = 0; r < CR; r++) for (let c = 0; c < CC; c++) { uv[(r * CC + c) * 2] = c / (CC - 1); uv[(r * CC + c) * 2 + 1] = 1 - r / (CR - 1); }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const idx: number[] = [];
    for (let r = 0; r < CR - 1; r++) for (let c = 0; c < CC - 1; c++) {
      const a = r * CC + c, b = a + 1, cc = a + CC, d = cc + 1;
      idx.push(a, cc, b, b, cc, d);
    }
    g.setIndex(idx);
    this.capeGeo = g;
    const tex = capeTextures();
    const outer = new THREE.MeshStandardMaterial({ map: tex.map, bumpMap: tex.bump, bumpScale: 1.2, roughness: 0.92, side: THREE.FrontSide });
    const inner = new THREE.MeshStandardMaterial({ color: 0x2c4434, bumpMap: tex.bump, bumpScale: 1.2, roughness: 0.95, side: THREE.BackSide });
    // one shadow draw for both faces (before: outer drew its back faces, inner its front faces = the same union)
    outer.shadowSide = THREE.DoubleSide;
    this.capeMat = outer;
    this.capeOuter = new THREE.Mesh(g, outer); this.capeInner = new THREE.Mesh(g, inner);
    for (const m of [this.capeOuter, this.capeInner]) { m.frustumCulled = false; this.root.add(m); }
    this.capeOuter.castShadow = true;
  }

  // The model follows config/character/soldier.json and config/material/soldier-*.json while the game runs: a change
  // marks it, and the next update() builds the body again from the new numbers. The cloak's cloth state is kept.
  _dirty = false;
  _unwatch: (() => void)[] = [];
  _follow(): void {
    const mark = (): void => { this._dirty = true; };
    for (const id of ['character/soldier', ...SOLDIER_MATERIALS.map((m) => `material/soldier-${m}`)]) this._unwatch.push(config.watch(id, mark));
  }
  /** Takes the built body apart and builds it from the current config. Same root, same pivot, same cloak simulation. */
  rebuild(): void {
    this._dirty = false;
    const geos = new Set<THREE.BufferGeometry>();
    this.root.traverse((o) => { const g = (o as THREE.Mesh).geometry; if (g && g !== this.capeGeo) geos.add(g); });
    this.pivot.clear();
    for (const c of [...this.root.children]) if (c !== this.pivot) this.root.remove(c);
    for (const g of geos) g.dispose();
    if (this.skeleton) this.skeleton.dispose();
    if (this.bladeMat) this.bladeMat.dispose();
    this.capeGeo?.dispose();
    this.locks.length = 0; this.bladeBoxes.length = 0; this.pins.length = 0; this.col.length = 0;
    this._construct();
  }

  setVisible(v: boolean): void { this.root.visible = v; }
  dispose(): void {
    for (const u of this._unwatch) u();
    this._unwatch.length = 0;
    this.root.traverse((o) => { const g = (o as THREE.Mesh).geometry; if (g) g.dispose(); });
    if (this.skeleton) this.skeleton.dispose();
    if (this.bladeMat) this.bladeMat.dispose();
  }
  // ───────────────────────────── legs: gait clock + planted feet ─────────────────────────────
  // On the ground each foot is either planted (pinned to one spot on the ground: heel first at a walk or jog, ball
  // first at a sprint, rolling over it and peeling the heel up before toe-off) or swinging to its next foothold.
  // Cadence rises with speed (≈1.9 steps/s walking, 2.7 jogging, ≈5 at an 11 m/s sprint) and the step length is
  // speed / cadence, so a planted foot never slides. The share of the stride a foot is down (duty) falls from 0.62
  // walking to ≈0.22 sprinting, held to what the leg can reach from a heel strike ahead to a toe-off behind.
  // Running, the pelvis dips through each stance and rises through the flight; walking, it vaults over the planted
  // leg. A hard stop or a landing at more than running speed is a skid: the feet brace and plough, the body sits back.
  _gaitClock(dt: number, grounded: boolean, vx: number, vz: number, skidIn: boolean): Gait {
    const G = this.gait || (this.gait = newGait());
    const hv = grounded ? hypot(vx, vz) : 0;
    G.v += (hv - G.v) * (this.first ? 1 : 1 - Math.exp(-14 * dt));
    const v = G.v;
    // longitudinal acceleration (raw speed change, low-passed): leans into a start, sits back into a stop
    G.acc += ((grounded && G.hvPrev >= 0 ? (hv - G.hvPrev) / dt : 0) - G.acc) * (this.first ? 1 : 1 - Math.exp(-12 * dt));
    G.hvPrev = grounded ? hv : -1;
    const braking = grounded && (skidIn || hv > SKID_V || (G.acc < -18 && hv > 1.5));
    const sk = braking ? 1 : 0;
    G.wSkid += (sk - G.wSkid) * (this.first ? 1 : 1 - Math.exp(-(sk > G.wSkid ? 22 : 5) * dt));
    G.runK = sstep(1.9, 3.0, v);
    G.sprint = sstep(5, 10.5, v);
    const x = Math.max(0, v - 3);
    G.cad = lerp(1.45 + 0.32 * Math.min(v, 2.6), 2.65 + 0.14 * x + 0.018 * x * x, G.runK);
    G.step = Math.max(0.25, v / G.cad);
    G.base = 0.012 + 0.022 * G.runK + 0.012 * G.sprint + 0.13 * G.wSkid;
    // contact: heel strike (toes up) walking and jogging, forefoot at a sprint; toe-off further up on the toes
    G.pTD = lerp(lerp(-0.26, -0.14, G.runK), 0.2, G.sprint);
    G.pTO = lerp(0.55, 0.78, G.runK) + 0.25 * G.sprint;
    G.pMid = 0.1 * G.sprint;
    // how far the pelvis can travel over a pinned foot: from the touchdown (foot ahead, leg nearly straight) to the
    // toe-off (foot behind, heel up)
    const hip = HIP_H - G.base;
    ankleOff(G.pTD); const dTD = Math.sqrt(Math.max(0.01, REACH * REACH - (hip - _ao.u) ** 2)) - _ao.f;
    ankleOff(G.pTO); const dTO = Math.sqrt(Math.max(0.01, REACH * REACH - (hip - _ao.u) ** 2)) + _ao.f;
    const duty0 = lerp(0.62 - 0.03 * Math.min(1, v / 2), lerp(0.4, 0.24, sstep(3, 10, v)), G.runK);
    // (walking, the pelvis dips into the double support to reach: the legs' reach only limits the run)
    G.duty = clamp(Math.min(duty0, lerp(duty0, (dTD + dTO - 0.06) / (2 * G.step), G.runK)), 0.15, 0.66);
    G.stance = G.duty * 2 * G.step;
    G.tdShare = dTD / (dTD + dTO);                                       // of the stance, the part ahead of the hips
    const moving = grounded && v > MOVE_V && G.wSkid < 0.5;
    if (moving && !G.moving) {
      // setting off: the foot that is further behind (or the left one) lifts first
      const f0 = G.feet[0], f1 = G.feet[1];
      _v4.set(vx, 0, vz).normalize();
      const lead = G.init && f1.ball.dot(_v4) < f0.ball.dot(_v4) ? 1 : 0;
      G.p = (G.duty + 0.001 - 0.5 * lead + 1) % 1;
    }
    if (G.wSkid > 0.5 && G.skidLead < 0) {
      // bracing: the foot that's further forward (or lands first) digs in ahead
      _v4.set(vx, 0, vz).normalize();
      G.skidLead = G.init && G.feet[1].ball.dot(_v4) > G.feet[0].ball.dot(_v4) ? 1 : 0;
    } else if (G.wSkid < 0.2) G.skidLead = -1;
    G.moving = moving;
    if (moving) G.p = (G.p + dt * G.cad / 2) % 1;
    // arms and the fallback leg cycle: left leg furthest forward (left arm furthest back) at the left touchdown
    this.phase = TAU * G.p + Math.PI / 2;
    return G;
  }

  /** Solve the legs onto their footholds (w = how grounded the pose is: 0 in the air, riding, mounting, held). */
  _legs(dt: number, w: number, vx: number, vz: number): void {
    const G = this.gait, legs = [this.j.legL, this.j.legR], J = this.J;
    if (!G || w < 0.01) { if (G) { G.init = false; G.drop = 0; } return; }
    if (!this.game) return;
    const col = this.game.collision, up = this.up;
    this.root.updateMatrixWorld(true);
    const hd = this.heading;
    const lat = _l1.copy(up).cross(hd).normalize();                        // the soldier's left
    const vel = _lv.set(vx, 0, vz), vl = vel.length();
    const dirM = vl > 0.3 ? _l2.copy(vel).multiplyScalar(1 / vl) : _l2.copy(hd);    // where the body is going
    const v = G.v, runK = G.runK, sprint = G.sprint, skid = G.wSkid;
    const ground = (x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 => {
      _l3.set(x, y + 1.2, z);
      const hit = col.raycast(_l3, _fdown, 3.2, { dynamic: false });
      return out.set(x, hit ? hit.point.y : y, z);
    };
    // first grounded frame: plant each foot under where the pose has it
    if (!G.init) {
      for (let i = 0; i < 2; i++) {
        const f = G.feet[i], an = legs[i].an;
        an.getWorldPosition(f.ankle);
        f.fd.copy(hd);
        f.ball.copy(f.ankle).addScaledVector(hd, FOOT_BALL);
        ground(f.ball.x, f.ball.y, f.ball.z, f.ball);
        f.swing = false; f.timed = false; f.pitch = 0;
      }
      G.init = true; G.drop = 0;
    }
    const pelvis = _l4.copy(this.root.position);
    const cycT = 2 / G.cad;                                              // one stride (two steps)
    // turning: the body will have swung round by the time a foot lands, and the feet land out to the outside of the
    // bend (that's what pushes a runner round it)
    const yr = G.moving ? clamp(this.yawRate, -4, 4) : 0;
    const outward = -Math.sign(yr) * Math.min(0.12, Math.abs(yr) * v * 0.005);
    const bracing = skid > 0.3 && G.skidLead >= 0;
    // where a foot coming down `tAhead` s from now should put its ball: ahead of where the hips will be, out to its side
    const foothold = (i: number, tAhead: number, outBall: THREE.Vector3): THREE.Vector3 => {
      const t = G.moving ? tAhead : 0, turn = yr * t;
      let side = (i ? -1 : 1) * lerp(0.1, 0.06, sstep(1, 8, v)) + outward, ahead: number;
      if (bracing) { ahead = i === G.skidLead ? 0.55 : -0.05; side *= 1.5; }
      else ahead = G.moving ? G.stance * G.tdShare : (i ? 0.09 : 0.15);
      _l6.copy(vel).applyAxisAngle(_up, turn * 0.5);
      _l3.copy(dirM).applyAxisAngle(_up, turn); _l1b.copy(lat).applyAxisAngle(_up, turn);
      outBall.copy(pelvis).addScaledVector(_l6, t).addScaledVector(_l3, ahead).addScaledVector(_l1b, side);
      return ground(outBall.x, pelvis.y - LEG_H, outBall.z, outBall);
    };
    const restPitch = (i: number): number => (bracing && i === G.skidLead ? -0.32 : bracing ? 0.2 : 0);
    const startSwing = (f: Foot, timedDur: number): void => {
      f.swing = true; f.timed = timedDur > 0; f.t = 0; f.dur = timedDur; f.u = 0; f.committed = false;
      f.from.copy(f.ankle); f.fromPitch = f.pitch;
      f.fromRel.subVectors(f.ankle, pelvis);
    };
    const land = (f: Foot): void => {
      f.swing = false; f.timed = false; f.ball.copy(f.toBall); f.fd.copy(f.toFd); f.pitch = f.toPitch;
    };
    for (let i = 0; i < 2; i++) {
      const f = G.feet[i];
      if (G.moving && !f.timed) {
        const psi = (G.p + 0.5 * i) % 1, inStance = psi < G.duty;
        const u = (psi - G.duty) / (1 - G.duty);
        if (f.swing && inStance && f.u > 0.5) land(f);
        else if (!f.swing && !inStance) { startSwing(f, 0); f.u0 = u; }
        f.tSw = (1 - G.duty) * cycT;
        if (f.swing) {
          f.u = clamp((u - f.u0) / Math.max(1e-3, 1 - f.u0), 0, 1); f.tRem = (1 - u) * f.tSw;
          // it lands before the next frame: be on the foothold now (no jump onto it as the stance starts)
          if (f.tRem < dt) { f.u = 1; f.tRem = 0; }
        }
        else {
          // planted: land on the heel (or the ball), roll flat, then the heel peels up through the push-off
          const s = psi / G.duty;
          f.pitch = s < 0.2 ? lerp(f.toPitch, G.pMid, sstep(0, 0.2, s)) : lerp(G.pMid, G.pTO, sstep(lerp(0.5, 0.35, runK), 1, s));
        }
      } else if (f.timed) {
        f.t += dt; f.u = clamp(f.t / f.dur, 0, 1); f.tRem = f.dur - f.t;
        if (f.u >= 1) land(f);
      } else if (f.swing) {
        // stopped mid-stride: finish this step on a short timer
        f.timed = true; f.dur = 0.18 + 0.12 * (1 - f.u); f.t = f.u * f.dur;
      } else f.pitch += (restPitch(i) - f.pitch) * (1 - Math.exp(-12 * dt));
      // skidding, the planted feet plough along with the body
      if (!f.swing && skid > 0.05 && vl > 0.5) { f.ball.addScaledVector(vel, dt * skid); ground(f.ball.x, f.ball.y, f.ball.z, f.ball); }
    }
    // standing (or bracing): a foot left too far from where it belongs steps over
    if (!G.moving && !G.feet[0].swing && !G.feet[1].swing) {
      let worst = -1, we = bracing ? 0.12 : 0.16;
      for (let i = 0; i < 2; i++) {
        const f = G.feet[i];
        foothold(i, 0, _l5);
        const e = hypot(f.ball.x - _l5.x, f.ball.z - _l5.z) + 0.25 * (1 - f.fd.dot(hd));
        if (e > we) { we = e; worst = i; }
      }
      if (worst >= 0) startSwing(G.feet[worst], bracing ? 0.13 : 0.3);
    }
    // targets: ankle positions (planted: from the pinned contact and the foot pitch; swinging: a path to the foothold)
    const liftRun = runK * lerp(0.17, 0.5, sstep(2.5, 10, v)), skew = lerp(0.85, 0.5, sprint);
    for (let i = 0; i < 2; i++) {
      const f = G.feet[i];
      if (f.swing) {
        // the foothold tracks the body until late in the swing, then it's committed (no chasing at touchdown)
        if (f.timed || !f.committed) {
          foothold(i, f.tRem, f.toBall);
          f.toFd.copy(hd).applyAxisAngle(_up, yr * f.tRem).lerp(dirM, 0.3).normalize();
          f.toPitch = f.timed ? restPitch(i) : G.pTD;
          if (!f.timed && f.u > 0.72) f.committed = true;
        }
        ankleFromContact(f.toBall, f.toFd, f.toPitch, up, f.to);
        // the world path: lift-off spot to foothold over a low arc (both ends at rest on the ground: no skid)
        const e = sstep(0, 1, f.u);
        f.ankle.lerpVectors(f.from, f.to, e).addScaledVector(up, (f.timed ? 0.07 : lerp(0.09, 0.03, runK)) * Math.sin(Math.PI * f.u));
        if (!f.timed && runK > 0) {
          // running, the foot moves relative to the hips instead: it carries on back and up as it leaves the ground
          // (the heel folding up under the seat), the knee drives it through under the hips, it reaches a touch past
          // the foothold and paws back onto it. Hermite along the line of travel, the hips' own path as the frame.
          const tdx = _l3.copy(f.to).sub(pelvis).addScaledVector(vel, -f.tRem);     // foothold, from the hips at touchdown
          const x0 = f.fromRel.dot(dirM), x1 = tdx.dot(dirM), z0 = f.fromRel.dot(lat), z1 = tdx.dot(lat);
          // tangents (m per unit swing): leaving, still travelling back at a third of the ground speed; landing, pawing back at
          // two thirds of it (the foot comes down steeply, almost at rest on the ground)
          const m0 = lerp(Math.max(-0.7, -0.3 * v * f.tSw), 0.1, sprint), m1 = Math.max(-2.6, -0.65 * v * f.tSw);
          const u = f.u, u2 = u * u, u3 = u2 * u;
          const xr = (2 * u3 - 3 * u2 + 1) * x0 + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * x1 + (u3 - u2) * m1;
          const zr = lerp(z0, z1, e);
          const yr2 = lerp(f.from.dot(up), f.to.dot(up), e) + liftRun * Math.sin(Math.PI * Math.pow(u, skew));
          _l6.copy(pelvis).addScaledVector(dirM, xr).addScaledVector(lat, zr);
          _l6.addScaledVector(up, yr2 - _l6.dot(up));
          f.ankle.lerp(_l6, runK * sstep(0, 0.18, u));
        }
        // toes: pointing down off the push, hanging through the recovery, set for the touchdown at the end
        f.pitch = lerp(f.fromPitch, f.toPitch, sstep(0.25, 0.9, f.u)) + (f.timed ? 0 : 0.35 * runK * Math.sin(Math.PI * f.u));
      } else {
        ankleFromContact(f.ball, f.fd, f.pitch, up, f.ankle);
      }
    }
    // never the splits: each foot stays in a natural band out to its own side of the hips. Sliding sideways (a fast
    // landing at an angle, a rope tugging you across the grass) the footholds run off to the side of the body; past
    // the band the foot skids along with you instead of being left behind
    for (let i = 0; i < 2; i++) {
      const f = G.feet[i], sgn = i ? -1 : 1;
      const off = _l5.subVectors(f.ankle, pelvis).dot(lat) * sgn;
      const c = clamp(off, -0.04, bracing ? 0.32 : 0.26);
      if (c !== off) {
        f.ankle.addScaledVector(lat, (c - off) * sgn);
        if (!f.swing) f.ball.addScaledVector(lat, (c - off) * sgn);
      }
    }
    // pelvis height: lower the faster you go (and right down into a skid), bobbing with the stride; never higher
    // than the planted feet can reach
    let reachNeed = 0;
    for (let i = 0; i < 2; i++) {
      const f = G.feet[i];
      if (f.swing && f.u < 0.9) continue;
      legs[i].hip.getWorldPosition(_l5);
      _l3.subVectors(f.ankle, _l5);
      const vert = -_l3.dot(up), horiz = Math.sqrt(Math.max(0, _l3.lengthSq() - vert * vert));
      const h2 = Math.min(horiz, LEG_REACH * 0.97);
      reachNeed = Math.max(reachNeed, vert - Math.sqrt(LEG_REACH * LEG_REACH - h2 * h2));
    }
    reachNeed = Math.min(reachNeed, 0.32);
    let bob = 0;
    if (G.moving) {
      const q = (2 * G.p) % 1, d2 = Math.min(0.95, 2 * G.duty);
      const run = q < d2 ? -lerp(0.045, 0.03, sprint) * Math.sin(Math.PI * q / d2) : lerp(0.028, 0.02, sprint) * Math.sin(Math.PI * (q - d2) / (1 - d2));
      const walk = 0.022 * sstep(0.3, 1.2, v) * Math.cos(TAU * (q - G.duty));
      bob = lerp(walk, run, runK) * (1 - skid);
    }
    const need = Math.max(G.base, reachNeed);
    G.drop = need > G.drop ? need : G.drop + (need - G.drop) * (1 - Math.exp(-10 * dt));
    this.pivot.position.y -= Math.max(G.drop - bob, reachNeed) * w;
    this.root.updateMatrixWorld(true);
    // solve each leg: hip flexion + abduction, knee, then the ankle to the wanted foot pitch
    for (let i = 0; i < 2; i++) {
      const f = G.feet[i], L = legs[i], o = i * 4;
      solveLeg(L, this.pivot, f.ankle);
      const hx = lerp(L.hip.rotation.x, _sol.hx, w), hz = lerp(L.hip.rotation.z, _sol.hz, w);
      const kx = lerp(L.kn.rotation.x, _sol.kx, w);
      L.hip.rotation.set(hx, 0, hz); L.kn.rotation.set(kx, 0, 0);
      L.hip.updateMatrixWorld(true);
      // the foot keeps its foothold's heading (it doesn't turn with the body while planted), toe-down by its pitch
      footQuatLocal(L.kn, f.swing ? hd : f.fd, f.pitch, up, _lq);
      L.an.quaternion.slerp(_lq, w);
      const ax = L.an.rotation.x;
      // the damped channels carry on from here when the feet leave the ground
      J[LHX + o] = hx; J[LHZ + o] = i ? -hz : hz; J[LKX + o] = kx; J[LAX + o] = ax;
    }
  }
  /** World position of the signal gun's muzzle. */
  flareMuzzlePos(out: THREE.Vector3): THREE.Vector3 { this.flareMuzzle.updateWorldMatrix(true, false); return out.setFromMatrixPosition(this.flareMuzzle.matrixWorld); }

  hookOrigin(side: number, out: THREE.Vector3): THREE.Vector3 {
    const tip = side === 0 ? this.launcherL : this.launcherR;
    tip.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(tip.matrixWorld);
  }

  gasNozzle(outPos: THREE.Vector3, outDir: THREE.Vector3): void {
    this.nozzle.updateWorldMatrix(true, false);
    outPos.setFromMatrixPosition(this.nozzle.matrixWorld);
    outDir.set(0, -1, -0.35).normalize().transformDirection(this.nozzle.matrixWorld);
  }

  // ───────────────────────────── per-frame ─────────────────────────────
  update(dt: number, s: ModelState): void {
    if (this._dirty) this.rebuild();
    dt = clamp(finite(dt), 0, 0.05);
    if (dt <= 0) dt = 1e-4;
    this.time += dt;
    const k = (rate: number): number => 1 - Math.exp(-rate * dt);
    const t = this.time;
    const first = this.first;

    // ── sanitise input
    const p = s.position, v = s.velocity;
    _v1.set(finite(p.x), finite(p.y), finite(p.z));
    const vx = finite(v && v.x), vy = finite(v && v.y), vz = finite(v && v.z);
    let speed = hypot(vx, vy, vz);
    if (typeof s.speed === 'number' && Number.isFinite(s.speed)) speed = s.speed;
    this.root.position.copy(_v1);
    this.pos.copy(_v1);
    const grounded = !!s.grounded;
    const running = clamp(finite(s.running), 0, 1);

    // ── weights (exponential smoothing; never snap)
    this.wAir += ((grounded ? 0 : 1) - this.wAir) * (first ? 1 : k(11));
    this.wSpin += ((s.spin ? 1 : 0) - this.wSpin) * (first ? 1 : k(14));
    this.wGrab += ((s.grabbed ? 1 : 0) - this.wGrab) * (first ? 1 : k(9));
    this.wBoost += (clamp(finite(s.boosting), 0, 1) - this.wBoost) * (first ? 1 : k(14));
    this.wRun += (running - this.wRun) * (first ? 1 : k(10));
    this.wRide += (clamp(finite(s.riding), 0, 1) - this.wRide) * (first ? 1 : k(7));
    this.wCrouch += (clamp(finite(s.crouch), 0, 1) - this.wCrouch) * (first ? 1 : k(this.wCrouch < finite(s.crouch) ? 30 : 8));
    const sl = finite(s.slash ?? -1), slashing = s.slash !== undefined && sl >= 0 && sl <= 1.0001;
    if (slashing) this.slashP = sl;
    this.wSlash += ((slashing ? 1 : 0) - this.wSlash) * (first ? 1 : k(slashing ? 32 : 11));
    // hooks
    let nHook = 0; _v2.set(0, 0, 0);
    const hooks = s.hooks;
    if (hooks) for (let i = 0; i < 2; i++) {
      const h = hooks[i];
      if (h && h.attached && h.anchor) { nHook++; _v2.add(h.anchor); }
    }
    this.wHook += ((nHook > 0 ? 1 : 0) - this.wHook) * (first ? 1 : k(7));
    const hasBlades = s.blades !== false;
    this.speedS += (speed - this.speedS) * (first ? 1 : k(6));
    const L = sstep(5, 24, this.speedS);                       // flight-lean amount from speed
    const airFlight = this.wAir * L;

    // ── up and forward vectors
    _v3.set(finite(s.up && s.up.x), finite(s.up && s.up.y) || 1, finite(s.up && s.up.z)).normalize();
    if (first) this.up.copy(_v3); else this.up.lerp(_v3, k(12)).normalize();
    const up = this.up;
    _v3.set(finite(s.forward && s.forward.x), finite(s.forward && s.forward.y), finite(s.forward && s.forward.z));
    if (_v3.lengthSq() < 1e-6) _v3.copy(this.fwd);
    _v3.normalize();
    if (first) this.fwd.copy(_v3); else this.fwd.lerp(_v3, k(this.wAir > 0.5 ? 9 : 40)).normalize();
    const fwd = this.fwd;
    const sinE = clamp(fwd.dot(up), -1, 1);
    let eF = Math.asin(sinE);
    // lean towards the anchors when hooked
    let eA = 0, leftness = 0;
    _v4.copy(up).cross(this.heading);                         // soldier's LEFT
    if (nHook > 0) {
      _v2.multiplyScalar(1 / nHook).sub(this.pos);
      const dl = _v2.length();
      if (dl > 0.5) {
        _v2.multiplyScalar(1 / dl);
        eA = Math.asin(clamp(_v2.dot(up), -1, 1));
        leftness = clamp(_v2.dot(_v4), -1, 1);
      }
    }
    const hk = this.wHook * 0.5;
    const eEff = eF * (1 - hk) + eA * hk;

    // ── heading (horizontal facing) with yaw smoothing
    _v2.copy(fwd).addScaledVector(up, -sinE);
    const hl = _v2.length();
    if (hl > 0.12) {
      _v2.multiplyScalar(1 / hl);
      if (first) this.heading.copy(_v2); else this.heading.lerp(_v2, k(this.wAir > 0.5 ? 16 : 40)).normalize();
    }
    this.heading.addScaledVector(up, -this.heading.dot(up)).normalize();
    // yaw rate (for banking into turns)
    _v2.copy(this.heading).cross(this._prevHeading);
    const yr = clamp(-_v2.dot(up) / dt, -8, 8);
    this.yawRate += (finite(yr) - this.yawRate) * k(8);
    this._prevHeading.copy(this.heading);

    // ── the ground gait clock (cadence, duty, phase; see _gaitClock): it drives the lean, the pelvis and the arms
    const G = this._gaitClock(dt, grounded, vx, vz, !!s.skid);
    // ── body pitch (theta) and bank. Running, the body leans forward more the faster it goes, into a start, and
    // sits back into a stop or a skid
    const thetaG = 0.04 + 0.07 * G.runK + 0.15 * G.sprint + clamp(G.acc * 0.006, -0.12, 0.18) - 0.38 * G.wSkid;
    const thetaFlight = Math.PI / 2 - clamp(eEff * 0.92, -0.85, 1.25);
    const thetaFall = 0.18 + 0.1 * Math.sin(t * 2.1);
    const thetaAir = lerp(thetaFall, thetaFlight, L);
    let theta = lerp(thetaG, thetaAir, this.wAir);
    theta = lerp(theta, Math.PI / 2 + 0.0, this.wSpin * this.wAir);   // spin: axis = body axis, body horizontal-ish
    theta = lerp(theta, 0.05, this.wGrab);
    // about to touch down: the body comes upright (feet first), whatever the dive angle
    this.wLand += (clamp(finite(s.landPrep), 0, 1) - this.wLand) * (first ? 1 : k(16));
    theta = lerp(theta, 0.12, this.wLand * this.wAir);
    // dropping onto a horse / climbing on: upright, seat first
    theta = lerp(theta, 0.1, Math.max(clamp(finite(s.straddle), 0, 1), s.mount && s.mount.k < 1 ? 1 : 0));
    if (first) this.theta = theta; else this.theta += (theta - this.theta) * k(8.5);
    let roll = -0.55 * leftness * this.wHook + clamp(-this.yawRate * 0.09, -0.5, 0.5) * airFlight + 0.05 * Math.sin(t * 1.7) * this.wAir;
    // running round a bend: lean into it (feet out, body in)
    roll += clamp(-this.yawRate * this.speedS * 0.011, -0.28, 0.28) * (1 - this.wAir) * this.wRun;
    roll *= 1 - this.wSpin;
    if (first) this.roll = roll; else this.roll += (roll - this.roll) * k(7);
    const flightish = clamp(this.theta / 1.15, 0, 1);

    // ── spin angle: continue to a full turn when released, then rest at 0
    if (s.spin) this.spinAngle += TAU * 3 * dt;
    else if (this.spinAngle > 1e-3) {
      const target = Math.ceil(this.spinAngle / TAU - 1e-4) * TAU;
      this.spinAngle += Math.max((target - this.spinAngle) * k(9), 0) + TAU * 0.8 * dt * (target - this.spinAngle > 0.05 ? 1 : 0);
      if (this.spinAngle >= target - 0.02) this.spinAngle = 0;
    }

    // ── orientation: heading frame * lean(Z) * pitch(X) * roll(Y), spin about the velocity axis in world space
    _v2.copy(up).cross(this.heading);                         // frame X (left)
    _m1.makeBasis(_v2, up, this.heading);
    this.q.setFromRotationMatrix(_m1);
    _q1.setFromAxisAngle(AZ, this.roll * (1 - flightish));
    _q2.setFromAxisAngle(AX, this.theta);
    _q3.setFromAxisAngle(AY, this.roll * flightish);
    this.q.multiply(_q1).multiply(_q2).multiply(_q3);
    // the pelvis turns with the stride (the forward leg's hip comes forward); the shoulders counter-rotate (below)
    const mv = sstep(0.2, 1.2, G.v), wCyc = (1 - this.wAir) * (1 - this.wRide) * (1 - this.wGrab) * (1 - this.wSpin) * (s.mount && s.mount.k < 1 ? 0 : 1);
    const pelvisYaw = -(0.05 + 0.06 * G.runK + 0.03 * G.sprint) * mv * Math.sin(this.phase) * wCyc * (1 - G.wSkid);
    if (Math.abs(pelvisYaw) > 1e-5) this.q.multiply(_q1.setFromAxisAngle(AY, pelvisYaw));
    if (this.spinAngle > 1e-4) {
      _q1.setFromAxisAngle(fwd, this.spinAngle);
      this.q.premultiply(_q1);
    }
    this.pivot.quaternion.copy(this.q);

    // ── poses ──────────────────────────────────────────────────────────
    const TG = this.TG, TA = this.TA, TS = this.TS, TP = this.TP, TR = this.TR, TC = this.TC, J = this.J;
    TG.fill(0); TA.fill(0);
    // ground: idle / walk / run. Static parts of the pose go into TG (smoothed with the other poses); the parts that
    // swing with the stride go into TO and are added after the smoothing, so they stay locked to the legs (a low-pass
    // on a 2.5 Hz arm swing shrinks it by half and drags it a quarter-cycle behind the legs)
    const ph = this.phase, ra = this.wRun, rk = G.runK, spr = G.sprint, sk = G.wSkid, sn = Math.sin(ph);
    const br = Math.sin(t * 2.2) * (1 - mv);
    TG[SPX] = 0.02 + 0.02 * br + 0.04 * rk + 0.05 * spr + 0.12 * sk; TG[SPY] = 0; TG[SPZ] = 0;
    TG[HDX] = -0.04 + 0.02 * br - 0.6 * (thetaG - 0.04);             // the gaze stays level as the body leans
    const TO = this.TO; TO.fill(0);
    const armA = mv * (0.2 + 0.15 * rk + 0.12 * spr) * (1 - sk);    // shoulder swing amplitude
    const twist = (0.06 * mv + 0.08 * rk) * (1 - sk);
    TO[SPY] = twist * sn - pelvisYaw;                                 // shoulders: their own twist, undoing the pelvis'
    TO[HDY] = -twist * sn * 0.85;                                     // the head keeps looking where you're going
    for (let sd = 0; sd < 2; sd++) {
      const ph2 = ph + sd * Math.PI, s2 = Math.sin(ph2), c2 = Math.cos(ph2);
      const o = sd * 4, oa = sd * 5, sg = sd === 0 ? 1 : -1;
      // fallback leg cycle (only shows when the feet aren't solved onto the ground)
      TG[LHX + o] = -0.95 * ra * s2 + 0.02; TG[LHZ + o] = 0.045 + 0.02 * ra;
      TG[LKX + o] = 0.36 * ra + 0.08 + ra * 1.1 * Math.max(0, c2) * (0.4 + 0.6 * Math.max(0, -s2 + 0.9));
      TG[LAX + o] = -0.25 * ra * Math.max(0, c2) + 0.1 * ra * Math.max(0, -c2) + 0.04;
      // arms: held a little back (blades trailing), elbows bent to ~90° running; braking, thrown forward for balance
      TG[LSX + oa] = 0.06 * mv + 0.3 * rk - 0.05 + 0.03 * br * sg - 0.55 * sk;
      TG[LSZ + oa] = 0.1 + 0.06 * rk + 0.35 * sk; TG[LSY + oa] = 0;
      TG[LEX + oa] = lerp(0.3, 0.8, rk) + 0.15 * spr - 0.4 * sk;
      TG[LWX + oa] = 1.2;
      // swing against the legs: the left arm back as the left leg comes through. The elbow opens as the arm comes
      // forward (the hand reaches down and forward, so the wrist can still hold the blade trailing behind)
      TO[LSX + oa] = sg * armA * sn;
      TO[LEX + oa] = sg * 0.2 * rk * sn * (1 - sk);
      TO[LSY + oa] = -sg * 0.08 * rk * sn;                           // the hands cross a little in front
    }
    TG[BOB] = 0;                     // on the ground the pelvis height comes from the legs (_legs)
    // air: flight / swing / fall
    const hookBend = 0.14 + 0.38 * this.wHook;
    const wob = Math.sin(t * 3.1), wob2 = Math.sin(t * 2.3 + 1);
    // fall pose (slow): arms out, legs apart
    const fa = 1 - L;
    TA[SPX] = lerp(0.0, -0.12 - 0.05 * this.wBoost, L); TA[SPY] = 0.05 * wob * L; TA[SPZ] = 0;
    TA[HDX] = 0;
    for (let sd = 0; sd < 2; sd++) {
      const sgn = sd === 0 ? 1 : -1, oa = sd * 5, o = sd * 4;
      const asym = (sd === 0 ? wob : wob2);
      TA[LSX + oa] = lerp(-0.45, 0.16 + 0.1 * this.wBoost, L) + 0.05 * asym * L;
      TA[LSZ + oa] = lerp(0.95, 0.13 + 0.06 * asym, L);
      TA[LEX + oa] = lerp(0.35, 0.26, L);
      TA[LWX + oa] = TA[LEX + oa] + lerp(0.1, 0.16, L);
      const tuck = sd === 0 ? 1 : 0.2;   // in flight: one knee drawn up, the other leg trailing
      TA[LHX + o] = lerp(-0.18 * sgn, 0.07 - 0.42 * tuck * (0.6 + 0.4 * this.wHook) + 0.05 * asym, L) * 1; TA[LHZ + o] = lerp(0.22, 0.045, L);
      TA[LKX + o] = lerp(0.4, hookBend + 0.75 * tuck + 0.04 * asym, L);
      TA[LAX + o] = lerp(0.1, 0.8, L);
    }
    // grabbed: struggling
    TR.fill(0);
    {
      const f = 13;
      TR[SPX] = 0.12 * Math.sin(t * f); TR[SPY] = 0.35 * Math.sin(t * 9.3); TR[SPZ] = 0.22 * Math.sin(t * 7.1); TR[HDX] = 0.2 * Math.sin(t * 11); TR[HDY] = 0.5 * Math.sin(t * 8);
      for (let sd = 0; sd < 2; sd++) {
        const ph3 = t * f + sd * 2.1, oa = sd * 5, o = sd * 4;
        TR[LSX + oa] = -2.5 + 0.5 * Math.sin(ph3); TR[LSZ + oa] = 0.45 + 0.35 * Math.sin(ph3 * 0.8 + 1);
        TR[LEX + oa] = 0.6 + 0.5 * Math.sin(ph3 * 1.1); TR[LWX + oa] = 0.4;
        TR[LHX + o] = -0.5 * Math.sin(ph3 + 1); TR[LHZ + o] = 0.15 + 0.12 * Math.sin(ph3);
        TR[LKX + o] = 0.7 + 0.6 * Math.sin(ph3 + 1.7); TR[LAX + o] = 0.3;
      }
      TR[BOB] = 0.03 * Math.sin(t * 17);
    }
    // base mixes (about to touch down: the air pose gives way to a braced, feet-first stance)
    const wAirPose = this.wAir * (1 - 0.85 * this.wLand);
    for (let i = 0; i < NCH; i++) TC[i] = lerp(TG[i], TA[i], wAirPose);
    if (this.wLand > 0.01) {
      const L2 = this.wLand * this.wAir;
      TC[SPX] += 0.18 * L2; TC[BOB] += 0;
      for (let sd = 0; sd < 2; sd++) {
        const o = sd * 4, oa = sd * 5;
        TC[LHX + o] -= 0.45 * L2; TC[LKX + o] += 0.75 * L2; TC[LAX + o] -= 0.25 * L2;
        TC[LSZ + oa] += 0.55 * L2; TC[LSX + oa] -= 0.2 * L2;
      }
    }
    // crouch: the knees take a landing (or load a jump); hips back, chest forward, pelvis drops, feet stay planted
    const cr = this.wCrouch * (1 - this.wAir);
    if (cr > 0.001) {
      TC[SPX] += 0.5 * cr; TC[HDX] -= 0.35 * cr; TC[BOB] -= 0.36 * cr;
      for (let sd = 0; sd < 2; sd++) {
        const o = sd * 4, oa = sd * 5;
        TC[LHX + o] -= 1.0 * cr; TC[LKX + o] += 1.75 * cr; TC[LAX + o] -= 0.75 * cr; TC[LHZ + o] += 0.08 * cr;
        TC[LSX + oa] -= 0.45 * cr; TC[LSZ + oa] += 0.25 * cr; TC[LEX + oa] += 0.3 * cr;
      }
    }
    // riding: seated in the saddle, thighs round the barrel, hands on the reins, swaying with the gallop
    const rd = this.wRide;
    if (rd > 0.001) {
      const hg = clamp(finite(s.horseGallop), 0, 1), hp = finite(s.horsePhase) * TAU;
      const sway = Math.sin(hp + 0.6) * (0.06 + 0.1 * hg);
      for (let i = 0; i < NCH; i++) {
        let v;
        switch (i) {
          case SPX: v = 0.12 + 0.18 * hg + sway; break;
          case SPY: case SPZ: v = 0; break;
          case HDX: v = -0.1 - 0.12 * hg - sway * 0.6; break;
          case LSX: case RSX: v = -0.6 - 0.15 * hg; break;
          case LSZ: case RSZ: v = 0.12; break;
          case LEX: case REX: v = 1.15 + 0.15 * Math.sin(hp); break;
          case LWX: case RWX: v = 0.35; break;
          case LHX: case RHX: v = -1.42; break;
          case LHZ: case RHZ: v = 0.58; break;
          case LKX: case RKX: v = 1.6 + 0.1 * hg * Math.sin(hp); break;
          case LAX: case RAX: v = -0.3; break;
          case BOB: v = 0; break;
          default: v = TC[i];
        }
        TC[i] = lerp(TC[i], v, rd);
      }
    }
    // falling toward a horse's back: legs open to straddle it, arms out for balance
    const sd0 = clamp(finite(s.straddle), 0, 1) * this.wAir;
    if (sd0 > 0.001) {
      for (let sd = 0; sd < 2; sd++) {
        const o = sd * 4, oa = sd * 5;
        TC[LHX + o] = lerp(TC[LHX + o], -0.9, sd0); TC[LHZ + o] = lerp(TC[LHZ + o], 0.8, sd0); TC[LKX + o] = lerp(TC[LKX + o], 1.1, sd0); TC[LAX + o] = lerp(TC[LAX + o], -0.2, sd0);
        TC[LSX + oa] = lerp(TC[LSX + oa], -1.0, sd0); TC[LSZ + oa] = lerp(TC[LSZ + oa], 0.6, sd0); TC[LEX + oa] = lerp(TC[LEX + oa], 0.3, sd0);
      }
      TC[SPX] = lerp(TC[SPX], 0.2, sd0);
    }
    // getting on: a keyed sequence overrides everything else (the joints track it fast, see `mounting` below)
    const M = s.mount;
    const mounting = !!(M && M.k >= 0 && M.k < 1);
    if (mounting) {
      const K = M.kind === 'air' ? MOUNT.air : MOUNT.run, q = clamp(M.k, 0, 1);
      const R = (M.side || 1) > 0;                 // the horse is on our right: the right leg goes over
      const oL = R ? 4 : 0, pL = R ? 0 : 4, nA = R ? 5 : 0, fA = R ? 0 : 5;
      TC[SPX] = k5(q, K.SPX); TC[SPY] = 0; TC[SPZ] = k5(q, K.SPZ) * (R ? -1 : 1); TC[HDX] = k5(q, K.HDX); TC[HDY] = 0; TC[BOB] = k5(q, K.BOB);
      TC[LHX + oL] = k5(q, K.oHX); TC[LHZ + oL] = k5(q, K.oHZ); TC[LKX + oL] = k5(q, K.oKX); TC[LAX + oL] = k5(q, K.oAX);
      TC[LHX + pL] = k5(q, K.pHX); TC[LHZ + pL] = k5(q, K.pHZ); TC[LKX + pL] = k5(q, K.pKX); TC[LAX + pL] = k5(q, K.pAX);
      TC[LSX + nA] = k5(q, K.nSX); TC[LSZ + nA] = k5(q, K.nSZ); TC[LEX + nA] = k5(q, K.nEX); TC[LWX + nA] = 0.3; TC[LSY + nA] = 0;
      TC[LSX + fA] = k5(q, K.fSX); TC[LSZ + fA] = k5(q, K.fSZ); TC[LEX + fA] = k5(q, K.fEX); TC[LWX + fA] = 0.3; TC[LSY + fA] = 0;
      this.wRide = Math.max(this.wRide, sstep(0.6, 1, q));   // hand over to the seated pose without a pop
    }
    // spin pose: arms out wide, blades forward, legs together
    TP.set(TC);
    TP[SPX] = -0.05; TP[SPY] = 0; TP[SPZ] = 0;
    for (let sd = 0; sd < 2; sd++) {
      const oa = sd * 5, o = sd * 4;
      TP[LSX + oa] = -(Math.PI / 2 + this.theta) * 0.92 + 0.0;   // world pitch ≈ forward
      TP[LSZ + oa] = 1.05; TP[LEX + oa] = 0.05; TP[LWX + oa] = 0.0;
      TP[LHX + o] = 0.04; TP[LHZ + o] = 0.04; TP[LKX + o] = 0.25; TP[LAX + o] = 0.7;
    }
    for (let i = 0; i < NCH; i++) TC[i] = lerp(TC[i], TP[i], this.wSpin);
    // slash overlay (arms + torso): windup → fast cross-body sweep → follow-through
    TS.set(TC);
    {
      const pp = clamp(this.slashP, 0, 1);
      const th = this.theta + TC[SPX];
      for (let sd = 0; sd < 2; sd++) {
        const oa = sd * 5;
        const q = clamp(pp - 0.05 * sd, 0, 1);                      // the left blade lags a hair
        TS[LSX + oa] = kf(q, 0.15, 1.05, -1.9, -1.2) - th;           // arm pitch in the world frame → body frame
        TS[LSZ + oa] = kf(q, 0.25, 0.85, -0.2 - 0.3 * sd, 0.2);     // outward on windup, across the body on the cut
        TS[LEX + oa] = kf(q, 0.5, 1.3, 0.1, 0.4);
        TS[LWX + oa] = 0.0;
        TS[LSY + oa] = 0;
      }
      const tw = kf(pp, 0, 0.55, -0.5, -0.15);
      TS[SPY] = tw; TS[SPX] = TC[SPX] + 0.25 * sstep(0.2, 0.5, pp) * (1 - sstep(0.7, 1, pp));
      TS[SPZ] = -0.2 * tw;
      TS[HDY] = -tw * 0.5;
    }
    for (let i = 0; i < NCH; i++) TC[i] = lerp(TC[i], TS[i], this.wSlash);
    for (let i = 0; i < NCH; i++) TC[i] = lerp(TC[i], TR[i], this.wGrab);
    // a smoke round: the right arm comes straight up over the head with the signal gun
    this.wFlare += (clamp(finite(s.flare), 0, 1) - this.wFlare) * (first ? 1 : k(12));
    if (this.wFlare > 0.001) {
      const wf = this.wFlare * (1 - this.wGrab), th = this.theta + TC[SPX];
      TC[RSX] = lerp(TC[RSX], -2.8 - th, wf); TC[RSZ] = lerp(TC[RSZ], 0.22, wf); TC[RSY] = lerp(TC[RSY], 0, wf);
      TC[REX] = lerp(TC[REX], 0.12, wf); TC[RWX] = lerp(TC[RWX], 0.1, wf); TC[HDX] -= 0.35 * wf;
    }
    // blade swap: the blades just vanished (player.swapT running) → both hands drop to the box mouths, lock the hilts
    // onto fresh blades, and draw them forward; only for the first moments, so bladeless soldiers aren't stuck there
    this.noBladeT = hasBlades ? 0 : this.noBladeT + dt;
    const wSw = hasBlades || first ? 0 : sstep(0, 0.1, this.noBladeT) * (1 - sstep(0.6, 0.8, this.noBladeT)) * (1 - this.wRide) * (1 - this.wGrab) * (1 - this.wSpin);
    if (wSw > 0.001) {
      const pull = sstep(0.25, 0.5, this.noBladeT);
      for (const oa of [0, RSX - LSX]) {
        TC[LSX + oa] = lerp(TC[LSX + oa], lerp(-0.15, -0.55, pull), wSw);
        TC[LSZ + oa] = lerp(TC[LSZ + oa], 0.22, wSw); TC[LSY + oa] = lerp(TC[LSY + oa], 0, wSw);
        TC[LEX + oa] = lerp(TC[LEX + oa], lerp(0.25, 0.5, pull), wSw); TC[LWX + oa] = lerp(TC[LWX + oa], lerp(0.2, 1.1, pull), wSw);
      }
    }
    // head compensation: keep the gaze along `forward` (neck takes up the body pitch)
    const thTot = this.theta + J[SPX];
    const gazeE = lerp(eF, 0, this.wGrab);
    if (!mounting) TC[HDX] += clamp(-gazeE * 0.95 - thTot + 0.12, -1.15, 0.6) * (this.wAir > 0.01 || thTot > 0.3 ? 1 : 0.0);
    if (this.wSpin > 0.01) TC[HDX] = lerp(TC[HDX], clamp(-thTot + 0.05, -1.1, 0.4), this.wSpin);

    // planted feet (solved after the pose is applied): on the ground, not mounting, not held
    const ikW = (mounting ? 0 : 1) * (1 - this.wAir) * (1 - this.wRide) * (1 - this.wGrab) * (s.footIK === false || !this.game?.collision ? 0 : 1);
    // ── damped joint values
    const fast = 11 + 26 * this.wSlash;
    for (let i = 0; i < NCH; i++) {
      const isArm = i >= SPX && i <= RWX && i !== HDX && i !== HDY;
      const rate = first ? 1e3 : mounting ? 30 : (isArm ? fast : 11 + 5 * this.wGrab);
      J[i] += (finite(TC[i]) - J[i]) * (1 - Math.exp(-rate * dt));
    }
    // ── the stride-locked swing on top (see TO), then the wrists: running, each blade is held at one angle in the
    // world, trailing back and low, however the arm swings (a fixed wrist would flail the tips up and down)
    const JF = this.JF;
    JF.set(J);
    const wArm = wCyc * (1 - this.wSlash) * (1 - wSw), wArmR = wArm * (1 - this.wFlare);
    JF[SPY] += TO[SPY] * wArm; JF[HDY] += TO[HDY] * wArm;
    for (let sd = 0; sd < 2; sd++) {
      const oa = sd * 5, wa = sd ? wArmR : wArm;
      if (wa < 1e-3) continue;
      JF[LSX + oa] += TO[LSX + oa] * wa; JF[LEX + oa] += TO[LEX + oa] * wa; JF[LSY + oa] += TO[LSY + oa] * wa;
      // (as far as a wrist bends: with the arm forward the blade drops a little, trailing lower)
      const aim = lerp(1.1, 1.2, rk) + 0.1 * spr - 0.4 * G.wSkid;
      const comp = aim - (this.theta + JF[SPX] + JF[LSX + oa] - JF[LEX + oa]);
      JF[LWX + oa] = lerp(JF[LWX + oa], clamp(comp, -0.5, 1.7), wa);
    }
    // ── apply
    const jt = this.j;
    jt.spine.rotation.set(JF[SPX], JF[SPY], JF[SPZ]);
    jt.head.rotation.set(JF[HDX], JF[HDY], 0);
    {
      const wind = clamp(this.speedS / 40, 0, 1);
      for (let i = 0; i < this.locks.length; i++) {
        const l = this.locks[i];
        l.rotation.x = -0.12 * wind + Math.sin(t * (9 + i * 1.7) + i) * (0.03 + 0.12 * wind);
        l.rotation.z = Math.sin(t * (7 + i) + i * 2) * 0.06 * wind;
      }
    }
    jt.armL.sh.rotation.set(JF[LSX], JF[LSY], JF[LSZ]); jt.armR.sh.rotation.set(JF[RSX], -JF[RSY], -JF[RSZ]);
    jt.armL.el.rotation.set(-JF[LEX], 0, 0); jt.armR.el.rotation.set(-JF[REX], 0, 0);
    jt.armL.wr.rotation.set(JF[LWX], 0, 0); jt.armR.wr.rotation.set(JF[RWX], 0, 0);
    jt.legL.hip.rotation.set(J[LHX], 0, J[LHZ]); jt.legR.hip.rotation.set(J[RHX], 0, -J[RHZ]);
    jt.legL.kn.rotation.set(J[LKX], 0, 0); jt.legR.kn.rotation.set(J[RKX], 0, 0);
    jt.legL.an.rotation.set(J[LAX], 0, 0); jt.legR.an.rotation.set(J[RAX], 0, 0);
    this.pivot.position.y = J[BOB] * (1 - this.wAir);
    this._legs(dt, ikW, vx, vz);
    // blades only when drawn; at rest and running they splay out from the body (tips out wide, not down the legs)
    const splay = lerp(0.38, 0.22, G.runK * mv) * (1 - this.wSlash) * (1 - this.wSpin) * (1 - this.wGrab) * (1 - this.wAir * L);
    for (let i = 0; i < 2; i++) { jt.blades[i].visible = hasBlades; jt.blades[i].rotation.z = (i ? -1 : 1) * splay; }
    this.flareGun.visible = this.wFlare > 0.3;
    if (this.flareGun.visible) jt.blades[1].visible = false;
    // blade shine: flash through the sweep
    const flashT = slashing ? Math.sin(clamp(this.slashP, 0, 1) * Math.PI) : 0;
    this.bladeFlash += (Math.max(flashT, this.wSpin) - this.bladeFlash) * k(30);
    const bf = this.bladeFlash;
    this.bladeMat.userData.flash.setRGB(0.1 + 0.85 * bf, 0.13 + 0.82 * bf, 0.17 + 0.78 * bf);

    // ── gas jet
    const boost = this.wBoost;
    this.jet.visible = boost > 0.05;
    if (this.jet.visible) {
      const fl = 0.7 + 0.5 * Math.sin(t * 90) * Math.sin(t * 53);
      this.jet.scale.set(0.7 + boost * 0.5, (0.12 + 0.3 * boost) * fl, 0.7 + boost * 0.5);
      this.jetMat.opacity = 0.5 * boost;
    }

    // ── matrices, then the cape sim in the root-relative frame
    this.root.updateMatrixWorld(true);
    this.skeleton.update();               // bone matrices now (also right for a shadow pass when the body is off-screen)
    // cape LOD (comrades): `capeEvery` = simulate every Nth frame with the summed time, `capeHz` = substep rate
    this._capeDt += dt;
    if (this.first || ++this._capeN % this.capeEvery === 0) {
      const cdt = Math.min(0.1, this._capeDt); this._capeDt = 0;
      const cp = this.cape, rp = this.root.position;
      for (let c = 0; c < CC; c++) {
        _v1.setFromMatrixPosition(this.pins[c].matrixWorld);
        cp.anchor[c * 3] = _v1.x - rp.x; cp.anchor[c * 3 + 1] = _v1.y - rp.y; cp.anchor[c * 3 + 2] = _v1.z - rp.z;
      }
      cp.nSph = this.col.length;
      for (let i = 0; i < this.col.length; i++) {
        const me = this.col[i].o.matrixWorld.elements;
        cp.spheres[i * 7] = me[12] - rp.x; cp.spheres[i * 7 + 1] = me[13] - rp.y; cp.spheres[i * 7 + 2] = me[14] - rp.z; cp.spheres[i * 7 + 3] = this.col[i].r;
        const bl = hypot(me[8], me[9], me[10]) || 1;
        cp.spheres[i * 7 + 4] = -me[8] / bl; cp.spheres[i * 7 + 5] = -me[9] / bl; cp.spheres[i * 7 + 6] = -me[10] / bl;
      }
      if (!cp.inited) {
        const me = this.col[0].o.matrixWorld.elements;
        cp.reset(-vx * 0.9, -vy * 0.9, -vz * 0.9, -me[8], -me[9], -me[10]);
      }
      // body acceleration (low-passed) as the pseudo-force. The low-pass keeps the integral, so a hard stop (a
      // landing, a wire snapping taut) hands the cloth the whole velocity change and it whips on, then drops; only
      // a jump in velocity bigger than any real one (a teleport) is clipped.
      _v1.set(vx, vy, vz);
      if (cp.hasPrev) {
        _v2.copy(_v1).sub(cp.prevVel);
        const dv = _v2.length();
        if (dv > 24) _v2.multiplyScalar(24 / dv);
        cp.accel.lerp(_v2.multiplyScalar(1 / cdt), k(18));
      }
      cp.prevVel.copy(_v1); cp.hasPrev = true;
      const sf = clamp(speed / 60, 0, 1);
      // apparent wind in the frame = -velocity (damped at extreme speed to keep the cloth readable)
      // (on foot, drag goes as the square of the speed: a heavy wool cloak hangs and sways at a walk, lifts at a jog
      // and streams at a run; the sim's drag is linear, so the apparent wind is scaled by speed / 8 m/s)
      const wm = (speed > 1 ? Math.min(1, 30 / speed) : 1) * lerp(1, clamp(speed / 8, 0.03, 1), 1 - this.wAir);
      // falling, the updraft only lifts the cape so far: it streams up and back off the shoulders instead of standing
      // straight up over the head like a tent (which hides the soldier from the camera behind)
      const wy = Math.min(-vy * wm, CAPE_UPDRAFT);
      // settle: on the ground at a walk (running, it streams out behind), coming in to land, or dropping feet-first
      const fall = sstep(4, 12, -vy) * clamp((this.up.y - 0.6) / 0.35, 0, 1) * this.wAir;
      cp.settle = Math.max(this.wLand, (1 - this.wAir) * (1 - sstep(3, 7, speed)), 0.8 * fall);
      { const me = this.col[0].o.matrixWorld.elements, bl = hypot(me[8], me[9], me[10]) || 1;
        cp.step(cdt, -vx * wm, wy, -vz * wm, sf, -me[8] / bl, -me[9] / bl, -me[10] / bl); }
      // NaN guard
      let bad = false;
      for (let i = 0; i < CN * 3; i += 7) if (!Number.isFinite(cp.pos[i])) { bad = true; break; }
      if (bad) { const me = this.col[0].o.matrixWorld.elements; cp.reset(-vx * 0.9, -vy * 0.9, -vz * 0.9, -me[8], -me[9], -me[10]); }
      const pa = this.capeGeo.attributes.position;
      // render copy = simulated cloth + a cheap travelling ripple (always away from the back, so it never cuts into the body)
      {
        const pa2 = pa.array, ps = cp.pos, rip = (0.012 + 0.07 * sf) * (this.wAir > 0.5 ? 1 : 0.6 + 0.4 * this.wRun);
        const me = this.col[0].o.matrixWorld.elements, bl = hypot(me[8], me[9], me[10]) || 1;
        const bx = -me[8] / bl, by = -me[9] / bl, bz = -me[10] / bl;
        for (let r = 0; r < CR; r++) {
          const rw = Math.pow(r / (CR - 1), 1.3) * rip;
          for (let c = 0; c < CC; c++) {
            const i = (r * CC + c) * 3;
            const d = rw * (0.5 + 0.5 * Math.sin(t * 15 - r * 1.15 + c * 0.8)) * (0.6 + 0.4 * Math.abs(c - 4) / 4);
            pa2[i] = ps[i] + bx * d; pa2[i + 1] = ps[i + 1] + by * d; pa2[i + 2] = ps[i + 2] + bz * d;
          }
        }
      }
      pa.needsUpdate = true;
      const na = this.capeGeo.attributes.normal;
      cp.normals(pa.array as Float32Array, na.array as Float32Array);
      na.needsUpdate = true;
    }

    // ── auto gas (optional)
    if (this.autoGas && boost > 0.05 && this.game && this.game.fx) {
      this.gasNozzle(this._gasPos, this._gasDir);
      this.game.fx.gas(this._gasPos, this._gasDir, boost);
    }
    this.first = false;
  }
}
