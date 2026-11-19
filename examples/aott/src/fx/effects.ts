// AOTT: visual effects.
//
// Particle effects (steam, gas, blood, dust, chips, sparks, leaves, skid dust, the lightning dust wave, flare smoke)
// are `vfx` configs in config/vfx/*.json, played through hull/vfx; this file only decides which one to play and with
// what count, size and speed. What stays in code because a particle emitter cannot say it: ground decals (blood
// splats, boot scrapes), the blade smear, the slash arcs, the lightning bolt ribbon, the light pillar, the dust
// rings, the screen flash and the strike light.
//
// HOW THE CORE CALLS IT
//   const fx = new Effects(game);              // after game.scene / game.camera / game.collision exist
//   fx.update(dt);                              // once per step (after titans / player)
import * as THREE from 'hull/three';
import type { Game } from '../types';
import { R } from '../sim';
import { makeCanvas } from '../canvas';
import { mountVfx, vfx, type VfxView } from 'hull/vfx';

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

const col = (hex: number): THREE.Color => new THREE.Color(hex);
/** Signal-flare smoke: [start, end] colours. Red: a titan; black: an abnormal; green: the new course; yellow: done. */
export const FLARE: Record<FlareColor, [THREE.Color, THREE.Color]> = {
  red: [col(0xe8432f), col(0x8a4038)], black: [col(0x1c1a19), col(0x4a4644)], green: [col(0x4cc46a), col(0x4a7d58)],
  yellow: [col(0xf2d24e), col(0xb9a564)], purple: [col(0x9a5ad0), col(0x66507e)],
};
const _flareD = new THREE.Vector3();
const _fallbackCam = new THREE.PerspectiveCamera();
const UP = new THREE.Vector3(0, 1, 0);
// Scratch for calls into vfx, so a burst allocates nothing.
const _p = { x: 0, y: 0, z: 0 }, _d = { x: 0, y: 0, z: 1 };
const _o = { count: 1, size: 1, speed: 1, life: 1, spread: 1 };
const opt = (count: number, size: number, speed: number, life: number, spread: number): typeof _o => {
  _o.count = count; _o.size = size; _o.speed = speed; _o.life = life; _o.spread = spread; return _o;
};
const at = (p: XYZ): typeof _p => { _p.x = p.x; _p.y = p.y; _p.z = p.z; return _p; };

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
    const A = this.aA.array as Float32Array, B = this.aB.array as Float32Array, Cc = this.aC.array as Float32Array;
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
            const s = this.size[i];
            // a steam puff off the drying blood: the steam config at the size and life this puff had
            fx._puff(this.x[i] + rr(-s * 0.35, s * 0.35), this.y[i] + 0.05, this.z[i] + rr(-s * 0.35, s * 0.35), (0.3 + s * 0.6) / 5.5, 0.3, s * 0.35 / 1.26);
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
  _v: THREE.Vector3; _v2: THREE.Vector3; _v3: THREE.Vector3;
  _q: THREE.Quaternion;
  group: THREE.Group;
  view: VfxView;
  decals: Decals;
  smear: BladeSmear;
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
    this._v = new THREE.Vector3(); this._v2 = new THREE.Vector3(); this._v3 = new THREE.Vector3();
    this._q = new THREE.Quaternion();

    this.group = new THREE.Group();
    this.group.name = 'fx';
    this.scene.add(this.group);

    // The particles are Hull's: configs under config/vfx, drawn by the render bridge. They see the ground through us.
    this.view = mountVfx(game.hull);
    vfx.setGround((gx, gz) => this._ground(gx, gz));

    this.decals = new Decals();
    this.smear = new BladeSmear();
    this.group.add(this.decals.mesh, this.smear.mesh);
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

  _queueSplat(x: number, y: number, z: number, s: number): void {
    if (this._splats++ > 40) return;
    const r = s * rr(5, 8) + rr(0.15, 0.35);
    this.decals.add(0, x, y, z, r * rr(0.85, 1.25), r * rr(0.85, 1.25), rnd() * 6.2832, rr(2.1, 2.9));
  }

  /** One steam puff at a point (the drying blood decals call this). */
  _puff(x: number, y: number, z: number, size: number, life: number, spread: number): void {
    _p.x = x; _p.y = y; _p.z = z;
    vfx.burst('steam', _p, undefined, opt(1, size, 0.6, life, spread));
  }

  /** The id of the steam config that has these colours (the flare colours), else the plain one. */
  _steamId(colors: SmokeColors | null): string {
    if (colors) for (const k of Object.keys(FLARE) as FlareColor[]) if (FLARE[k] === colors || FLARE[k][0] === colors[0]) return 'steam-' + k;
    return 'steam';
  }

  // ───────────────────────── public emitters ─────────────────────────

  /**
   * Tether-gear gas jet: a fine white vapour that leaves the nozzle fast, slows in the air and thins out as it spreads.
   * `direction` = ejection direction (backwards from the nozzle). Call every frame while boosting.
   */
  gas(position: XYZ, direction?: XYZ | null, intensity = 1): void {
    const dir = direction || UP;
    intensity = clamp(intensity === undefined ? 1 : intensity, 0, 1.5);
    if (intensity <= 0.001) return;
    this._gasAcc += (70 + 110 * intensity) * intensity * Math.min(this._dt, 0.05);
    const n = Math.min(24, Math.floor(this._gasAcc));
    this._gasAcc -= Math.floor(this._gasAcc);
    if (n < 1) return;
    vfx.burst('gas', at(position), dir, opt(n, 0.6 + 0.5 * intensity, 0.7 + 0.5 * intensity, 0.7 + 0.4 * intensity, 1));
  }

  /**
   * Titan steam: big white billowing clouds rising for `duration` s. One call = one staggered burst. `colors`
   * ([start, end] THREE.Color) tints it: smoke from fires, signal-flare smoke.
   */
  steam(position: XYZ, size = 3, duration = 3, colors: SmokeColors | null = null): void {
    size = Math.max(0.3, size);
    // thin out callers that fire every frame at the same spot
    let n = clamp(Math.round(5 + size * 2.2), 6, 42);
    if (this.time - this._lastSteam < 0.12 && this._lastSteamPos.distanceToSquared(position as THREE.Vector3) < size * size) n = Math.max(2, Math.round(n * 0.2));
    this._lastSteam = this.time; this._lastSteamPos.set(position.x, position.y, position.z);
    // a slow, heavy rise: big volumes billow upwards rather than shoot
    const rise = clamp(0.7 + size * 0.16, 0.8, 3.4);
    vfx.burst(this._steamId(colors), at(position), UP, opt(n, size / 3, rise / 1.18, duration / 3, size / 3));
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
    size = Math.max(0.2, size);
    const n = clamp(Math.round(10 + size * 10), 8, 50);
    const sp = 0.6 + 0.25 * Math.min(size, 3);
    vfx.burst('blood', at(position), direction, opt(n, size, sp, 1, 1));
    // The droplets die where they land; the stain they leave is a decal, laid down when a sample drop would land.
    const g0 = this._ground(position.x, position.z);
    for (let k = 0; k < 3; k++) {
      const s = rr(3, 12) * sp;
      const vx = (direction.x + rr(-0.45, 0.45)) * s, vy = (direction.y + rr(-0.35, 0.55)) * s, vz = (direction.z + rr(-0.45, 0.45)) * s;
      const h = Math.max(0, position.y - g0);
      const t = (vy + Math.sqrt(vy * vy + 30 * h)) / 15;
      if (!(t > 0) || t > 2) continue;
      const lx = position.x + vx * t * 0.85, lz = position.z + vz * t * 0.85;
      const sz = 0.06 * size + 0.025;
      this.game.hull.world.after(t, () => this._queueSplat(lx, this._ground(lx, lz), lz, sz));
    }
    const m = clamp(Math.round(1 + size * 1.5), 1, 6);
    vfx.burst('blood-mist', _p, direction, opt(m, size, 1, 1, 1));
  }

  /** Hit/landing debris by material: 'stone' | 'wood' | 'bark' | 'roof' | 'ground' | 'metal' | 'flesh'. */
  impact(position: XYZ, normalIn?: XYZ | null, material: string = 'ground'): void {
    const N = normalIn || UP;
    switch (material) {
      case 'stone':
        this._chips('chip-stone', position, N, 9); this._dust('dust-stone', position, N, 4, 1.6); this.sparks(position, N, 5); break;
      case 'wood': this._chips('chip-wood', position, N, 8); this._dust('dust-dirt', position, N, 3, 1.2); break;
      case 'bark': this._chips('chip-bark', position, N, 8); this._dust('dust-dirt', position, N, 3, 1.2); break;
      case 'roof': this._chips('chip-roof', position, N, 9); this._dust('dust-stone', position, N, 3, 1.4); break;
      case 'metal': this.sparks(position, N, 14); break;
      case 'flesh': this.blood(position, N, 0.6); break;
      default:   // ground
        this._dust('dust-dirt', position, N, 6, 2.4); this._chips('chip-dirt', position, N, 4);
    }
  }
  _chips(id: string, p: XYZ, n: XYZ, count: number): void { vfx.burst(id, at(p), n, opt(count, 1, 1, 1, 1)); }
  /** Dust kicked up, slowed hard by the air, then sinking and spreading as it settles. `big` is the puff's size in metres. */
  _dust(id: string, p: XYZ, n: XYZ, count: number, big: number): void { vfx.burst(id, at(p), n, opt(count, big / 2, 1, 1, 1)); }

  /** Sparks: short, hot, motion-stretched streaks that cool from white to orange as they fall (blade on metal / stone). */
  sparks(position: XYZ, normalIn?: XYZ | null, count = 14): void {
    const N = normalIn || UP;
    vfx.burst('sparks', at(position), N, opt(count, 1, 1, 1, 1));
    vfx.burst('spark-flash', _p, undefined, opt(1, 1, 1, 1, 1));
  }

  /** Green leaves fluttering. */
  leaves(position: XYZ, count = 12): void {
    vfx.burst('leaves', at(position), undefined, opt(Math.min(Math.round(count), 40), 1, 1, 1, 1));
  }

  /**
   * Hard fast landing: a streak of low dust puffs along `direction` (horizontal travel direction) from `position`
   * (a point on the ground), and two boot-scrape marks gouged into the ground. `speed` in m/s scales the length.
   */
  skidDust(position: XYZ, direction?: XYZ | null, speed = 12): void {
    let dx = direction ? direction.x : 0, dz = direction ? direction.z : 1;
    const dl = Math.sqrt(dx * dx + dz * dz);
    if (dl < 1e-4) { dx = 0; dz = 1; } else { dx /= dl; dz /= dl; }
    const sx = -dz, sz = dx;                                 // side
    speed = Math.max(0, speed || 0);
    _d.x = dx; _d.y = 0.15; _d.z = dz;
    const sizeK = 0.7 + 0.3 * Math.min(speed / 25, 1.5);
    // called again while the same skid goes on (the core calls it every ~0.07 s while you slide): a lighter
    // continuation, a few puffs and the boot scrapes extended from where the last call left off
    const sk = this._skid || (this._skid = { t: -9, x: 0, z: 0 });
    const ddx = position.x - sk.x, ddz = position.z - sk.z, dd = Math.sqrt(ddx * ddx + ddz * ddz);
    const cont = this.time - sk.t < 0.25 && dd < 6;
    sk.t = this.time; sk.x = position.x; sk.z = position.z;
    if (cont) {
      const nn = Math.round(clamp(2 + speed * 0.12, 2, 5));
      for (let k = 0; k < nn; k++) {
        const side = rr(-0.3, 0.3), x = position.x + sx * side, z = position.z + sz * side;
        _p.x = x; _p.y = this._ground(x, z) + 0.1; _p.z = z;
        vfx.burst('skid-dust', _p, _d, opt(1, 1, speed * 0.1, 1, 1));
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
    const len = clamp(speed * 0.28, 1.2, 7.5);
    const n = Math.round(clamp(6 + speed * 0.55, 6, 22));
    for (let k = 0; k < n; k++) {
      const f = n > 1 ? k / (n - 1) : 0, along = len * f, side = rr(-0.35, 0.35);
      const x = position.x + dx * along + sx * side, z = position.z + dz * along + sz * side;
      _p.x = x; _p.y = this._ground(x, z) + 0.1; _p.z = z;
      vfx.burst('skid-dust', _p, _d, opt(1, sizeK, speed * 0.1 * (1 - f * 0.6), 1, 1));
    }
    // grit kicked forward
    _d.y = 0.6;
    _p.x = position.x; _p.y = this._ground(position.x, position.z) + 0.1; _p.z = position.z;
    vfx.burst('chip-dirt', _p, _d, opt(Math.min(10, 3 + ((speed * 0.25) | 0)), 0.8, speed * 0.077, 1, 1));
    // two boot scrapes
    const rot = Math.atan2(dz, dx), ml = len * 0.85;
    for (let b = -1; b <= 1; b += 2) {
      const off = 0.17 * b + rr(-0.03, 0.03), cx = position.x + dx * ml * 0.5 + sx * off, cz = position.z + dz * ml * 0.5 + sz * off;
      this.decals.add(1, cx, this._ground(cx, cz), cz, ml * rr(0.85, 1.05), rr(0.16, 0.22), rot + rr(-0.04, 0.04), rr(3.5, 5));
    }
  }

  /** The anchor biting: a brief hot flash and a few sparks off the steel head (a puff of grit on soft surfaces). */
  hookBite(position: XYZ, normalIn?: XYZ | null, material: string = 'stone'): void {
    const normal = normalIn || UP;
    if (material === 'flesh') return;
    vfx.burst('spark-flash', at(position), undefined, opt(1, 1.4, 1, 1, 1));
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
    // immediate: the radial dust wave, then a steam column
    const n = Math.round(clamp(18 + s.h * 1.4, 18, 70));
    _p.x = s.x; _p.y = s.y + 0.6; _p.z = s.z;
    vfx.burst('lightning-dust', _p, undefined, opt(n, s.h, s.R, 1, 1));
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
        const n = Math.min(6, Math.floor(s.steamAcc));
        s.steamAcc -= n;
        if (n > 0) {
          _p.x = s.x; _p.y = s.y + s.h * 0.3; _p.z = s.z;
          vfx.burst('steam', _p, UP, opt(n, s.h * 1.3 / 5.5, 4.3 + s.h * 0.1, 1.1, s.h * 0.32));
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
    vfx.clear();
    for (const s of this.strikes) { s.active = false; s.bolt.mesh.visible = false; }
    for (const m of this.slashes) m.visible = false;
    for (const r of this.rings) r.visible = false;
    if (this._flares) this._flares.length = 0;
    this.decals.clear(); this.smear.reset();
    this.game.impactFrame?.cancel?.();
    this.pillar.visible = false; this.flash.visible = false; this.light.intensity = 0;
  }
}
