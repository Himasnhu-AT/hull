// The particle system: pools per `vfx` config, one instanced draw per effect. Particles are simulated in the
// fixed step (so `game.step(n)` moves them and the cosmetic stream decides every spawn), and drawn each frame a
// fraction of a step ahead along their velocity, so they move smoothly at any refresh rate.
import {
  AdditiveBlending,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Float32BufferAttribute,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
} from 'three';
import { config } from '../config/index.ts';
import type { Node, Random, World } from '../core/index.ts';
import type { Vfx } from '../schema/vfx.ts';
import { compile, drawCount, look, Pool, spawnOne, type Compiled, type V3 } from './emitter.ts';

const VERT = /* glsl */ `
attribute vec4 aPosSize;
attribute vec4 aColor;
attribute vec4 aVelRot;
uniform float uFadeNear;
uniform float uStretch;
varying vec4 vColor;
varying vec2 vUv;
varying float vSeed;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(aPosSize.xyz, 1.0);
  float dist = -mvPosition.z;
  float size = aPosSize.w;
  vec2 c = position.xy;
  vec2 off;
  #ifdef STRETCH
    vec3 vv = mat3(modelViewMatrix) * aVelRot.xyz;
    float sp = length(vv.xy);
    if (sp > 1e-4) {
      vec2 ax = vv.xy / sp;
      off = ax * c.x * (size + sp * uStretch) + vec2(-ax.y, ax.x) * c.y * size;
    } else off = c * size;
  #else
    float cs = cos(aVelRot.w);
    float sn = sin(aVelRot.w);
    off = vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs) * size;
  #endif
  mvPosition.xy += off;
  vColor = aColor;
  if (uFadeNear > 0.0) vColor.a *= smoothstep(0.0, uFadeNear, dist);
  vUv = c * 2.0;
  vSeed = aVelRot.w;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
varying vec4 vColor;
varying vec2 vUv;
varying float vSeed;
#include <fog_pars_fragment>
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  float r = length(vUv);
  float a;
  #if SPRITE == 1
    a = 1.0 - smoothstep(0.82, 1.0, r);
  #elif SPRITE == 2
    float soft = 1.0 - smoothstep(0.0, 1.0, r);
    float n = vnoise(vUv * 2.2 + vSeed * 5.0) * 0.65 + vnoise(vUv * 5.0 - vSeed * 3.0) * 0.35;
    a = clamp(soft * 1.6 - (1.0 - n) * 0.55, 0.0, 1.0);
  #elif SPRITE == 3
    a = (1.0 - smoothstep(0.0, 1.0, abs(vUv.y))) * (1.0 - smoothstep(0.35, 1.0, abs(vUv.x)));
    a = a * a;
  #else
    a = 1.0 - smoothstep(0.0, 1.0, r);
    a *= a;
  #endif
  a *= vColor.a;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vColor.rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

const SPRITE_ID = { soft: 0, hard: 1, smoke: 2, spark: 3 } as const;

class Effect {
  readonly id: string;
  c: Compiled;
  pool: Pool;
  readonly geometry = new InstancedBufferGeometry();
  readonly material: ShaderMaterial;
  readonly mesh: Mesh;
  private posSize: InstancedBufferAttribute;
  private color: InstancedBufferAttribute;
  private velRot: InstancedBufferAttribute;
  private readonly tmp = new Float32Array(5);
  private unwatch: (() => void) | null = null;

  constructor(id: string, value: Vfx, parent: Node) {
    this.id = id;
    this.c = compile(value);
    this.pool = new Pool(this.c.max);
    const g = this.geometry;
    g.setAttribute('position', new Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.posSize = new InstancedBufferAttribute(new Float32Array(this.c.max * 4), 4).setUsage(DynamicDrawUsage);
    this.color = new InstancedBufferAttribute(new Float32Array(this.c.max * 4), 4).setUsage(DynamicDrawUsage);
    this.velRot = new InstancedBufferAttribute(new Float32Array(this.c.max * 4), 4).setUsage(DynamicDrawUsage);
    g.setAttribute('aPosSize', this.posSize);
    g.setAttribute('aColor', this.color);
    g.setAttribute('aVelRot', this.velRot);
    g.instanceCount = 0;
    this.material = new ShaderMaterial({
      uniforms: UniformsUtils.merge([UniformsLib.fog, { uFadeNear: { value: 0 }, uStretch: { value: 0 } }]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new Mesh(g, this.material);
    // Bounds of a swarm are unknown to three; culling it as one sphere at the origin would hide it.
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    parent.object3d.add(this.mesh);
    this.applyMaterial();
    this.unwatch = config.watch(id, (now) => this.reload(now as Vfx));
  }

  private applyMaterial(): void {
    const c = this.c;
    const m = this.material;
    m.defines = { SPRITE: SPRITE_ID[c.sprite] };
    if (c.stretch > 0) m.defines['STRETCH'] = '';
    m.blending = c.blend === 'additive' ? AdditiveBlending : NormalBlending;
    // Additive light fades to nothing in fog, not to the fog's colour, so it is left out of the fog pass.
    m.fog = c.blend !== 'additive';
    m.uniforms['uFadeNear']!.value = c.fadeNear;
    m.uniforms['uStretch']!.value = c.stretch;
    m.needsUpdate = true;
  }

  /** Live edit: the maths and look change at once; a different budget makes a new pool and drops live particles. */
  private reload(value: Vfx): void {
    const next = compile(value);
    if (next.max !== this.pool.capacity) {
      this.pool = new Pool(next.max);
      this.posSize = new InstancedBufferAttribute(new Float32Array(next.max * 4), 4).setUsage(DynamicDrawUsage);
      this.color = new InstancedBufferAttribute(new Float32Array(next.max * 4), 4).setUsage(DynamicDrawUsage);
      this.velRot = new InstancedBufferAttribute(new Float32Array(next.max * 4), 4).setUsage(DynamicDrawUsage);
      this.geometry.setAttribute('aPosSize', this.posSize);
      this.geometry.setAttribute('aColor', this.color);
      this.geometry.setAttribute('aVelRot', this.velRot);
    }
    this.c = next;
    this.applyMaterial();
  }

  /** Writes every live particle into the GPU buffers, `ahead` seconds along its velocity. */
  upload(ahead: number): void {
    const p = this.pool;
    const n = p.count;
    const c = this.c;
    const t = this.tmp;
    const ps = this.posSize.array as Float32Array;
    const col = this.color.array as Float32Array;
    const vr = this.velRot.array as Float32Array;
    for (let i = 0; i < n; i++) {
      look(p, c, i, t);
      const o = i * 4;
      ps[o] = p.px[i]! + p.vx[i]! * ahead;
      ps[o + 1] = p.py[i]! + p.vy[i]! * ahead;
      ps[o + 2] = p.pz[i]! + p.vz[i]! * ahead;
      ps[o + 3] = t[0]!;
      col[o] = t[1]!; col[o + 1] = t[2]!; col[o + 2] = t[3]!; col[o + 3] = t[4]!;
      vr[o] = p.vx[i]!; vr[o + 1] = p.vy[i]!; vr[o + 2] = p.vz[i]!; vr[o + 3] = p.rot[i]!;
    }
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      for (const a of [this.posSize, this.color, this.velRot]) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * 4);
        a.needsUpdate = true;
      }
    }
  }

  dispose(): void {
    this.unwatch?.();
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** A burst spread over time: `left` particles still to start, at one place. */
interface Job {
  active: boolean;
  fx: Effect | null;
  x: number; y: number; z: number;
  aimed: boolean;
  dx: number; dy: number; dz: number;
  left: number;
  perSecond: number;
  carry: number;
}

export interface TrailHandle {
  /** Stops emitting. Particles already in the air finish their life. */
  stop(): void;
  readonly active: boolean;
}

interface Trail extends TrailHandle {
  fx: Effect;
  node: Node;
  last: V3;
  carry: number;
  on: boolean;
}

export interface VfxStats {
  /** Live particles over every effect. */
  live: number;
  /** Capacity over every effect that has been used. */
  capacity: number;
  spawned: number;
  /** Particles skipped because their effect's pool was full. */
  dropped: number;
  /** Instanced draws this frame (effects with at least one live particle). */
  drawCalls: number;
  effects: Record<string, { live: number; capacity: number; spawned: number; dropped: number }>;
}

const JOBS = 64;
const warned = new Set<string>();

export class VfxSystem {
  private readonly effects = new Map<string, Effect>();
  private readonly list: Effect[] = [];
  private readonly jobs: Job[] = [];
  private readonly trails: Trail[] = [];
  private readonly rng: Random;
  private stepDt = 1 / 60;
  private readonly pos: V3 = { x: 0, y: 0, z: 0 };
  private readonly aim: V3 = { x: 0, y: 0, z: 0 };

  constructor(private readonly world: World) {
    this.rng = world.random('cosmetic');
    for (let i = 0; i < JOBS; i++) this.jobs.push({ active: false, fx: null, x: 0, y: 0, z: 0, aimed: false, dx: 0, dy: 0, dz: 0, left: 0, perSecond: 0, carry: 0 });
    world.system('vfx', {
      fixedUpdate: (dt) => this.fixed(dt),
      update: (_dt, alpha) => this.frame(alpha),
    });
  }

  private effect(id: string): Effect | undefined {
    const full = id.startsWith('vfx/') ? id : `vfx/${id}`;
    let fx = this.effects.get(full);
    if (fx) return fx;
    let value: Vfx;
    try {
      value = config.lookup('vfx', full.slice(4));
    } catch {
      if (!warned.has(full)) {
        warned.add(full);
        console.warn(`[hull] vfx: "${full}" does not exist (expected config/${full}.json); nothing is drawn for it.`);
      }
      return undefined;
    }
    fx = new Effect(full, value, this.world.root);
    this.effects.set(full, fx);
    this.list.push(fx);
    return fx;
  }

  /** Starts one burst at `at`. `dir` aims the effect's cone. With `emit.over`, the particles start over that time. */
  burst(id: string, at: V3, dir?: V3): void {
    const fx = this.effect(id);
    if (!fx) return;
    const n = drawCount(fx.c, this.rng);
    if (fx.c.over > 0 && n > 0) {
      for (let i = 0; i < JOBS; i++) {
        const j = this.jobs[i]!;
        if (j.active) continue;
        j.active = true; j.fx = fx; j.x = at.x; j.y = at.y; j.z = at.z;
        j.aimed = dir !== undefined;
        if (dir) { j.dx = dir.x; j.dy = dir.y; j.dz = dir.z; }
        j.left = n; j.perSecond = n / fx.c.over; j.carry = 0;
        return;
      }
      // Every slot is busy: start it all now instead of losing it.
    }
    for (let i = 0; i < n; i++) spawnOne(fx.pool, fx.c, this.rng, at.x, at.y, at.z, dir);
  }

  /** Emits `emit.rate` particles a second along the path of `node` until stopped or the node is destroyed. */
  trail(id: string, node: Node): TrailHandle {
    const fx = this.effect(id);
    const t: Trail = {
      fx: fx as Effect,
      node,
      last: { x: 0, y: 0, z: 0 },
      carry: 0,
      on: fx !== undefined,
      stop() { this.on = false; },
      get active() { return this.on; },
    };
    if (fx) {
      this.nodePos(node, t.last);
      this.trails.push(t);
    }
    return t;
  }

  private nodePos(node: Node, out: V3): void {
    node.object3d.updateWorldMatrix(true, false);
    const e = node.object3d.matrixWorld.elements;
    out.x = e[12]!; out.y = e[13]!; out.z = e[14]!;
  }

  private fixed(dt: number): void {
    this.stepDt = dt;
    const rng = this.rng;
    // Bursts spread over time.
    for (let i = 0; i < JOBS; i++) {
      const j = this.jobs[i]!;
      if (!j.active) continue;
      j.carry += j.perSecond * dt;
      let k = Math.floor(j.carry);
      j.carry -= k;
      if (k > j.left) k = j.left;
      const fx = j.fx!;
      if (j.aimed) { this.aim.x = j.dx; this.aim.y = j.dy; this.aim.z = j.dz; }
      for (let n = 0; n < k; n++) spawnOne(fx.pool, fx.c, rng, j.x, j.y, j.z, j.aimed ? this.aim : undefined);
      j.left -= k;
      if (j.left <= 0) { j.active = false; j.fx = null; }
    }
    // Trails: particles are laid evenly along the line from where the node was to where it is.
    const tr = this.trails;
    for (let i = tr.length - 1; i >= 0; i--) {
      const t = tr[i]!;
      if (!t.on || t.node.destroyed) { tr[i] = tr[tr.length - 1]!; tr.pop(); t.on = false; continue; }
      const p = this.pos;
      this.nodePos(t.node, p);
      t.carry += t.fx.c.rate * dt;
      const k = Math.floor(t.carry);
      t.carry -= k;
      for (let n = 1; n <= k; n++) {
        const f = n / k;
        spawnOne(t.fx.pool, t.fx.c, rng, t.last.x + (p.x - t.last.x) * f, t.last.y + (p.y - t.last.y) * f, t.last.z + (p.z - t.last.z) * f, undefined);
      }
      t.last.x = p.x; t.last.y = p.y; t.last.z = p.z;
    }
    for (let i = 0; i < this.list.length; i++) {
      const fx = this.list[i]!;
      fx.pool.step(fx.c, dt);
    }
  }

  private frame(alpha: number): void {
    const ahead = alpha * this.stepDt;
    for (let i = 0; i < this.list.length; i++) this.list[i]!.upload(ahead);
  }

  stats(): VfxStats {
    const s: VfxStats = { live: 0, capacity: 0, spawned: 0, dropped: 0, drawCalls: 0, effects: {} };
    for (const fx of this.list) {
      const p = fx.pool;
      s.live += p.count;
      s.capacity += p.capacity;
      s.spawned += p.spawned;
      s.dropped += p.dropped;
      if (p.count > 0) s.drawCalls++;
      s.effects[fx.id] = { live: p.count, capacity: p.capacity, spawned: p.spawned, dropped: p.dropped };
    }
    return s;
  }

  /** Removes every live particle and pending burst. */
  clear(): void {
    for (const fx of this.list) fx.pool.clear();
    for (const j of this.jobs) { j.active = false; j.fx = null; }
    this.trails.length = 0;
  }

  dispose(): void {
    for (const fx of this.list) fx.dispose();
    this.list.length = 0;
    this.effects.clear();
    this.trails.length = 0;
  }
}
