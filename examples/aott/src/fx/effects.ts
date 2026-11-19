// AOTT: visual effects.
//
//  * Effects     : one GPU particle system (2 draw calls for ALL particles: a normal-blended instanced-quad pool
//                  for steam / gas / blood / dust / chips / leaves, and an additive pool for sparks / glows),
//                  plus a handful of dedicated meshes (lightning bolt ribbon, light pillar, dust ring,
//                  slash glints, screen flash).
//
// The look is photographic: steam and dust are soft, top-lit volumes that slow and thin as they grow,
// blood is dark and falls as streaked drops, tether-gear gas is a fine white vapour, sparks are short
// motion-stretched streaks.
//
// HOW THE CORE CALLS IT
//   const fx = new Effects(game);              // after game.scene / game.camera / game.collision exist
//   fx.update(dt);                              // once per rendered frame (after titans / player)
//   // after renderer.render(scene, camera):
//   const lines = new SpeedLines(renderer);     // once
//   lines.setIntensity(clamp((speed - 25) / 60, 0, 1));
//   renderer.render(scene, camera);
//   lines.render();                             // draws the overlay on top, without clearing; restores
//                                               // renderer.autoClear and renderer.info counters
//
// Everything is pooled; nothing allocates per frame. Colours are linear THREE.Colors (the shader converts to the
// output colour space), the particle quads honour scene.fog on the normal-blended pool.
import * as THREE from 'hull/three';
import type { Game } from '../types';
import { R } from '../sim';
import { makeCanvas } from '../canvas';

// Math.hypot is variadic and boxes its arguments in hot loops (it was the top source of garbage); this doesn't.
const hypot = (a: number, b: number, c = 0): number => Math.sqrt(a * a + b * b + c * c);

/** Anything with x/y/z (a THREE.Vector3 in practice). */
type XYZ = { x: number; y: number; z: number };
/** [start, end] colours of a smoke / steam burst. */
export type SmokeColors = readonly THREE.Color[];
/** Signal-flare colour names. */
export type FlareColor = 'red' | 'black' | 'green' | 'yellow' | 'purple';
type TileFn = (u: number, v: number, x: number, y: number) => number[];

/** The bits of the player the blade smear reads (duck-typed: the player module owns the real shape). */
interface SmearSource {
  alive?: boolean;
  slashT?: number;
  spin?: unknown;
  model?: { j?: { blades?: THREE.Object3D[] } };
}

// ───────────────────────────────────────────────────────── helpers ──────────────────────────────────────────
const rnd = R.fx;
const rr = (a: number, b: number): number => a + (b - a) * rnd();
const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
const smooth = (a: number, b: number, x: number): number => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TILE = { PUFF: 0, CLOUD_A: 1, CLOUD_B: 2, SPARK: 3, CHIP: 4, LEAF: 5, DUST: 6, DROP: 7 };
const COLS = 4, ROWS = 2, TS = 128;

// flags
const F_GROUND = 1;        // collides with the ground (bounce / die)
const F_WISP = 2;          // on death leaves a faint steam wisp (blood)
const F_FLUTTER = 4;       // leaf flutter
const F_BOUNCE = 8;        // bounce instead of dying on the ground
const F_LIFT = 16;         // keep the puff's lower edge above the ground (steam / dust sit on it instead of clipping)
const F_SPLAT = 32;        // leaves a ground splat where it lands (titan blood)
const F_STEAMY = 64;       // gives off little steam wisps in flight (titan blood evaporates)

const col = (hex: number): THREE.Color => new THREE.Color(hex);
/** Signal-flare smoke: [start, end] colours. Red: a titan; black: an abnormal; green: the new course; yellow: done. */
export const FLARE: Record<FlareColor, [THREE.Color, THREE.Color]> = {
  red: [col(0xe8432f), col(0x8a4038)], black: [col(0x1c1a19), col(0x4a4644)], green: [col(0x4cc46a), col(0x4a7d58)],
  yellow: [col(0xf2d24e), col(0xb9a564)], purple: [col(0x9a5ad0), col(0x66507e)],
};
const _flareD = new THREE.Vector3();
// A grounded palette: steam is a warm off-white that greys as it thins, gas a fine near-white vapour, blood a deep
// venous red, dust earthy and pale.
const C = {
  white: col(0xffffff), steam: col(0xe9e8e4), steamEnd: col(0xb4b6b8), gas: col(0xf1f2f2), gasEnd: col(0xdcdfe2),
  bloodA: col(0x4a0408), bloodB: col(0x260204), mistA: col(0x5c0e10), mistB: col(0x8c7c78),
  stone: col(0x8a8c90), stoneDark: col(0x55575c), dustStone: col(0xa8a49b), dustDirt: col(0x8a7055), dustEnd: col(0xb3a894),
  wood: col(0x8a5a2e), woodDark: col(0x5a3a1c), bark: col(0x6b4a2a), roof: col(0x9a4e33),
  sparkHot: col(0xfff1d0), sparkEnd: col(0xff5a10), leafA: col(0x3a7f2c), leafB: col(0x7c9a3a), leafC: col(0x2c6428),
};
const _fallbackCam = new THREE.PerspectiveCamera();
const UP = new THREE.Vector3(0, 1, 0);

// ───────────────────────────────────────────── particle texture atlas ───────────────────────────────────────
/** Seeded 2-D value noise + fbm, used to break the soft volumes up so they read as vapour rather than discs. */
function makeNoise(seed: number): (x: number, y: number) => number {
  const R = mulberry32(seed);
  const N = 64, g = new Float32Array(N * N);
  for (let i = 0; i < g.length; i++) g[i] = R();
  const at = (i: number, j: number): number => g[(((j % N) + N) % N) * N + (((i % N) + N) % N)];
  const vn = (x: number, y: number): number => {
    const i = Math.floor(x), j = Math.floor(y);
    let fx = x - i, fy = y - j;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const a = at(i, j), b = at(i + 1, j), c = at(i, j + 1), d = at(i + 1, j + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  return (x: number, y: number): number => {
    let s = 0, amp = 0.5, f = 1;
    for (let o = 0; o < 4; o++) { s += vn(x * f, y * f) * amp; f *= 2.03; amp *= 0.5; }
    return s / 0.9375;
  };
}

function makeAtlas(): THREE.CanvasTexture {
  const W = COLS * TS, H = ROWS * TS;
  const cv = makeCanvas();
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d') as CanvasRenderingContext2D;
  const img = ctx.createImageData(W, H);
  const d = img.data;
  const put = (c: number, r: number, fn: TileFn): void => {
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
      const u = (x + 0.5) / TS - 0.5, v = (y + 0.5) / TS - 0.5;      // -0.5..0.5, y down
      const o = ((r * TS + y) * W + c * TS + x) * 4;
      const px = fn(u, v, x, y);
      d[o] = clamp(px[0], 0, 1) * 255; d[o + 1] = clamp(px[1], 0, 1) * 255; d[o + 2] = clamp(px[2], 0, 1) * 255; d[o + 3] = clamp(px[3], 0, 1) * 255;
    }
  };
  const out = [0, 0, 0, 0];
  const nz = makeNoise(91);

  // soft puff: a gaussian-ish blob with a faint noisy edge, lit from above (its top a touch brighter)
  put(0, 0, (u, v) => {
    const r = hypot(u, v) * 2;
    const n = nz(u * 6 + 3.1, v * 6 + 7.7);
    const a = Math.pow(clamp(1 - r * (0.9 + 0.25 * n), 0, 1), 2.0);
    const lit = 0.84 + 0.16 * clamp(0.5 - v * 1.6, 0, 1);
    out[0] = out[1] = out[2] = lit; out[3] = a; return out;
  });

  // billowing vapour: a height field of overlapping domes eroded by fbm, shaded from the gradient with a soft
  // key light from above and a darker, cooler underside, so it reads as a lit volume
  const cloud = (seed: number, flat: boolean, count: number, spread: number): TileFn => {
    const R = mulberry32(seed);
    const n2 = makeNoise(seed * 3 + 1);
    const domes = [{ x: 0, y: 0.02, r: 0.3 }];
    for (let i = 0; i < count; i++) {
      const a = R() * Math.PI * 2, rad = Math.sqrt(R()) * spread;
      domes.push({ x: Math.cos(a) * rad, y: Math.sin(a) * rad * 0.9, r: 0.1 + R() * 0.15 });
    }
    const hf = new Float32Array((TS + 2) * (TS + 2));
    for (let y = -1; y <= TS; y++) for (let x = -1; x <= TS; x++) {
      const u = (x + 0.5) / TS - 0.5, v = (y + 0.5) / TS - 0.5;
      let s = 0;
      for (const m of domes) {
        const dd = hypot(u - m.x, v - m.y) / m.r;
        if (dd < 1) s += Math.pow(Math.sqrt(1 - dd * dd) * m.r, 3);
      }
      const n = n2(u * 7 + 11, v * 7 + 5);
      hf[(y + 1) * (TS + 2) + x + 1] = Math.pow(s, 1 / 3) * (0.7 + 0.6 * n);
    }
    return (u, v, x, y) => {
      const h = hf[(y + 1) * (TS + 2) + x + 1];
      const hx = hf[(y + 1) * (TS + 2) + x + 2] - hf[(y + 1) * (TS + 2) + x];
      const hy = hf[(y + 2) * (TS + 2) + x + 1] - hf[y * (TS + 2) + x + 1];
      const r = hypot(u, v) * 2;
      const a = smooth(0.0, 0.26, h) * (1 - smooth(0.6, 1.0, r)) * (flat ? 0.8 : 0.92);
      let nx = -hx * 14, ny = -hy * 14, nz2 = 1;
      const l = hypot(nx, ny, nz2); nx /= l; ny /= l; nz2 /= l;
      const key = clamp(nx * -0.25 + ny * -0.75 + nz2 * 0.6, 0, 1);
      // wrap lighting (light scatters through vapour) and a darker underside
      let lit = 0.56 + 0.44 * key;
      lit *= 0.78 + 0.22 * clamp(0.55 - v * 1.5, 0, 1);
      if (flat) lit = 0.88 + 0.12 * lit;
      const cool = clamp(v * 1.2 + 0.15, 0, 1) * (flat ? 0.05 : 0.12);
      out[0] = lit * (1 - cool * 0.6); out[1] = lit * (1 - cool * 0.3); out[2] = lit; out[3] = a;
      return out;
    };
  };
  put(1, 0, cloud(11, false, 11, 0.27));
  put(2, 0, cloud(37, false, 13, 0.3));

  // spark: a thin motion streak along +x (the shader stretches it along the velocity), hot and narrow in the
  // middle, tapering to both ends, brighter at the leading (+x) end
  put(3, 0, (u, v) => {
    const along = u * 2;                                       // -1 (tail) .. 1 (head)
    const taper = Math.pow(clamp(1 - Math.abs(along), 0, 1), 0.7) * (0.55 + 0.45 * (along * 0.5 + 0.5));
    const across = Math.exp(-v * v * 260);
    const core = Math.exp(-v * v * 1400) * taper;
    out[0] = out[1] = out[2] = 1; out[3] = clamp(across * taper * 0.75 + core, 0, 1); return out;
  });

  // chip: hard-edged irregular polygon, two facets, with a little grain
  {
    const R = mulberry32(5);
    const pts: [number, number][] = [];
    const n = 6;
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2 + R() * 0.5; const rad = 0.28 + R() * 0.16; pts.push([Math.cos(a) * rad, Math.sin(a) * rad]); }
    const inside = (u: number, v: number): boolean => {
      for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        const cr = (b[0] - a[0]) * (v - a[1]) - (b[1] - a[1]) * (u - a[0]);
        if (cr < 0) return false;
      }
      return true;
    };
    put(0, 1, (u, v) => {
      const ins = inside(u, v);
      const grain = 0.85 + 0.3 * nz(u * 30 + 50, v * 30);
      out[0] = out[1] = out[2] = ins ? (u + v > 0.02 ? 0.6 : 0.92) * grain : 0; out[3] = ins ? 1 : 0; return out;
    });
  }

  // leaf (along +x), pointed at both ends, darker midrib
  put(1, 1, (u, v) => {
    const x = u * 2 / 0.95;                                  // -1..1 along the leaf
    if (Math.abs(x) > 1) { out[3] = 0; return out; }
    const w = 0.34 * Math.pow(Math.sin((x * 0.5 + 0.5) * Math.PI), 0.8) * (x < 0 ? 0.78 : 1);
    const ins = Math.abs(v) < w * 0.5 ? 1 : 0;
    const rib = Math.abs(v) < 0.012 ? 0.7 : 1;
    const shade = (0.86 + 0.14 * (v > 0 ? 1 : 0.55) * (1 - Math.abs(x) * 0.2)) * (0.9 + 0.2 * nz(u * 20 + 9, v * 20));
    out[0] = out[1] = out[2] = shade * rib; out[3] = ins; return out;
  });

  // dust: lumpy, soft and mostly flat-lit
  put(2, 1, cloud(77, true, 9, 0.25));

  // drop: round, dark, with only a faint sheen (stretches into a streak in motion)
  put(3, 1, (u, v) => {
    const r = hypot(u, v) * 2;
    const a = 1 - smooth(0.7, 1.0, r);
    const hl = Math.exp(-(Math.pow((u + 0.12) * 7, 2) + Math.pow((v + 0.12) * 7, 2)));
    out[0] = out[1] = out[2] = 0.82 + 0.1 * hl; out[3] = a; return out;
  });

  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// ─────────────────────────────────────────────── particle pool ──────────────────────────────────────────────
const VERT = /* glsl */`
attribute vec4 aPosSize;   // xyz position, w size (quad edge length)
attribute vec4 aVel;       // xyz velocity (streak direction), w streak length in metres (0 = billboard)
attribute vec4 aColor;
attribute vec4 aMisc;      // x tile, y rotation
uniform vec2 uGrid;
varying vec4 vColor;
varying vec2 vUv;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(aPosSize.xyz, 1.0);
  vec2 q = position.xy;
  float size = aPosSize.w;
  // fade a quad out as the camera reaches it, so flying through steam (or past a stretched drop) never fills the
  // screen with a flat card
  float ext = max(size, aVel.w);
  float nearFade = smoothstep(0.25 * ext, 1.2 * ext + 0.3, -mvPosition.z);
  vec2 off;
  if (aVel.w > 0.0) {
    vec3 vd = (viewMatrix * vec4(aVel.xyz, 0.0)).xyz;
    float l3 = length(vd);
    vec2 d = vd.xy;
    float l = length(d);
    d = l > 1e-5 ? d / l : vec2(1.0, 0.0);
    float fs = clamp(l / max(l3, 1e-5), 0.2, 1.0);
    off = d * q.x * max(aVel.w * fs, size) + vec2(-d.y, d.x) * q.y * size;
  } else {
    float c = cos(aMisc.y), s = sin(aMisc.y);
    off = vec2(c * q.x - s * q.y, s * q.x + c * q.y) * size;
  }
  mvPosition.xy += off;
  gl_Position = projectionMatrix * mvPosition;
  float tile = aMisc.x;
  float col = mod(tile, uGrid.x);
  float row = floor(tile / uGrid.x);
  vUv = vec2((col + q.x + 0.5) / uGrid.x, (uGrid.y - 1.0 - row + q.y + 0.5) / uGrid.y);
  vColor = vec4(aColor.rgb, aColor.a * nearFade);
  #include <fog_vertex>
}`;

const FRAG = /* glsl */`
uniform sampler2D uMap;
varying vec4 vColor;
varying vec2 vUv;
#include <common>
#include <fog_pars_fragment>
void main() {
  vec4 t = texture2D(uMap, vUv);
  float a = vColor.a * t.a;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor.rgb * t.rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #ifdef USE_FOG
  #ifdef ADDITIVE
  #else
  #include <fog_fragment>
  #endif
  #endif
}`;

class Pool {
  max: number; next: number; high: number; alive: number;
  px: Float32Array; py: Float32Array; pz: Float32Array; vx: Float32Array; vy: Float32Array; vz: Float32Array;
  age: Float32Array; life: Float32Array; s0: Float32Array; s1: Float32Array; rot: Float32Array; rotV: Float32Array;
  drag: Float32Array; grav: Float32Array; stretch: Float32Array; fi: Float32Array; fo: Float32Array;
  r0: Float32Array; g0: Float32Array; b0: Float32Array; r1: Float32Array; g1: Float32Array; b1: Float32Array; a0: Float32Array; a1: Float32Array;
  flags: Uint8Array;
  aPos: THREE.InstancedBufferAttribute; aVel: THREE.InstancedBufferAttribute; aCol: THREE.InstancedBufferAttribute; aMisc: THREE.InstancedBufferAttribute;
  _attrs: THREE.InstancedBufferAttribute[];
  geo: THREE.InstancedBufferGeometry;
  mat: THREE.ShaderMaterial;
  mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;

  constructor(max: number, atlas: THREE.Texture, additive: boolean, renderOrder: number) {
    this.max = max; this.next = 0; this.high = 0; this.alive = 0;
    const f = () => new Float32Array(max);
    this.px = f(); this.py = f(); this.pz = f(); this.vx = f(); this.vy = f(); this.vz = f();
    this.age = f(); this.life = f(); this.s0 = f(); this.s1 = f(); this.rot = f(); this.rotV = f();
    this.drag = f(); this.grav = f(); this.stretch = f(); this.fi = f(); this.fo = f();
    this.r0 = f(); this.g0 = f(); this.b0 = f(); this.r1 = f(); this.g1 = f(); this.b1 = f(); this.a0 = f(); this.a1 = f();
    this.flags = new Uint8Array(max);

    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (n: string): THREE.InstancedBufferAttribute => { const a = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4); a.setUsage(THREE.DynamicDrawUsage); g.setAttribute(n, a); return a; };
    this.aPos = mk('aPosSize'); this.aVel = mk('aVel'); this.aCol = mk('aColor'); this.aMisc = mk('aMisc');
    this._attrs = [this.aPos, this.aVel, this.aCol, this.aMisc];
    g.instanceCount = 0;
    this.geo = g;

    const defines: Record<string, string> = additive ? { ADDITIVE: '' } : {};
    const mat = new THREE.ShaderMaterial({
      defines,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uMap: { value: atlas }, uGrid: { value: new THREE.Vector2(COLS, ROWS) } }]),
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, depthTest: true, fog: !additive,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      toneMapped: !additive,
    });
    this.mat = mat;
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.raycast = () => {};
  }

  /** Allocates a slot (ring buffer: the oldest particle is recycled) and sets defaults. */
  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number, tile: number): number {
    const i = this.next; this.next = (i + 1) % this.max;
    if (i >= this.high) this.high = i + 1;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z; this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.age[i] = 0; this.life[i] = life; this.s0[i] = s0; this.s1[i] = s1;
    this.rot[i] = rnd() * 6.2832; this.rotV[i] = 0; this.drag[i] = 0; this.grav[i] = 0; this.stretch[i] = 0;
    this.fi[i] = 0.08; this.fo[i] = 0.5; this.flags[i] = 0;
    this.r0[i] = this.g0[i] = this.b0[i] = this.r1[i] = this.g1[i] = this.b1[i] = 1; this.a0[i] = 1; this.a1[i] = 1;
    (this.aMisc.array as Float32Array)[i * 4] = tile;
    (this.aPos.array as Float32Array)[i * 4 + 3] = 0;       // invisible until the first update
    return i;
  }
  color(i: number, c0: THREE.Color, c1: THREE.Color, a0: number, a1?: number): void {
    this.r0[i] = c0.r; this.g0[i] = c0.g; this.b0[i] = c0.b; this.r1[i] = c1.r; this.g1[i] = c1.g; this.b1[i] = c1.b;
    this.a0[i] = a0; this.a1[i] = a1 === undefined ? a0 : a1;
  }
  phys(i: number, drag: number, grav: number, rotV: number, stretch: number, flags: number): void { this.drag[i] = drag; this.grav[i] = grav; this.rotV[i] = rotV; this.stretch[i] = stretch; this.flags[i] = flags; }
  env(i: number, fi: number, fo: number, delay: number): void { this.fi[i] = fi; this.fo[i] = fo; if (delay) this.age[i] = -delay; }

  update(dt: number, fx: Effects): void {
    const { px, py, pz, vx, vy, vz, age, life, s0, s1, rot, rotV, drag, grav, stretch, fi, fo, flags } = this;
    const aP = this.aPos.array as Float32Array, aV = this.aVel.array as Float32Array, aC = this.aCol.array as Float32Array, aM = this.aMisc.array as Float32Array;
    let hi = 0, alive = 0;
    for (let i = 0; i < this.high; i++) {
      const lf = life[i];
      if (lf <= 0) continue;
      const a = age[i] + dt;
      age[i] = a;
      const o = i * 4;
      if (a < 0) { hi = i + 1; alive++; continue; }
      const fl = flags[i];
      if (a >= lf) {
        if (fl & F_WISP) fx._queueWisp(px[i], py[i], pz[i]);
        life[i] = 0; aP[o + 3] = 0; continue;
      }
      hi = i + 1; alive++;
      // integrate
      const k = Math.exp(-drag[i] * dt);
      let x = vx[i] * k, y = vy[i] * k - grav[i] * dt, z = vz[i] * k;
      if (fl & F_FLUTTER) {
        const ph = a * 8 + i * 1.7;
        x += Math.sin(ph) * dt * 7; z += Math.cos(ph * 0.83) * dt * 7; y += Math.sin(ph * 1.3) * dt * 3.5;
      }
      vx[i] = x; vy[i] = y; vz[i] = z;
      let X = px[i] + x * dt, Y = py[i] + y * dt, Z = pz[i] + z * dt;
      if (fl & F_GROUND) {
        const gh = fx._ground(X, Z);
        if (Y < gh + 0.02) {
          if (fl & F_BOUNCE) {
            Y = gh + 0.02; vy[i] = -vy[i] * 0.32; vx[i] *= 0.6; vz[i] *= 0.6; rotV[i] *= 0.4;
            if (Math.abs(vy[i]) < 0.8) { vy[i] = 0; vx[i] *= 0.85; vz[i] *= 0.85; }
          } else {
            age[i] = lf; Y = gh + 0.02;
            if (fl & F_SPLAT) { fx._queueSplat(X, gh, Z, s0[i]); flags[i] = fl & ~F_WISP; }
          }
        }
      }
      if ((fl & F_STEAMY) && rnd() < dt * 7) fx._queueSteamlet(X, Y, Z);
      const t = a / lf;
      const e = 1 - (1 - t) * (1 - t);
      const size = s0[i] + (s1[i] - s0[i]) * e;
      if (fl & F_LIFT) {
        const gl = fx._ground(X, Z) + size * 0.4;
        if (Y < gl) { Y = gl; if (vy[i] < 0) vy[i] = 0; }
      }
      px[i] = X; py[i] = Y; pz[i] = Z;
      rot[i] += rotV[i] * dt;
      let al = this.a0[i] + (this.a1[i] - this.a0[i]) * t;
      const f0 = fi[i];
      if (f0 > 0 && t < f0) al *= smooth(0, 1, t / f0);
      const f1 = fo[i];
      if (t > f1) { const u = (t - f1) / (1 - f1 + 1e-6); al *= 1 - u * u * (3 - 2 * u); }
      aP[o] = X; aP[o + 1] = Y; aP[o + 2] = Z; aP[o + 3] = size;
      const st = stretch[i];
      if (st > 0) {
        const vv = hypot(vx[i], vy[i], vz[i]);
        aV[o] = vx[i]; aV[o + 1] = vy[i]; aV[o + 2] = vz[i]; aV[o + 3] = Math.max(size, vv * st);
      } else aV[o + 3] = 0;
      aC[o] = this.r0[i] + (this.r1[i] - this.r0[i]) * t; aC[o + 1] = this.g0[i] + (this.g1[i] - this.g0[i]) * t;
      aC[o + 2] = this.b0[i] + (this.b1[i] - this.b0[i]) * t; aC[o + 3] = al;
      aM[o + 1] = rot[i];
    }
    this.high = hi; this.alive = alive;
    this.geo.instanceCount = hi;
    this.mesh.visible = hi > 0;
    if (hi > 0) {
      const A = this._attrs;
      for (let q = 0; q < 4; q++) { const at = A[q]; at.clearUpdateRanges(); at.addUpdateRange(0, hi * 4); at.needsUpdate = true; }
    }
  }
}

// ───────────────────────────────────────────────── bolt ribbon ──────────────────────────────────────────────
const MAX_BOLT_PTS = 220;          // polyline points per bolt (main + branches)
class Bolt {
  pts: Float32Array; wid: Float32Array; start: number[]; len: number[];
  pos: THREE.BufferAttribute; uv: THREE.BufferAttribute; rgb: THREE.BufferAttribute; index: THREE.BufferAttribute;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  npts: number; age: number; nverts: number; nidx: number;

  constructor(tex: THREE.Texture) {
    this.pts = new Float32Array(MAX_BOLT_PTS * 3);
    this.wid = new Float32Array(MAX_BOLT_PTS);
    this.start = []; this.len = [];            // polylines
    const quadsMax = MAX_BOLT_PTS * 2;          // two layers
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(quadsMax * 2 * 3), 3); this.pos.setUsage(THREE.DynamicDrawUsage);
    this.uv = new THREE.BufferAttribute(new Float32Array(quadsMax * 2 * 2), 2);
    this.rgb = new THREE.BufferAttribute(new Float32Array(quadsMax * 2 * 3), 3);
    this.index = new THREE.BufferAttribute(new Uint16Array(quadsMax * 6), 1);
    g.setAttribute('position', this.pos); g.setAttribute('uv', this.uv); g.setAttribute('color', this.rgb); g.setIndex(this.index);
    const m = new THREE.MeshBasicMaterial({ map: tex, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false; this.mesh.visible = false; this.mesh.renderOrder = 30;
    this.mesh.raycast = () => {};
    this.npts = 0; this.age = 99; this.nverts = 0; this.nidx = 0;
  }
}

// ─────────────────────────────────────────────── shared noise ───────────────────────────────────────────────
const NOISE_GLSL = /* glsl */`
float fxh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float fxn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(fxh(i), fxh(i + vec2(1.0, 0.0)), f.x), mix(fxh(i + vec2(0.0, 1.0)), fxh(i + vec2(1.0, 1.0)), f.x), f.y); }`;

// ─────────────────────────────────────────────── ground decals ──────────────────────────────────────────────
// Flat instanced quads on the ground: titan-blood splats that darken and hiss away into steam, and boot scrapes.
const DC_MAX = 256;
const DC_VERT = /* glsl */`
attribute vec4 aA;      // x y z rotation
attribute vec4 aB;      // size along, size across, alpha, shrink (dissolve radius 0..1)
attribute vec4 aC;      // rgb, kind (0 blood, 1 scrape)
varying vec2 vUv;
varying vec4 vB;
varying vec4 vC;
varying float vSeed;
#include <fog_pars_vertex>
void main() {
  vec2 l = vec2(position.x * aB.x, position.z * aB.y);
  float c = cos(aA.w), s = sin(aA.w);
  vec3 w = vec3(aA.x + c * l.x - s * l.y, aA.y, aA.z + s * l.x + c * l.y);
  vec4 mvPosition = viewMatrix * vec4(w, 1.0);
  vUv = position.xz; vB = aB; vC = aC; vSeed = fract(aA.x * 0.731 + aA.z * 0.377);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const DC_FRAG = /* glsl */`
varying vec2 vUv;
varying vec4 vB;
varying vec4 vC;
varying float vSeed;
#include <common>
#include <fog_pars_fragment>
${NOISE_GLSL}
void main() {
  float a;
  if (vC.w < 0.5) {
    vec2 p = vUv * 2.0;
    float r = length(p), an = atan(p.y, p.x);
    float rim = 0.8 + 0.1 * sin(an * 5.0 + vSeed * 40.0) + 0.06 * sin(an * 11.0 + vSeed * 17.0);
    float n = fxn(p * 3.0 + vSeed * 31.0);
    float R = rim * vB.w - (1.0 - vB.w) * n * 0.6;           // evaporating: it shrinks and breaks up from the rim
    a = 1.0 - smoothstep(R - 0.04, R, r);
    // satellite drops
    vec2 q = p * 3.2 + vSeed * 9.0; vec2 cell = floor(q);
    float h = fxh(cell);
    a = max(a, (1.0 - smoothstep(0.18, 0.24, length(fract(q) - 0.5))) * step(0.82, h) * step(0.95, r) * step(r, 1.0) * step(0.5, vB.w));
    a *= 0.75 + 0.25 * n;
  } else {
    float along = vUv.x * 2.0, across = vUv.y * 2.0;
    float taper = 1.0 - smoothstep(0.55, 1.0, abs(along));
    float lines = smoothstep(0.35, 0.1, abs(fract(across * 1.5 + vSeed) - 0.5) * 2.0 - 0.4);
    a = taper * (1.0 - smoothstep(0.7, 1.0, abs(across))) * (0.45 + 0.55 * lines) * (0.6 + 0.4 * fxn(vec2(along * 6.0, across * 3.0 + vSeed * 10.0)));
  }
  a *= vB.z;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vC.rgb, a);
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

class Decals {
  x: Float32Array; y: Float32Array; z: Float32Array; rot: Float32Array; sx: Float32Array; sy: Float32Array; age: Float32Array; life: Float32Array;
  kind: Uint8Array; acc: Float32Array; size: Float32Array;
  next: number; high: number;
  aA: THREE.InstancedBufferAttribute; aB: THREE.InstancedBufferAttribute; aC: THREE.InstancedBufferAttribute;
  geo: THREE.InstancedBufferGeometry;
  mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;

  constructor() {
    const f = () => new Float32Array(DC_MAX);
    this.x = f(); this.y = f(); this.z = f(); this.rot = f(); this.sx = f(); this.sy = f(); this.age = f(); this.life = f();
    this.kind = new Uint8Array(DC_MAX); this.acc = f(); this.size = f();
    this.next = 0; this.high = 0;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5], 3));
    g.setIndex([0, 2, 1, 0, 3, 2]);
    const mk = (n: string): THREE.InstancedBufferAttribute => { const a = new THREE.InstancedBufferAttribute(new Float32Array(DC_MAX * 4), 4); a.setUsage(THREE.DynamicDrawUsage); g.setAttribute(n, a); return a; };
    this.aA = mk('aA'); this.aB = mk('aB'); this.aC = mk('aC');
    g.instanceCount = 0;
    this.geo = g;
    this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
      vertexShader: DC_VERT, fragmentShader: DC_FRAG, transparent: true, depthWrite: false, fog: true,
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    }));
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 3; this.mesh.visible = false; this.mesh.raycast = () => {};
  }

  add(kind: number, x: number, y: number, z: number, sx: number, sy: number, rot: number, life: number): number {
    const i = this.next; this.next = (i + 1) % DC_MAX;
    if (i >= this.high) this.high = i + 1;
    this.kind[i] = kind; this.x[i] = x; this.y[i] = y + 0.07; this.z[i] = z; this.sx[i] = sx; this.sy[i] = sy; this.rot[i] = rot;
    this.age[i] = 0; this.life[i] = life; this.acc[i] = 0; this.size[i] = Math.max(sx, sy);
    return i;
  }

  update(dt: number, fx: Effects): void {
    const A = this.aA.array as Float32Array, B = this.aB.array as Float32Array, Cc = this.aC.array as Float32Array, P = fx.norm;
    let hi = 0;
    for (let i = 0; i < this.high; i++) {
      const o = i * 4;
      if (this.life[i] <= 0) { B[o + 2] = 0; continue; }
      const a = (this.age[i] += dt), lf = this.life[i];
      if (a >= lf) { this.life[i] = 0; B[o + 2] = 0; continue; }
      hi = i + 1;
      const t = a / lf;
      A[o] = this.x[i]; A[o + 1] = this.y[i]; A[o + 2] = this.z[i]; A[o + 3] = this.rot[i];
      if (this.kind[i] === 0) {
        // titan blood: fresh red, darkens, then hisses away into steam (it shrinks and breaks up from the rim)
        const grow = 0.75 + 0.25 * smooth(0, 0.08, t);
        B[o] = this.sx[i] * grow; B[o + 1] = this.sy[i] * grow;
        B[o + 2] = 0.92 * (1 - smooth(0.85, 1, t));
        B[o + 3] = 1 - smooth(0.32, 1.0, t) * 0.95;
        // fresh it is a deep wet red, it soaks in and dries towards brown-black
        const d = smooth(0.05, 0.45, t);
        Cc[o] = 0.12 - 0.085 * d; Cc[o + 1] = 0.006 + 0.008 * d; Cc[o + 2] = 0.007 + 0.006 * d; Cc[o + 3] = 0;
        if (t > 0.22 && t < 0.92) {
          this.acc[i] += dt * (2.5 + this.size[i] * 5);
          while (this.acc[i] >= 1) {
            this.acc[i] -= 1;
            if (fx._free() < 0.15) break;
            const s = this.size[i], r = s * 0.35;
            const j = P.spawn(this.x[i] + rr(-r, r), this.y[i] + 0.05, this.z[i] + rr(-r, r), rr(-0.2, 0.2), rr(0.7, 1.6), rr(-0.2, 0.2),
              rr(0.7, 1.3), 0.06 + s * 0.12, 0.3 + s * rr(0.45, 0.8), rnd() < 0.5 ? TILE.CLOUD_A : TILE.PUFF);
            P.color(j, C.steam, C.steamEnd, rr(0.35, 0.6), 0.15); P.phys(j, 0.9, -0.5, rr(-0.8, 0.8), 0, 0); P.env(j, 0.15, 0.35, 0);
          }
        }
      } else {
        B[o] = this.sx[i]; B[o + 1] = this.sy[i];
        B[o + 2] = 0.8 * (1 - smooth(0.6, 1, t)) * smooth(0, 0.03, t); B[o + 3] = 1;
        Cc[o] = 0.09; Cc[o + 1] = 0.06; Cc[o + 2] = 0.035; Cc[o + 3] = 1;
      }
    }
    this.high = hi;
    this.geo.instanceCount = hi;
    this.mesh.visible = hi > 0;
    if (hi > 0) for (const at of [this.aA, this.aB, this.aC]) { at.clearUpdateRanges(); at.addUpdateRange(0, hi * 4); at.needsUpdate = true; }
  }

  clear(): void { this.life.fill(0); this.high = 0; this.geo.instanceCount = 0; this.mesh.visible = false; }
}

// ──────────────────────────────────────────────── blade smear ───────────────────────────────────────────────
// A swept surface between the blade's last few positions (Catmull-Rom between samples so it curves), drawn as a
// faint motion-blur sheet with a thin bright line where the edge catches the light: what a camera sees of a fast
// blade in a frame or two.
const SM_H = 6, SM_SUB = 5, SM_COLS = (SM_H - 1) * SM_SUB + 1, SM_ROWS = 4;
class BladeSmear {
  hist: Float32Array; htime: Float32Array; hn: number[]; hhead: number[];
  pos: THREE.BufferAttribute; uv: THREE.BufferAttribute;
  geo: THREE.BufferGeometry;
  mat: THREE.ShaderMaterial;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  _m: THREE.Vector3; _t: THREE.Vector3; _b: THREE.Vector3;

  constructor() {
    this.hist = new Float32Array(2 * SM_H * 6);     // per blade: ring of [tip xyz, base xyz]
    this.htime = new Float32Array(2 * SM_H);
    this.hn = [0, 0]; this.hhead = [0, 0];
    const nv = 2 * SM_COLS * SM_ROWS;
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(nv * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.uv = new THREE.BufferAttribute(new Float32Array(nv * 2), 2).setUsage(THREE.DynamicDrawUsage);
    const idx: number[] = [];
    for (let b = 0; b < 2; b++) for (let c = 0; c < SM_COLS - 1; c++) for (let r = 0; r < SM_ROWS - 1; r++) {
      const v = b * SM_COLS * SM_ROWS + c * SM_ROWS + r;
      idx.push(v, v + SM_ROWS, v + 1, v + 1, v + SM_ROWS, v + SM_ROWS + 1);
    }
    g.setAttribute('position', this.pos); g.setAttribute('uv', this.uv); g.setIndex(idx);
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uA: { value: 1 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `varying vec2 vUv; uniform float uA;
        float h1(float n){ return fract(sin(n * 91.7 + 13.1) * 43758.5453); }
        void main(){
          float u = vUv.x, v = vUv.y;                     // u: 0 = the blade now .. 1 = oldest; v: 0 = hilt side .. 1 = tip
          float body = smoothstep(0.0, 0.35, v) * (1.0 - smoothstep(0.94, 1.0, v));
          float fade = (1.0 - u) * (1.0 - u);
          // a very fine streak texture so the sheet reads as motion blur rather than a solid fan
          float grain = 0.8 + 0.2 * h1(floor(v * 40.0));
          float sheet = fade * body * 0.13 * grain;
          float edge = smoothstep(0.82, 0.97, v) * (1.0 - smoothstep(0.97, 1.0, v)) * (1.0 - u) * 0.22;
          float a = (sheet + edge) * uA;
          if (a < 0.004) discard;
          gl_FragColor = vec4(vec3(0.86, 0.88, 0.9), clamp(a, 0.0, 1.0));
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, fog: false,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 26; this.mesh.visible = false; this.mesh.raycast = () => {};
    this._m = new THREE.Vector3(); this._t = new THREE.Vector3(); this._b = new THREE.Vector3();
  }

  push(b: number, tip: XYZ, base: XYZ, time: number): void {
    const h = this.hhead[b];
    const o = (b * SM_H + h) * 6;
    this.hist[o] = tip.x; this.hist[o + 1] = tip.y; this.hist[o + 2] = tip.z;
    this.hist[o + 3] = base.x; this.hist[o + 4] = base.y; this.hist[o + 5] = base.z;
    this.htime[b * SM_H + h] = time;
    this.hhead[b] = (h + 1) % SM_H; this.hn[b] = Math.min(SM_H, this.hn[b] + 1);
  }

  reset(): void { this.hn[0] = this.hn[1] = 0; this.mesh.visible = false; }

  /** Rebuild from the history; samples older than `win` seconds are dropped. */
  build(time: number, win: number, alpha: number): void {
    const P = this.pos.array as Float32Array, U = this.uv.array as Float32Array, H = this.hist;
    let any = false;
    for (let b = 0; b < 2; b++) {
      // count fresh samples (newest first)
      let n = 0;
      for (let k = 0; k < this.hn[b]; k++) { const s = (this.hhead[b] - 1 - k + SM_H * 2) % SM_H; if (time - this.htime[b * SM_H + s] > win) break; n++; }
      const vb = b * SM_COLS * SM_ROWS;
      if (n < 2) { for (let v = vb * 3; v < (vb + SM_COLS * SM_ROWS) * 3; v++) P[v] = 0; continue; }
      any = true;
      const S = (k: number): number => (b * SM_H + (this.hhead[b] - 1 - Math.min(Math.max(k, 0), n - 1) + SM_H * 2) % SM_H) * 6;   // k = 0 newest
      const cols = (n - 1) * SM_SUB + 1;
      for (let c = 0; c < SM_COLS; c++) {
        const cc = Math.min(c, cols - 1);
        const seg = Math.min(Math.floor(cc / SM_SUB), n - 2), t = cc / SM_SUB - seg;
        const i0 = S(seg - 1), i1 = S(seg), i2 = S(seg + 1), i3 = S(seg + 2);
        const cr = (j: number): number => {
          const p0 = H[i0 + j], p1 = H[i1 + j], p2 = H[i2 + j], p3 = H[i3 + j];
          return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
        };
        const tx = cr(0), ty = cr(1), tz = cr(2), bx = cr(3), by = cr(4), bz = cr(5);
        const u = cc / Math.max(1, cols - 1);
        for (let r = 0; r < SM_ROWS; r++) {
          const v = r / (SM_ROWS - 1), vi = vb + c * SM_ROWS + r;
          const e = v;
          P[vi * 3] = bx + (tx - bx) * e; P[vi * 3 + 1] = by + (ty - by) * e; P[vi * 3 + 2] = bz + (tz - bz) * e;
          U[vi * 2] = u; U[vi * 2 + 1] = v;
        }
      }
    }
    this.mesh.visible = any;
    this.mat.uniforms.uA.value = alpha;
    if (any) { this.pos.needsUpdate = true; this.uv.needsUpdate = true; }
  }
}

// ─────────────────────────────────────────────────── Effects ────────────────────────────────────────────────
interface Strike {
  active: boolean; age: number; x: number; y: number; z: number; h: number; R: number; bolt: Bolt; steamAcc: number; seed: number;
}
interface Flare { p: THREE.Vector3; v: THREE.Vector3; t: number; e: number; colors: SmokeColors }

export class Effects {
  game: Game;
  scene: THREE.Scene;
  time: number;
  _dt: number;
  _gasAcc: number;
  _lastSteam: number; _lastSteamPos: THREE.Vector3;
  _wisps: Float32Array; _nWisps: number;
  _v: THREE.Vector3; _v2: THREE.Vector3; _v3: THREE.Vector3;
  _q: THREE.Quaternion;
  group: THREE.Group;
  atlas: THREE.CanvasTexture;
  norm: Pool;
  add: Pool;
  decals: Decals;
  smear: BladeSmear;
  _steamlets: Float32Array; _nSteamlets: number;
  _splats: number;
  _smearOn: boolean;
  _smearT?: number;
  _bt: THREE.Vector3; _bb: THREE.Vector3;
  _flares?: Flare[];
  _skid?: { t: number; x: number; z: number };
  // slash glints
  slashes!: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[];
  _slashNext!: number;
  // lightning
  bolts!: Bolt[];
  pillar!: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>;
  rings!: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[];
  flash!: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  light!: THREE.PointLight;
  strikes!: Strike[];
  _strikeNext!: number;

  constructor(game: Game) {
    this.game = game;
    this.scene = game.scene;
    this.time = 0;
    this._dt = 1 / 60;
    this._gasAcc = 0;
    this._lastSteam = -9; this._lastSteamPos = new THREE.Vector3();
    this._wisps = new Float32Array(3 * 96); this._nWisps = 0;
    this._v = new THREE.Vector3(); this._v2 = new THREE.Vector3(); this._v3 = new THREE.Vector3();
    this._q = new THREE.Quaternion();

    this.group = new THREE.Group();
    this.group.name = 'fx';
    this.scene.add(this.group);

    const atlas = makeAtlas();
    this.atlas = atlas;
    this.norm = new Pool(3300, atlas, false, 20);
    this.add = new Pool(800, atlas, true, 21);
    this.group.add(this.norm.mesh, this.add.mesh);

    this.decals = new Decals();
    this.smear = new BladeSmear();
    this.group.add(this.decals.mesh, this.smear.mesh);
    this._steamlets = new Float32Array(3 * 128); this._nSteamlets = 0;
    this._splats = 0;                       // splats queued this frame (throttle)
    this._smearOn = false;
    this._bt = new THREE.Vector3(); this._bb = new THREE.Vector3();

    this._initSlash();
    this._initLightning();
  }

  /** world ground height (0 when no collision world is available). */
  _ground(x: number, z: number): number {
    const c = this.game.collision;
    return c && c.groundHeight ? c.groundHeight(x, z) : 0;
  }

  _queueWisp(x: number, y: number, z: number): void {
    if (rnd() > 0.4 || this._nWisps >= 96) return;
    const i = this._nWisps++ * 3;
    this._wisps[i] = x; this._wisps[i + 1] = y; this._wisps[i + 2] = z;
  }

  _queueSteamlet(x: number, y: number, z: number): void {
    if (this._nSteamlets >= 128) return;
    const i = this._nSteamlets++ * 3;
    this._steamlets[i] = x; this._steamlets[i + 1] = y; this._steamlets[i + 2] = z;
  }

  _queueSplat(x: number, y: number, z: number, s: number): void {
    if (this._splats++ > 40) return;
    const r = s * rr(5, 8) + rr(0.15, 0.35);
    this.decals.add(0, x, y, z, r * rr(0.85, 1.25), r * rr(0.85, 1.25), rnd() * 6.2832, rr(2.1, 2.9));
  }

  /** free fraction of the normal pool (used to throttle bursty callers). */
  _free(): number { return 1 - this.norm.alive / this.norm.max; }

  // ───────────────────────── public emitters ─────────────────────────

  /**
   * Tether-gear gas jet: a fine white vapour that leaves the nozzle fast, slows in the air and thins out as it spreads.
   * `direction` = ejection direction (backwards from the nozzle). Call every frame while boosting.
   */
  gas(position: XYZ, direction?: XYZ | null, intensity = 1): void {
    const dir = direction || UP;
    intensity = clamp(intensity === undefined ? 1 : intensity, 0, 1.5);
    if (intensity <= 0.001) return;
    const P = this.norm;
    this._gasAcc += (70 + 110 * intensity) * intensity * Math.min(this._dt, 0.05);
    let guard = 0;
    while (this._gasAcc >= 1 && guard++ < 24) {
      this._gasAcc -= 1;
      const sp = rr(6, 12) * (0.7 + 0.5 * intensity);
      const sx = rr(-1, 1) * 0.12, sy = rr(-1, 1) * 0.12, sz = rr(-1, 1) * 0.12;
      const life = rr(0.45, 0.9) * (0.7 + 0.4 * intensity);
      const s1 = rr(0.55, 1.1) * (0.6 + 0.5 * intensity);
      const i = P.spawn(position.x + rr(-0.03, 0.03), position.y + rr(-0.03, 0.03), position.z + rr(-0.03, 0.03),
        (dir.x + sx) * sp, (dir.y + sy) * sp, (dir.z + sz) * sp,
        life, rr(0.08, 0.16), s1, rnd() < 0.75 ? TILE.PUFF : TILE.CLOUD_A);
      // dense right at the nozzle, then a thin haze: alpha falls fast as the puff grows
      P.color(i, C.gas, C.gasEnd, rr(0.42, 0.6), 0.04);
      P.phys(i, rr(3.4, 5.0), -0.35, rr(-1.0, 1.0), 0, 0);
      P.env(i, 0.03, 0.2, 0);
    }
  }

  /**
   * Titan steam: big white billowing clouds rising for `duration` s. One call = one staggered burst. `colors`
   * ([start, end] THREE.Color) tints it: smoke from fires, signal-flare smoke.
   */
  steam(position: XYZ, size = 3, duration = 3, colors: SmokeColors | null = null): void {
    const P = this.norm;
    size = Math.max(0.3, size);
    // thin out callers that fire every frame at the same spot
    let n = clamp(Math.round(5 + size * 2.2), 6, 42);
    if (this.time - this._lastSteam < 0.12 && this._lastSteamPos.distanceToSquared(position as THREE.Vector3) < size * size) n = Math.max(2, Math.round(n * 0.2));
    this._lastSteam = this.time; this._lastSteamPos.set(position.x, position.y, position.z);
    n = Math.round(n * clamp((this._free() - 0.08) / 0.4, 0, 1));
    // a slow, heavy rise: big volumes billow upwards rather than shoot
    const rise = clamp(0.7 + size * 0.16, 0.8, 3.4);
    for (let k = 0; k < n; k++) {
      const a = rnd() * 6.2832, rad = Math.sqrt(rnd()) * size * 0.42;
      const life = duration * rr(0.85, 1.4);
      const i = P.spawn(position.x + Math.cos(a) * rad, position.y + rr(0, size * 0.25), position.z + Math.sin(a) * rad,
        Math.cos(a) * rr(0.1, 0.45) + rr(-0.2, 0.2), rise * rr(0.6, 1.2), Math.sin(a) * rr(0.1, 0.45) + rr(-0.2, 0.2),
        life, size * rr(0.35, 0.6), size * rr(1.4, 2.3), rnd() < 0.5 ? TILE.CLOUD_A : TILE.CLOUD_B);
      // denser while small, a thin haze once it has spread: the alpha falls as the volume grows
      P.color(i, colors ? colors[0] : C.steam, colors ? colors[1] : C.steamEnd, rr(0.42, 0.62), 0.12);
      P.phys(i, rr(0.7, 1.05), -rr(0.1, 0.3) * (1 + size * 0.02), rr(-0.15, 0.15), 0, F_LIFT);
      P.rot[i] = rr(-0.5, 0.5);
      P.env(i, 0.25, 0.35, rnd() * duration * 0.45);
    }
    // a few thin wisps curling off the top
    for (let k = 0; k < (colors ? 0 : Math.min(4, n >> 3)); k++) {
      const i = P.spawn(position.x + rr(-1, 1) * size * 0.3, position.y, position.z + rr(-1, 1) * size * 0.3,
        rr(-0.3, 0.3), rise * rr(1.3, 1.8), rr(-0.3, 0.3), duration * rr(0.6, 1.0), size * 0.15, size * rr(0.6, 0.9), TILE.PUFF);
      P.color(i, C.steam, C.steamEnd, 0.3, 0.06); P.phys(i, 0.7, -0.2, 0, 0, 0); P.env(i, 0.2, 0.3, rnd() * duration * 0.3);
    }
  }

  /**
   * A signal flare (the Outriders' smoke rounds): a streak of coloured smoke shot up from `from` (tilted along
   * `dir` when given: a green round points the new course), bursting into a cloud that hangs in the sky.
   * color: a key of FLARE ('red', 'black', 'green', 'yellow', 'purple') or [start, end] colours.
   */
  flare(from: THREE.Vector3, color: FlareColor | string | SmokeColors = 'red', dir: THREE.Vector3 | null = null): void {
    const colors: SmokeColors = typeof color === 'string' ? FLARE[color as FlareColor] || FLARE.red : color;
    const v = new THREE.Vector3((R.fx() - 0.5) * 3, 70, (R.fx() - 0.5) * 3);
    if (dir) v.addScaledVector(_flareD.copy(dir).setY(0).normalize(), 32);
    (this._flares || (this._flares = [])).push({ p: from.clone(), v, t: 0, e: 0, colors });
  }
  _updateFlares(dt: number): void {
    const F = this._flares;
    if (!F) return;
    for (let i = F.length - 1; i >= 0; i--) {
      const f = F[i];
      f.t += dt; f.v.y -= 30 * dt; f.p.addScaledVector(f.v, dt);
      if ((f.e -= dt) <= 0) { f.e = 0.04; this.steam(f.p, 2.6, 9, f.colors); }
      if (f.t > 1.8) { for (let k = 0; k < 3; k++) this.steam(_flareD.set((R.fx() - 0.5) * 6, (R.fx() - 0.5) * 4, (R.fx() - 0.5) * 6).add(f.p), 11, 14, f.colors); F.splice(i, 1); }
    }
  }

  /** Titan blood: dark droplets that fall as short streaks, a little dark mist, fading into faint steam. */
  blood(position: XYZ, dirIn?: XYZ | null, size = 1): void {
    const direction = dirIn || UP;
    const P = this.norm;
    size = Math.max(0.2, size);
    let n = clamp(Math.round(10 + size * 10), 8, 50);
    n = Math.round(n * clamp((this._free() - 0.05) / 0.3, 0, 1));
    for (let k = 0; k < n; k++) {
      const sp = rr(3, 12) * (0.6 + 0.25 * Math.min(size, 3));
      const i = P.spawn(position.x, position.y, position.z,
        (direction.x + rr(-0.45, 0.45)) * sp, (direction.y + rr(-0.35, 0.55)) * sp, (direction.z + rr(-0.45, 0.45)) * sp,
        rr(1.0, 2.2), 0.06 * size * rr(0.6, 1.4) + 0.025, 0.05 * size * rr(0.5, 1.0) + 0.02, TILE.DROP);
      P.color(i, rnd() < 0.5 ? C.bloodA : C.bloodB, C.bloodB, 0.97, 0.92);
      P.phys(i, 0.35, 15, 0, 0.03, F_GROUND | F_WISP | F_SPLAT | (k & 1 ? F_STEAMY : 0));
      P.env(i, 0, 0.85, 0);
    }
    const m = clamp(Math.round(1 + size * 1.5), 1, 6);
    for (let k = 0; k < m; k++) {          // a fine dark mist, quickly gone
      const sp = rr(1, 3.5);
      const i = P.spawn(position.x, position.y, position.z, (direction.x + rr(-0.5, 0.5)) * sp, (direction.y + rr(-0.2, 0.7)) * sp, (direction.z + rr(-0.5, 0.5)) * sp,
        rr(0.5, 1.0), size * 0.2, size * rr(0.7, 1.2) + 0.3, TILE.PUFF);
      P.color(i, C.mistA, C.mistB, rr(0.22, 0.34), 0.04);
      P.phys(i, 2.6, 0.4, rr(-1, 1), 0, 0); P.env(i, 0.05, 0.2, 0);
    }
  }

  /** Hit/landing debris by material: 'stone' | 'wood' | 'bark' | 'roof' | 'ground' | 'metal' | 'flesh'. */
  impact(position: XYZ, normalIn?: XYZ | null, material: string = 'ground'): void {
    const P = this.norm;
    const N = normalIn || UP;
    const normal = N;
    const px = position.x, py = position.y, pz = position.z;
    // dust kicked up, slowed hard by the air, then sinking and spreading as it settles
    const dust = (n: number, c0: THREE.Color, big: number, ydrift: number): void => {
      for (let k = 0; k < n; k++) {
        const sp = rr(0.6, 3.2);
        const i = P.spawn(px, py, pz, (N.x + rr(-0.7, 0.7)) * sp, (N.y + rr(-0.4, 0.8)) * sp + ydrift, (N.z + rr(-0.7, 0.7)) * sp,
          rr(1.4, 2.4), big * rr(0.25, 0.4), big * rr(1.1, 1.8), TILE.DUST);
        P.color(i, c0, C.dustEnd, rr(0.45, 0.62), 0.1);
        P.phys(i, rr(2.6, 3.6), 0.45, rr(-0.8, 0.8), 0, F_LIFT); P.env(i, 0.06, 0.45, 0);
      }
    };
    const chips = (n: number, c0: THREE.Color, c1: THREE.Color, sizeMin: number, sizeMax: number, speed: number, stretch: number): void => {
      for (let k = 0; k < n; k++) {
        const sp = rr(0.4, 1) * speed;
        const i = P.spawn(px, py, pz, (N.x * 1.2 + rr(-0.8, 0.8)) * sp, (N.y * 1.2 + rr(-0.3, 1.0)) * sp, (N.z * 1.2 + rr(-0.8, 0.8)) * sp,
          rr(0.7, 1.4), rr(sizeMin, sizeMax), rr(sizeMin, sizeMax) * 0.9, TILE.CHIP);
        P.color(i, rnd() < 0.5 ? c0 : c1, c1, 1, 1);
        P.phys(i, 0.5, 15, rr(-12, 12), stretch, F_GROUND | F_BOUNCE); P.env(i, 0, 0.8, 0);
      }
    };
    switch (material) {
      case 'stone':
        chips(9, C.stone, C.stoneDark, 0.05, 0.12, 9, 0); dust(4, C.dustStone, 1.6, 0.3); this.sparks(position, normal, 5); break;
      case 'wood': case 'bark':
        chips(8, material === 'wood' ? C.wood : C.bark, C.woodDark, 0.04, 0.09, 8, 0.05); dust(3, C.dustDirt, 1.2, 0.2); break;
      case 'roof':
        chips(9, C.roof, C.stoneDark, 0.05, 0.11, 9, 0); dust(3, C.dustStone, 1.4, 0.2); break;
      case 'metal':
        this.sparks(position, normal, 14); break;
      case 'flesh':
        this.blood(position, normal, 0.6); break;
      default:   // ground
        dust(6, C.dustDirt, 2.4, 0.5); chips(4, C.dustDirt, C.woodDark, 0.05, 0.1, 5, 0);
    }
  }

  /** Sparks: short, hot, motion-stretched streaks that cool from white to orange as they fall (blade on metal / stone). */
  sparks(position: XYZ, normalIn?: XYZ | null, count = 14): void {
    const A = this.add;
    const N = normalIn || UP;
    for (let k = 0; k < count; k++) {
      const sp = rr(5, 16);
      const i = A.spawn(position.x, position.y, position.z, (N.x + rr(-0.9, 0.9)) * sp, (N.y + rr(-0.5, 1.1)) * sp, (N.z + rr(-0.9, 0.9)) * sp,
        rr(0.12, 0.38), rr(0.03, 0.045), rr(0.018, 0.028), TILE.SPARK);
      A.color(i, C.sparkHot, C.sparkEnd, 1, 0.75);
      A.phys(i, 1.6, 9.8, 0, 0.022, 0); A.env(i, 0, 0.5, 0);
    }
    const j = A.spawn(position.x, position.y, position.z, 0, 0, 0, 0.05, 0.12, 0.3, TILE.PUFF);
    A.color(j, C.sparkHot, C.sparkEnd, 0.6, 0); A.env(j, 0, 0.1, 0);
  }

  /** Green leaves fluttering. */
  leaves(position: XYZ, count = 12): void {
    const P = this.norm;
    count = Math.min(Math.round(count), 40);
    for (let k = 0; k < count; k++) {
      const i = P.spawn(position.x + rr(-1.5, 1.5), position.y + rr(-1, 1), position.z + rr(-1.5, 1.5),
        rr(-3, 3), rr(-0.5, 3), rr(-3, 3), rr(1.6, 3.2), rr(0.14, 0.26), rr(0.14, 0.26), TILE.LEAF);
      const r = rnd();
      P.color(i, r < 0.5 ? C.leafA : r < 0.8 ? C.leafC : C.leafB, r < 0.8 ? C.leafB : C.leafA, 1, 1);
      P.phys(i, 1.4, 2.6, rr(-7, 7), 0, F_FLUTTER | F_GROUND);
      P.env(i, 0, 0.8, 0);
    }
  }

  /**
   * Hard fast landing: a streak of low dust puffs along `direction` (horizontal travel direction) from `position`
   * (a point on the ground), and two boot-scrape marks gouged into the ground. `speed` in m/s scales the length.
   */
  skidDust(position: XYZ, direction?: XYZ | null, speed = 12): void {
    const P = this.norm;
    let dx = direction ? direction.x : 0, dz = direction ? direction.z : 1;
    const dl = Math.sqrt(dx * dx + dz * dz);
    if (dl < 1e-4) { dx = 0; dz = 1; } else { dx /= dl; dz /= dl; }
    const sx = -dz, sz = dx;                                 // side
    speed = Math.max(0, speed || 0);
    // called again while the same skid goes on (the core calls it every ~0.07 s while you slide): a lighter
    // continuation, a few puffs and the boot scrapes extended from where the last call left off
    const sk = this._skid || (this._skid = { t: -9, x: 0, z: 0 });
    const ddx = position.x - sk.x, ddz = position.z - sk.z, dd = Math.sqrt(ddx * ddx + ddz * ddz);
    const cont = this.time - sk.t < 0.25 && dd < 6;
    sk.t = this.time; sk.x = position.x; sk.z = position.z;
    if (cont) {
      const nn = Math.round(clamp(2 + speed * 0.12, 2, 5) * clamp((this._free() - 0.05) / 0.3, 0, 1));
      for (let k = 0; k < nn; k++) {
        const side = rr(-0.3, 0.3), x = position.x + sx * side, z = position.z + sz * side;
        const kick = rr(-1, 1) * (1 + speed * 0.05), sp = speed * rr(0.1, 0.3);
        const i = P.spawn(x, this._ground(x, z) + 0.1, z, dx * sp + sx * kick, rr(0.3, 1.2), dz * sp + sz * kick,
          rr(0.6, 1.2), rr(0.2, 0.4), rr(0.8, 1.5), TILE.DUST);
        P.color(i, C.dustDirt, C.dustEnd, rr(0.4, 0.58), 0.06); P.phys(i, rr(2.6, 3.8), 0.35, rr(-0.8, 0.8), 0, F_LIFT); P.env(i, 0.05, 0.3, 0);
      }
      if (dd > 0.08) {
        const ux = ddx / dd, uz = ddz / dd, rot = Math.atan2(uz, ux);
        for (let b = -1; b <= 1; b += 2) {
          const cx = position.x - ddx * 0.5 - uz * 0.17 * b, cz = position.z - ddz * 0.5 + ux * 0.17 * b;
          this.decals.add(1, cx, this._ground(cx, cz), cz, dd + 0.25, rr(0.15, 0.2), rot, rr(3.5, 4.5));
        }
      }
      return;
    }
    const len = clamp(speed * 0.28, 1.2, 7.5), slide = clamp(len / Math.max(speed * 0.5, 1), 0.15, 0.6);
    const n = Math.round(clamp(6 + speed * 0.55, 6, 22) * clamp((this._free() - 0.05) / 0.3, 0, 1));
    for (let k = 0; k < n; k++) {
      const f = n > 1 ? k / (n - 1) : 0, along = len * f, side = rr(-0.35, 0.35);
      const x = position.x + dx * along + sx * side, z = position.z + dz * along + sz * side;
      const y = this._ground(x, z) + 0.1;
      const sp = speed * rr(0.12, 0.3) * (1 - f * 0.6), kick = rr(-1, 1) * (1.5 + speed * 0.06);
      const i = P.spawn(x, y, z, dx * sp + sx * kick, rr(0.3, 1.4), dz * sp + sz * kick,
        rr(0.7, 1.4), rr(0.25, 0.45), rr(1.0, 1.9) * (0.7 + 0.3 * Math.min(speed / 25, 1.5)), TILE.DUST);
      P.color(i, C.dustDirt, C.dustEnd, rr(0.45, 0.65), 0.06);
      P.phys(i, rr(2.6, 3.8), 0.35, rr(-0.8, 0.8), 0, F_LIFT); P.env(i, 0.05, 0.3, f * slide);
    }
    // grit kicked forward
    for (let k = 0; k < Math.min(10, 3 + (speed * 0.25) | 0); k++) {
      const sp = speed * rr(0.15, 0.4);
      const i = P.spawn(position.x, this._ground(position.x, position.z) + 0.1, position.z, dx * sp + sx * rr(-2, 2), rr(1, 3.5), dz * sp + sz * rr(-2, 2),
        rr(0.5, 1.0), rr(0.04, 0.08), 0.05, TILE.CHIP);
      P.color(i, C.dustDirt, C.woodDark, 1, 1); P.phys(i, 0.6, 15, rr(-12, 12), 0, F_GROUND | F_BOUNCE); P.env(i, 0, 0.8, 0);
    }
    // two boot scrapes
    const rot = Math.atan2(dz, dx), ml = len * 0.85;
    for (let b = -1; b <= 1; b += 2) {
      const off = 0.17 * b + rr(-0.03, 0.03), cx = position.x + dx * ml * 0.5 + sx * off, cz = position.z + dz * ml * 0.5 + sz * off;
      this.decals.add(1, cx, this._ground(cx, cz), cz, ml * rr(0.85, 1.05), rr(0.16, 0.22), rot + rr(-0.04, 0.04), rr(3.5, 5));
    }
  }

  /** The anchor biting: a brief hot flash and a few sparks off the steel head (a puff of grit on soft surfaces). */
  hookBite(position: XYZ, normalIn?: XYZ | null, material: string = 'stone'): void {
    const A = this.add;
    const normal = normalIn || UP;
    if (material === 'flesh') return;
    const j = A.spawn(position.x, position.y, position.z, 0, 0, 0, 0.06, 0.15, 0.45, TILE.PUFF);
    A.color(j, C.sparkHot, C.sparkEnd, 0.7, 0); A.env(j, 0, 0.15, 0);
    this.sparks(position, normal, material === 'metal' || material === 'stone' ? 9 : 5);
  }

  /** The kill's hit moment (a short desaturated, darkened beat centred on the nape), drawn by ImpactFrame. */
  impactFrame(position: THREE.Vector3, strength = 1): void {
    this.game.impactFrame?.trigger?.(position, strength);
  }

  /** Feeds the blade smear one sample per blade (tip, hilt-side point; world). Effects.update does this for the
   *  player automatically during a slash; call this for any other swordsman, once per frame. */
  bladeSmear(tipL?: XYZ | null, baseL?: XYZ | null, tipR?: XYZ | null, baseR?: XYZ | null): void {
    if (tipL && baseL) this.smear.push(0, tipL, baseL, this.time);
    if (tipR && baseR) this.smear.push(1, tipR, baseR, this.time);
    this._smearT = this.time;
  }

  _updateSmear(): void {
    const p = this.game.player as unknown as SmearSource | undefined, m = p?.model, bl = m?.j?.blades;
    const slashT = p?.slashT ?? -1;
    const slashing = !!p && p.alive !== false && !!bl && ((slashT >= 0 && slashT < 0.3) || !!p.spin) && bl[0]?.visible !== false;
    if (slashing && bl) {
      if (!this._smearOn) this.smear.reset();
      this._smearOn = true;
      for (let b = 0; b < 2; b++) {
        const g = bl[b];
        g.updateWorldMatrix(true, false);
        this._bt.set(0, -1.02, 0).applyMatrix4(g.matrixWorld);
        this._bb.set(0, -0.32, 0).applyMatrix4(g.matrixWorld);
        this.smear.push(b, this._bt, this._bb, this.time);
      }
      this._smearT = this.time;
    } else this._smearOn = false;
    const age = this.time - (this._smearT ?? -9);
    if (age > 0.09) { this.smear.mesh.visible = false; return; }
    this.smear.build(this.time, 0.075, (p?.spin && !(slashT >= 0) ? 0.55 : 1) * (1 - smooth(0.02, 0.09, age)));
  }

  // ───────────────────────────── slash arc ─────────────────────────────
  _initSlash(): void {
    const N = 32, a0 = -1.15, a1 = 1.15, T = 0.3;
    const pos: number[] = [], uvs: number[] = [], idx: number[] = [];
    for (let i = 0; i <= N; i++) {
      const u = i / N, a = a0 + u * (a1 - a0), w = Math.pow(Math.sin(Math.PI * u), 0.75);
      pos.push(Math.cos(a), Math.sin(a), 0, Math.cos(a) * (1 - T * w), Math.sin(a) * (1 - T * w), 0);
      uvs.push(u, 0, u, 1);
      if (i < N) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    const base = new THREE.ShaderMaterial({
      uniforms: { uHead: { value: 0 }, uTail: { value: 0 }, uAlpha: { value: 1 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `varying vec2 vUv; uniform float uHead, uTail, uAlpha;
        void main(){
          float u = vUv.x, v = vUv.y;
          float vis = smoothstep(uTail - 0.02, uTail + 0.22, u) * (1.0 - smoothstep(uHead - 0.015, uHead + 0.01, u));
          float lead = smoothstep(uHead - 0.3, uHead, u);                  // brighter at the leading edge
          float core = smoothstep(0.22, 0.0, abs(v - 0.3));               // a thin line of light off the steel
          float haze = smoothstep(0.0, 0.2, v) * (1.0 - smoothstep(0.5, 1.0, v)) * 0.18;
          float a = vis * (core * 0.5 + haze) * (0.25 + 0.75 * lead) * uAlpha;
          gl_FragColor = vec4(vec3(0.9, 0.92, 0.95), a);
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false, fog: false,
    });
    this.slashes = [];
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(g, base.clone());
      m.visible = false; m.frustumCulled = false; m.renderOrder = 25; m.raycast = () => {};
      m.userData.age = 99;
      this.group.add(m);
      this.slashes.push(m);
    }
    this._slashNext = 0;
  }

  /**
   * A faint steel glint along the blade's path. The crescent lies in the XY plane of `quaternion` (local +Z = plane normal, so
   * pass camera.quaternion for a screen-facing slash; roll it about Z for diagonal cuts), centred on `position`,
   * bulging towards local +X, swept from -X/-Y up to +Y over ~0.18 s. `radius` in metres.
   */
  slashArc(position: THREE.Vector3, quaternion: THREE.Quaternion, radius = 2): void {
    const m = this.slashes[this._slashNext]; this._slashNext = (this._slashNext + 1) % this.slashes.length;
    m.position.copy(position); m.quaternion.copy(quaternion);
    m.scale.setScalar(radius);
    m.userData.age = 0; m.visible = true;
  }

  // ───────────────────────────── lightning ─────────────────────────────
  _initLightning(): void {
    // gradient across the ribbon width
    const cv = makeCanvas(); cv.width = 64; cv.height = 4;
    const cx = cv.getContext('2d') as CanvasRenderingContext2D;
    const gr = cx.createLinearGradient(0, 0, 64, 0);
    for (let i = 0; i <= 16; i++) { const t = i / 16; const a = Math.exp(-Math.pow((t - 0.5) * 2 * 1.9, 2)); gr.addColorStop(t, `rgba(255,255,255,${a.toFixed(3)})`); }
    cx.fillStyle = gr; cx.fillRect(0, 0, 64, 4);
    const boltTex = new THREE.CanvasTexture(cv);
    boltTex.colorSpace = THREE.NoColorSpace;
    this.bolts = [new Bolt(boltTex), new Bolt(boltTex)];
    for (const b of this.bolts) this.group.add(b.mesh);

    // light pillar (soft-edged cylinder)
    const pg = new THREE.CylinderGeometry(1, 1, 1, 24, 1, true);
    pg.translate(0, 0.5, 0);
    this.pillar = new THREE.Mesh(pg, new THREE.ShaderMaterial({
      uniforms: { uA: { value: 0 } },
      vertexShader: 'varying vec3 vN; varying vec3 vP; varying float vY; void main(){ vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position,1.0); vP = mv.xyz; vY = position.y; gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'varying vec3 vN; varying vec3 vP; varying float vY; uniform float uA; void main(){ float d = abs(dot(normalize(vN), normalize(-vP))); float a = pow(d, 1.6) * uA * (1.0 - 0.55 * vY); gl_FragColor = vec4(vec3(0.86, 0.9, 1.0) * a, a); }',
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false, fog: false,
    }));
    this.pillar.visible = false; this.pillar.frustumCulled = false; this.pillar.renderOrder = 28; this.pillar.raycast = () => {};
    this.group.add(this.pillar);

    // ground blast rings: a low band of dust pushed out across the ground
    const rg = new THREE.RingGeometry(0.8, 1, 96, 1);
    rg.rotateX(-Math.PI / 2);
    this.rings = [];
    for (let i = 0; i < 2; i++) {
      const m = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ color: 0xb6ab98, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, fog: true }));
      m.visible = false; m.frustumCulled = false; m.renderOrder = 27; m.raycast = () => {};
      this.group.add(m); this.rings.push(m);
    }

    // screen-filling flash + temporary light (the light exists permanently at intensity 0 so materials never recompile)
    this.flash = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: { uI: { value: 0 }, uC: { value: new THREE.Vector2() } },
      vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'varying vec2 vP; uniform float uI; uniform vec2 uC; void main(){ float d = length((vP - uC) * vec2(1.6, 1.0)); float g = 0.38 + 0.62 * exp(-d * 1.5); vec3 c = mix(vec3(0.8, 0.85, 1.0), vec3(1.0), smoothstep(0.0, 1.2, g)); float a = clamp(uI * g * 0.8, 0.0, 1.0); gl_FragColor = vec4(c, a); }',
      transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false,
    }));
    this.flash.frustumCulled = false; this.flash.renderOrder = 1000; this.flash.visible = false; this.flash.raycast = () => {};
    this.group.add(this.flash);
    this.light = new THREE.PointLight(0xdfe6ff, 0, 500, 2);
    this.light.castShadow = false;
    this.group.add(this.light);

    this.strikes = [];      // active lightning events
    for (let i = 0; i < 2; i++) this.strikes.push({ active: false, age: 0, x: 0, y: 0, z: 0, h: 5, R: 30, bolt: this.bolts[i], steamAcc: 0, seed: 1 });
    this._strikeNext = 0;
  }

  /** Titan transformation: sky bolt, flash, ground blast ring, dust wave and a steam column. `height` = titan height (m). */
  lightning(position: XYZ, height = 10): void {
    const s = this.strikes[this._strikeNext]; this._strikeNext = (this._strikeNext + 1) % this.strikes.length;
    s.active = true; s.age = 0; s.x = position.x; s.y = position.y; s.z = position.z; s.h = Math.max(2, height);
    s.R = clamp(s.h * 2.6, 24, 170); s.steamAcc = 0; s.seed = (R.fx() * 1000) | 0;
    this._buildBolt(s);
    // immediate: dust/steam burst
    const P = this.norm;
    const n = Math.round(clamp(18 + s.h * 1.4, 18, 70) * clamp((this._free() - 0.05) / 0.3, 0, 1));
    for (let k = 0; k < n; k++) {         // radial dust wave
      const a = (k / n) * 6.2832 + rr(-0.1, 0.1), sp = s.R * rr(0.55, 0.95);
      const i = P.spawn(s.x + Math.cos(a) * 1.5, s.y + 0.6, s.z + Math.sin(a) * 1.5, Math.cos(a) * sp, rr(0.5, 3), Math.sin(a) * sp,
        rr(1.0, 1.9), s.h * 0.18, s.h * rr(0.5, 0.9), TILE.DUST);
      P.color(i, C.dustEnd, C.steamEnd, 0.55, 0.1); P.phys(i, 2.6, -0.4, rr(-1, 1), 0, F_LIFT); P.env(i, 0.05, 0.3, 0);
    }
    this.steam(position, s.h * 0.55, 3.5);
  }

  _buildBolt(s: Strike): void {
    const b = s.bolt;
    const R = mulberry32(s.seed * 7919 + 13);
    const top = this._v.set(s.x + (R() - 0.5) * s.h * 3, s.y + 180 + s.h * 6, s.z + (R() - 0.5) * s.h * 3);
    let np = 0;
    b.start.length = 0; b.len.length = 0;
    const poly = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, segs: number, jitter: number, w0: number, w1: number): void => {
      b.start.push(np);
      const dx = bx - ax, dy = by - ay, dz = bz - az;
      // random walk perpendicular offsets, pinned at both ends
      let ox = 0, oz = 0;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const k = i === 0 || i === segs ? 0 : 1;
        ox += (R() - 0.5) * jitter * 1.6; oz += (R() - 0.5) * jitter * 1.6;
        ox *= 0.9; oz *= 0.9;
        const env = Math.sin(Math.PI * t);
        b.pts[np * 3] = ax + dx * t + ox * k * env; b.pts[np * 3 + 1] = ay + dy * t; b.pts[np * 3 + 2] = az + dz * t + oz * k * env;
        b.wid[np] = w0 + (w1 - w0) * t;
        np++;
      }
      b.len.push(segs + 1);
    };
    const segs = 34;
    poly(top.x, top.y, top.z, s.x, s.y, s.z, segs, (top.y - s.y) / segs * 0.9, 0.5 + s.h * 0.035, 0.2 + s.h * 0.025);
    // branches off the main stem
    const mainStart = 0;
    const nb = 4 + ((R() * 3) | 0);
    for (let k = 0; k < nb && np < MAX_BOLT_PTS - 14; k++) {
      const pi = mainStart + 5 + ((R() * (segs - 12)) | 0);
      const ax = b.pts[pi * 3], ay = b.pts[pi * 3 + 1], az = b.pts[pi * 3 + 2];
      const ang = R() * 6.2832, len = (top.y - s.y) * (0.05 + R() * 0.12);
      poly(ax, ay, az, ax + Math.cos(ang) * len * 0.8, ay - len * (0.4 + R() * 0.7), az + Math.sin(ang) * len * 0.8, 9, len * 0.12, 0.28 + s.h * 0.012, 0.03);
    }
    b.npts = np;
    // index buffer (two layers: glow then core)
    let vi = 0, ii = 0;
    const idx = b.index.array as Uint16Array;
    for (let layer = 0; layer < 2; layer++) {
      for (let p = 0; p < b.start.length; p++) {
        const base = vi;
        for (let i = 0; i < b.len[p]; i++) {
          if (i < b.len[p] - 1) {
            idx[ii++] = vi; idx[ii++] = vi + 1; idx[ii++] = vi + 2;
            idx[ii++] = vi + 1; idx[ii++] = vi + 3; idx[ii++] = vi + 2;
          }
          vi += 2;
        }
      }
    }
    b.nverts = vi; b.nidx = ii;
    b.index.needsUpdate = true;
    const uv = b.uv.array as Float32Array;
    for (let v = 0; v < vi; v += 2) { uv[v * 2] = 0; uv[v * 2 + 1] = 0; uv[v * 2 + 2] = 1; uv[v * 2 + 3] = 0; }
    b.uv.needsUpdate = true;
    b.mesh.geometry.setDrawRange(0, ii);
    b.mesh.visible = true;
    // colours: glow layer first (cool violet-blue, wide), core second (blue-white), as a real discharge reads
    const col = b.rgb.array as Float32Array;
    const half = vi / 2;
    for (let v = 0; v < vi; v++) {
      if (v < half) { col[v * 3] = 0.55; col[v * 3 + 1] = 0.6; col[v * 3 + 2] = 0.95; }
      else { col[v * 3] = 0.95; col[v * 3 + 1] = 0.97; col[v * 3 + 2] = 1; }
    }
    b.rgb.needsUpdate = true;
  }

  _updateBoltGeometry(b: Bolt, cam: THREE.Vector3, glowW: number, coreW: number): void {
    const pts = b.pts, wid = b.wid, P = b.pos.array as Float32Array;
    let vi = 0;
    const cx = cam.x, cy = cam.y, cz = cam.z;
    for (let layer = 0; layer < 2; layer++) {
      const wm = layer === 0 ? glowW : coreW;
      for (let p = 0; p < b.start.length; p++) {
        const s0 = b.start[p], n = b.len[p];
        for (let i = 0; i < n; i++) {
          const k = (s0 + i) * 3;
          const a = (s0 + Math.max(i - 1, 0)) * 3, c = (s0 + Math.min(i + 1, n - 1)) * 3;
          const tx = pts[c] - pts[a], ty = pts[c + 1] - pts[a + 1], tz = pts[c + 2] - pts[a + 2];
          const vx = cx - pts[k], vy = cy - pts[k + 1], vz = cz - pts[k + 2];
          let sx = ty * vz - tz * vy, sy = tz * vx - tx * vz, sz = tx * vy - ty * vx;
          const l = hypot(sx, sy, sz) || 1;
          // keep ribbon width roughly constant on screen at distance: widen with camera distance
          const dist = hypot(vx, vy, vz);
          const w = wid[s0 + i] * wm * (0.5 + Math.min(dist, 600) * 0.0035) / l;
          P[vi * 3] = pts[k] - sx * w; P[vi * 3 + 1] = pts[k + 1] - sy * w; P[vi * 3 + 2] = pts[k + 2] - sz * w;
          P[vi * 3 + 3] = pts[k] + sx * w; P[vi * 3 + 4] = pts[k + 1] + sy * w; P[vi * 3 + 5] = pts[k + 2] + sz * w;
          vi += 2;
        }
      }
    }
    b.pos.needsUpdate = true;
  }

  _updateLightning(dt: number): void {
    const cam = this.game.camera || _fallbackCam;
    let flash = 0, lightI = 0, fx = 0, fy = 0, any = false, pillarA = 0, ringsUsed = 0;
    for (let si = 0; si < this.strikes.length; si++) {
      const s = this.strikes[si];
      if (!s.active) continue;
      s.age += dt;
      const a = s.age;
      if (a > 2.2) { s.active = false; s.bolt.mesh.visible = false; this.rings[si].visible = false; continue; }
      any = true;
      // flicker pattern: strong first strike, two re-strikes
      const pulse = a < 0.06 ? 1 : a < 0.1 ? 0.35 : a < 0.17 ? 0.95 : a < 0.22 ? 0.3 : a < 0.3 ? 0.75 : Math.exp(-(a - 0.3) * 6) * 0.6;
      const boltVis = a < 0.6 ? pulse * (a < 0.35 ? 1 : 1 - (a - 0.35) / 0.25) : 0;
      // bolt
      const b = s.bolt;
      if (boltVis > 0.01) {
        b.mesh.visible = true;
        // slightly re-jitter the branches while it flickers
        this._updateBoltGeometry(b, cam.position, 1.0 + 3.2 * pulse, 0.9);
        b.mesh.material.color.setScalar(clamp(boltVis * 1.25, 0, 1.5));
      } else b.mesh.visible = false;
      // flash / light
      const f = (a < 0.1 ? 1 : 0.7 + 0.3 * Math.sin(a * 55)) * Math.exp(-a * 3.8);
      flash = Math.max(flash, f * 1.05);
      lightI = Math.max(lightI, f);
      if (f > 0.5 || !fx) {
        // flash centre follows the strike on screen
        this._v.set(s.x, s.y + s.h * 0.5, s.z).project(cam);
        if (this._v.z < 1) { fx = clamp(this._v.x, -1.5, 1.5); fy = clamp(this._v.y, -1.5, 1.5); }
      }
      // pillar
      const pa = a < 0.5 ? (a < 0.12 ? 1 : 0.8 * (1 - (a - 0.12) / 0.38)) : 0;
      if (pa > 0) { pillarA = Math.max(pillarA, pa); this.pillar.position.set(s.x, s.y, s.z); this.pillar.scale.set(s.h * 0.35 * (1 + a * 2), 400, s.h * 0.35 * (1 + a * 2)); }
      // rings
      const rg = this.rings[si];
      if (a < 1.1) {
        const t = a / 1.1, e = 1 - Math.pow(1 - t, 2.6);
        rg.visible = true; rg.position.set(s.x, s.y + 0.4, s.z); rg.scale.set(1 + s.R * e, 1, 1 + s.R * e);
        rg.material.opacity = Math.pow(1 - t, 1.6) * 0.45;
      } else rg.visible = false;
      // sustained steam column for ~1.4 s
      if (a < 1.4) {
        s.steamAcc += dt * (30 + s.h * 2.5) * (1 - a / 1.4);
        const P = this.norm;
        let guard = 0;
        while (s.steamAcc >= 1 && guard++ < 6) {
          s.steamAcc -= 1;
          if (this._free() < 0.12) break;
          const ang = rnd() * 6.2832, rad = Math.sqrt(rnd()) * s.h * 0.4;
          const i = P.spawn(s.x + Math.cos(ang) * rad, s.y + rr(0, s.h * 0.6), s.z + Math.sin(ang) * rad,
            Math.cos(ang) * rr(0.3, 2), rr(3, 6 + s.h * 0.5), Math.sin(ang) * rr(0.3, 2), rr(2.2, 4), s.h * rr(0.25, 0.4), s.h * rr(1.0, 1.6),
            rnd() < 0.5 ? TILE.CLOUD_A : TILE.CLOUD_B);
          P.color(i, C.steam, C.steamEnd, rr(0.55, 0.8), 0.3); P.phys(i, 0.7, -0.3, rr(-0.3, 0.3), 0, F_LIFT); P.env(i, 0.12, 0.45, 0);
        }
      }
    }
    this.pillar.visible = pillarA > 0;
    this.pillar.material.uniforms.uA.value = pillarA;
    this.flash.visible = flash > 0.004;
    this.flash.material.uniforms.uI.value = flash;
    this.flash.material.uniforms.uC.value.set(fx, fy);
    this.light.intensity = lightI * 6500;
    if (any || lightI > 0) {
      // light sits above the strike
      for (const s of this.strikes) if (s.active) { this.light.position.set(s.x, s.y + s.h * 1.2 + 6, s.z); break; }
    }
  }

  // ───────────────────────────── per-frame ─────────────────────────────
  update(dt: number): void {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.1);
    this._dt = dt;
    this.time += dt;
    this._nWisps = 0;
    this.norm.update(dt, this);
    this.add.update(dt, this);
    // blood wisps queued by dying droplets → faint steam
    for (let k = 0; k < this._nWisps; k++) {
      const x = this._wisps[k * 3], y = this._wisps[k * 3 + 1], z = this._wisps[k * 3 + 2];
      const i = this.norm.spawn(x, y, z, rr(-0.3, 0.3), rr(0.4, 1.0), rr(-0.3, 0.3), rr(0.9, 1.6), 0.25, rr(0.8, 1.4), TILE.CLOUD_A);
      this.norm.color(i, C.mistA, C.steam, 0.22, 0.1); this.norm.phys(i, 0.8, -0.35, rr(-0.5, 0.5), 0, 0); this.norm.env(i, 0.2, 0.3, 0);
    }
    this._nWisps = 0;
    // titan blood boiling off in flight
    for (let k = 0; k < this._nSteamlets; k++) {
      if (this._free() < 0.2) break;
      const x = this._steamlets[k * 3], y = this._steamlets[k * 3 + 1], z = this._steamlets[k * 3 + 2];
      const i = this.norm.spawn(x, y, z, rr(-0.2, 0.2), rr(0.5, 1.1), rr(-0.2, 0.2), rr(0.45, 0.8), 0.05, rr(0.25, 0.45), TILE.PUFF);
      this.norm.color(i, C.mistB, C.steam, 0.32, 0.05); this.norm.phys(i, 1.2, -0.4, 0, 0, 0); this.norm.env(i, 0.15, 0.3, 0);
    }
    this._nSteamlets = 0; this._splats = 0;
    this.decals.update(dt, this);
    this._updateSmear();
    // slash arcs
    for (const m of this.slashes) {
      if (!m.visible) continue;
      const u = m.userData;
      u.age += dt;
      const a = u.age, D = 0.2;
      if (a >= D) { m.visible = false; continue; }
      const head = 1.05 * (1 - Math.pow(1 - clamp(a / 0.085, 0, 1), 2.2));
      const tail = clamp((a - 0.03) / 0.17, 0, 1.15) * 1.1;
      const un = m.material.uniforms;
      un.uHead.value = head * 1.02; un.uTail.value = tail; un.uAlpha.value = 1 - smooth(0.1, 0.2, a);
    }
    this._updateLightning(dt);
    this._updateFlares(dt);
  }

  /** drop everything (scene change / restart). */
  clear(): void {
    for (const P of [this.norm, this.add]) { P.life.fill(0); (P.aPos.array as Float32Array).fill(0); P.high = 0; P.alive = 0; P.geo.instanceCount = 0; P.mesh.visible = false; }
    for (const s of this.strikes) { s.active = false; s.bolt.mesh.visible = false; }
    for (const m of this.slashes) m.visible = false;
    for (const r of this.rings) r.visible = false;
    if (this._flares) this._flares.length = 0;
    this.decals.clear(); this.smear.reset();
    this.game.impactFrame?.cancel?.();
    this.pillar.visible = false; this.flash.visible = false; this.light.intensity = 0;
  }
}
