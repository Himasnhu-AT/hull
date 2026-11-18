// Particles on the WebGPU backend. Two things live here, both written in TSL:
//   * `makeCpuMaterial`: the same look as the WebGL2 ShaderMaterial in system.ts, fed by the same CPU-filled
//     instance buffers. Effects with a small budget keep their CPU simulation (deterministic, easy to test).
//   * `GpuParticles`: the whole particle life on the GPU. A spawn kernel starts particles in a ring of slots, an update
//     kernel moves them each fixed step, and the vertex shader reads the buffers directly; the CPU only says how many
//     to start and where. Used for big budgets, where the CPU loop and the buffer upload are what would cost.
// This file is only ever loaded on the WebGPU backend (system.ts imports it dynamically), so the node materials never
// meet the WebGL renderer.
import {
  AdditiveBlending,
  Color,
  Float32BufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NodeMaterial,
  NormalBlending,
  Vector3,
  Vector4,
  type Fog,
  type FogExp2,
  type WebGPURenderer,
} from 'three/webgpu';
import * as TSLModule from 'three/tsl';
import type { Compiled, Sprite, V3 } from './emitter.ts';
import { LUT } from './curves.ts';

// TSL's own typings cannot follow its operator chaining, so the shader code is typed loosely on purpose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { attribute, cameraProjectionMatrix, clamp, cos, exp, float, floor, fract, Fn, If, instancedArray, instanceIndex, int, length, max, min, mix, modelViewMatrix,   normalize, positionLocal, pow, select, sin, smoothstep, sqrt, uint, uniform, uniformArray, varying, vec2, vec3, vec4, abs, } = TSLModule as any;

// TSL's own typings cannot follow its operator chaining, so the shader code below is typed loosely on purpose.
/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

const SPRITE_ID: Record<Sprite, number> = { soft: 0, hard: 1, smoke: 2, spark: 3 };

/** What the fragment stage needs to fog a particle the way three's fog does (by distance from the camera). */
export interface FogState {
  mode: 0 | 1 | 2;
  color: Color;
  near: number;
  far: number;
  density: number;
}

export function fogStateOf(fog: Fog | FogExp2 | null, out: FogState): FogState {
  if (fog === null) { out.mode = 0; return out; }
  out.color.copy(fog.color);
  if ((fog as FogExp2).isFogExp2) { out.mode = 2; out.density = (fog as FogExp2).density; }
  else { out.mode = 1; out.near = (fog as Fog).near; out.far = (fog as Fog).far; }
  return out;
}

export function newFogState(): FogState {
  return { mode: 0, color: new Color(), near: 0, far: 1000, density: 0 };
}

/** Shared pieces of both materials: the uniforms and the fragment shading. */
function common(c: Compiled) {
  const u = {
    fadeNear: uniform(c.fadeNear),
    stretch: uniform(c.stretch),
    fogMode: uniform(0),
    fogColor: uniform(new Color()),
    fogNear: uniform(0),
    fogFar: uniform(1000),
    fogDensity: uniform(0),
  };

  const h21 = (p0: N) => {
    const p = fract(p0.mul(vec2(123.34, 456.21)));
    const q = p.add(p.x.mul(p.x.add(45.32)).add(p.y.mul(p.y.add(45.32))));
    return fract(q.x.mul(q.y));
  };
  const vnoise = (p: N) => {
    const i = floor(p);
    const f0 = fract(p);
    const f = f0.mul(f0).mul(float(3).sub(f0.mul(2)));
    return mix(mix(h21(i), h21(i.add(vec2(1, 0))), f.x), mix(h21(i.add(vec2(0, 1))), h21(i.add(vec2(1, 1))), f.x), f.y);
  };
  /** The sprite's opacity from its position on the quad (-1..1) and a per-particle seed. */
  const sprite = (kind: number, uv: N, seed: N): N => {
    const r = length(uv);
    if (kind === 1) return float(1).sub(smoothstep(0.82, 1, r));
    if (kind === 2) {
      const soft = float(1).sub(smoothstep(0, 1, r));
      const n = vnoise(uv.mul(2.2).add(seed.mul(5))).mul(0.65).add(vnoise(uv.mul(5).sub(seed.mul(3))).mul(0.35));
      return clamp(soft.mul(1.6).sub(float(1).sub(n).mul(0.55)), 0, 1);
    }
    if (kind === 3) {
      const a = float(1).sub(smoothstep(0, 1, abs(uv.y))).mul(float(1).sub(smoothstep(0.35, 1, abs(uv.x))));
      return a.mul(a);
    }
    const a = float(1).sub(smoothstep(0, 1, r));
    return a.mul(a);
  };
  /** Distance-based fog on the colour, like three's fog_fragment (additive effects skip it, as on WebGL2). */
  const fogged = (rgb: N, depth: N, additive: boolean): N => {
    if (additive) return rgb;
    const lin = smoothstep(u.fogNear, u.fogFar, depth);
    const e2 = float(1).sub(exp(u.fogDensity.negate().mul(u.fogDensity).mul(depth).mul(depth)));
    const f = select(u.fogMode.equal(2), e2, select(u.fogMode.equal(1), lin, float(0)));
    return mix(rgb, u.fogColor, f);
  };
  return { u, sprite, fogged };
}

/**
 * The particle quad's vertex and fragment shading, given where each particle's data comes from. `src` returns nodes for
 * position and size (xyz, w), colour and alpha (rgb, a) and velocity and rotation (xyz, w), per instance.
 */
function buildMaterial(c: Compiled, src: () => { posSize: N; color: N; velRot: N }): { material: NodeMaterial; u: ReturnType<typeof common>['u'] } {
  const { u, sprite, fogged } = common(c);
  const additive = c.blend === 'additive';
  const stretchOn = c.stretch > 0;
  const material = new NodeMaterial();

  const data = src();
  const mv: N = modelViewMatrix.mul(vec4(data.posSize.xyz, 1)).toVar();
  const dist = mv.z.negate();
  const size = data.posSize.w;
  const quadPos = positionLocal.xy;
  let off: N;
  if (stretchOn) {
    const vv = modelViewMatrix.mul(vec4(data.velRot.xyz, 0)).xyz;
    const sp = length(vv.xy);
    const ax = vv.xy.div(max(sp, 1e-6));
    const stretched = ax.mul(quadPos.x.mul(size.add(sp.mul(u.stretch)))).add(vec2(ax.y.negate(), ax.x).mul(quadPos.y.mul(size)));
    off = select(sp.greaterThan(1e-4), stretched, quadPos.mul(size));
  } else {
    const cs = cos(data.velRot.w);
    const sn = sin(data.velRot.w);
    off = vec2(quadPos.x.mul(cs).sub(quadPos.y.mul(sn)), quadPos.x.mul(sn).add(quadPos.y.mul(cs))).mul(size);
  }
  const placed = vec4(mv.xy.add(off), mv.z, 1);
  material.vertexNode = cameraProjectionMatrix.mul(placed);

  const nearFade = select(u.fadeNear.greaterThan(0), smoothstep(0, max(u.fadeNear, 1e-4), dist), float(1));
  const vColor = varying(vec4(data.color.rgb, data.color.a.mul(nearFade)), 'vColor');
  const vUv = varying(quadPos.mul(2), 'vUv');
  const vSeed = varying(data.velRot.w, 'vSeed');
  const vDepth = varying(dist, 'vDepth');
  const a = sprite(SPRITE_ID[c.sprite], vUv, vSeed).mul(vColor.a);
  material.fragmentNode = vec4(fogged(vColor.rgb, vDepth, additive), a);

  material.transparent = true;
  material.depthWrite = false;
  material.fog = false;
  material.blending = additive ? AdditiveBlending : NormalBlending;
  return { material, u };
}

function quadGeometry(): InstancedBufferGeometry {
  const g = new InstancedBufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.instanceCount = 0;
  return g;
}

function applyFog(u: ReturnType<typeof common>['u'], f: FogState): void {
  u.fogMode.value = f.mode;
  (u.fogColor.value as Color).copy(f.color);
  u.fogNear.value = f.near;
  u.fogFar.value = f.far;
  u.fogDensity.value = f.density;
}

/** The material for an effect whose particles the CPU simulates: the same instance attributes system.ts fills. */
export function makeCpuMaterial(c: Compiled): { material: NodeMaterial; setFog(f: FogState): void; setCompiled(c: Compiled): void } {
  const built = buildMaterial(c, () => ({
    posSize: attribute('aPosSize', 'vec4'),
    color: attribute('aColor', 'vec4'),
    velRot: attribute('aVelRot', 'vec4'),
  }));
  return {
    material: built.material,
    setFog: (f) => applyFog(built.u, f),
    setCompiled: (n) => { built.u.fadeNear.value = n.fadeNear; built.u.stretch.value = n.stretch; },
  };
}

/** Effects with at least this budget are simulated on the GPU when the backend can compute. */
export const GPU_MIN_BUDGET = 2048;

/** The parts of an effect that change the compiled shader; when one changes the GPU effect is rebuilt. */
export function structureKey(c: Compiled): string {
  return `${c.shape.kind}|${c.cone.outward}|${c.sprite}|${c.blend}|${c.stretch > 0}|${c.max}`;
}

interface SpawnRequest {
  tick: number;
  count: number;
  start: number;
  x: number; y: number; z: number;
  aimed: boolean;
  dx: number; dy: number; dz: number;
  seed: number;
}

const QUEUE = 256;
/** Fixed steps run per frame at most; more than this (a test stepping thousands at once) is folded into the last. */
const MAX_STEPS = 600;

export class GpuParticles {
  readonly geometry = quadGeometry();
  readonly mesh: Mesh;
  readonly material: NodeMaterial;
  private readonly max: number;
  private c: Compiled;
  private readonly posAge: N;
  private readonly velLife: N;
  private readonly misc: N;
  private readonly lutA: Vector4[] = [];
  private readonly lutB: Vector4[] = [];
  private readonly lutAN: N;
  private readonly lutBN: N;
  private readonly spawnKernel: N;
  private readonly updateKernel: N;
  private readonly fogU: ReturnType<typeof common>['u'];
  private readonly p = {
    start: uniform(0, 'uint'),
    seed: uniform(0, 'uint'),
    origin: uniform(new Vector3()),
    axis: uniform(new Vector3(0, 1, 0)),
    cosAngle: uniform(-1),
    shapeR: uniform(0),
    box: uniform(new Vector3()),
    speed: uniform(new Vector3()), // min, max
    life: uniform(new Vector3()), // min, max
    size: uniform(new Vector3()), // scale min, max
    spin: uniform(new Vector3()), // min, max
    glow: uniform(1),
    dt: uniform(1 / 60),
    drag: uniform(0),
    gravity: uniform(0),
    ahead: uniform(0),
  };
  private readonly queue: SpawnRequest[] = [];
  private queued = 0;
  private ticks = 0;
  private head = 0;
  private total = 0;
  /** Spawn log for the live estimate: when (in game seconds) and how many. */
  private readonly log: { t: number; n: number }[] = [];
  private clock = 0;
  dropped = 0;

  constructor(c: Compiled) {
    this.c = c;
    this.max = c.max;
    const max = c.max;
    this.posAge = instancedArray(max, 'vec4');
    this.velLife = instancedArray(max, 'vec4');
    this.misc = instancedArray(max, 'vec4');
    for (let i = 0; i < LUT; i++) { this.lutA.push(new Vector4()); this.lutB.push(new Vector4()); }
    this.lutAN = uniformArray(this.lutA, 'vec4');
    this.lutBN = uniformArray(this.lutB, 'vec4');
    for (let i = 0; i < QUEUE; i++) this.queue.push({ tick: 0, count: 0, start: 0, x: 0, y: 0, z: 0, aimed: false, dx: 0, dy: 0, dz: 0, seed: 0 });

    const built = buildMaterial(c, () => this.vertexSource());
    this.material = built.material;
    this.fogU = built.u;
    this.spawnKernel = this.buildSpawn().compute(1);
    this.updateKernel = this.buildUpdate().compute(max);
    this.spawnKernel.setName('hull.vfx.spawn');
    this.updateKernel.setName('hull.vfx.update');
    this.mesh = new Mesh(this.geometry, this.material);
    // The swarm's bounds are unknown to three; culling it as one sphere at the origin would hide it.
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;
    this.apply(c);
  }

  /** Numeric parameters of the compiled effect, as uniforms: a live edit costs nothing and keeps the particles. */
  apply(c: Compiled): void {
    this.c = c;
    const p = this.p;
    p.cosAngle.value = c.cone.cosAngle;
    (p.axis.value as Vector3).set(c.cone.x, c.cone.y, c.cone.z);
    p.shapeR.value = c.shape.r;
    (p.box.value as Vector3).set(c.shape.bx, c.shape.by, c.shape.bz);
    (p.speed.value as Vector3).set(c.speedMin, c.speedMax, 0);
    (p.life.value as Vector3).set(c.lifeMin, c.lifeMax, 0);
    (p.size.value as Vector3).set(c.sizeMin, c.sizeMax, 0);
    (p.spin.value as Vector3).set(c.spinMin, c.spinMax, 0);
    p.glow.value = c.glow;
    p.drag.value = c.drag;
    p.gravity.value = c.gravity;
    this.fogU.fadeNear.value = c.fadeNear;
    this.fogU.stretch.value = c.stretch;
    for (let i = 0; i < LUT; i++) {
      this.lutA[i]!.set(c.lut[i * 5]!, c.lut[i * 5 + 1]!, c.lut[i * 5 + 2]!, c.lut[i * 5 + 3]!);
      this.lutB[i]!.set(c.lut[i * 5 + 4]!, 0, 0, 0);
    }
  }

  setFog(f: FogState): void {
    applyFog(this.fogU, f);
  }

  /** Where the vertex stage reads each particle: the storage buffers, with the colour curves looked up by age. */
  private vertexSource(): { posSize: N; color: N; velRot: N } {
    const i = instanceIndex;
    const pa = this.posAge.element(i);
    const vl = this.velLife.element(i);
    const ms = this.misc.element(i);
    const age = pa.w;
    const life = vl.w;
    const alive = select(age.lessThan(life), float(1), float(0));
    const t = clamp(age.div(max(life, 1e-4)), 0, 1);
    const f = t.mul(LUT - 1);
    const i0 = floor(f);
    const i1 = min(i0.add(1), LUT - 1);
    const k = f.sub(i0);
    const a0 = this.lutAN.element(int(i0));
    const a1 = this.lutAN.element(int(i1));
    const b0 = this.lutBN.element(int(i0));
    const b1 = this.lutBN.element(int(i1));
    const lutRgbSize: N = mix(a0, a1, k);
    const alpha = mix(b0.x, b1.x, k);
    const pos = pa.xyz.add(vl.xyz.mul(this.p.ahead));
    const size = lutRgbSize.x.mul(ms.x).mul(alive);
    const rgb = lutRgbSize.yzw.mul(this.p.glow);
    return {
      posSize: vec4(pos, size),
      color: vec4(rgb, alpha.mul(alive)),
      velRot: vec4(vl.xyz, ms.y),
    };
  }

  /** The spawn kernel: thread k starts the particle in ring slot (start + k), drawing its numbers from a hash. */
  private buildSpawn(): N {
    const c = this.c;
    const p = this.p;
    const cap = this.max;
    return Fn(() => {
      const k = instanceIndex;
      const slot = p.start.add(k).mod(uint(cap));
      // PCG hash chain: each call gives one fresh uniform number in [0,1).
      const pcg = (v: N) => {
        const s = v.mul(uint(747796405)).add(uint(2891336453));
        const w = s.shiftRight(s.shiftRight(uint(28)).add(uint(4))).bitXor(s).mul(uint(277803737));
        return w.shiftRight(uint(22)).bitXor(w);
      };
      const base = pcg(k.add(p.seed.mul(uint(2654435761))));
      let n = 0;
      const rnd = (): N => {
        n++;
        return float(pcg(base.add(uint(Math.imul(n, 1013904223) >>> 0)))).mul(1 / 4294967296);
      };
      const r0 = rnd(), r1 = rnd(), r2 = rnd();
      let off: N = vec3(0, 0, 0);
      if (c.shape.kind === 'sphere') {
        const z = r0.mul(2).sub(1);
        const phi = r1.mul(Math.PI * 2);
        const s = sqrt(max(float(0), float(1).sub(z.mul(z))));
        const rad = p.shapeR.mul(pow(r2, 1 / 3));
        off = vec3(cos(phi).mul(s).mul(rad), z.mul(rad), sin(phi).mul(s).mul(rad));
      } else if (c.shape.kind === 'disc') {
        const phi = r1.mul(Math.PI * 2);
        const rad = p.shapeR.mul(sqrt(r0));
        off = vec3(cos(phi).mul(rad), 0, sin(phi).mul(rad));
      } else if (c.shape.kind === 'box') {
        off = vec3(r0.sub(0.5).mul(p.box.x), r1.sub(0.5).mul(p.box.y), r2.sub(0.5).mul(p.box.z));
      }
      const u = rnd(), w = rnd();
      let dir: N;
      if (c.cone.outward) {
        const len = length(off);
        const z = u.mul(2).sub(1);
        const s = sqrt(max(float(0), float(1).sub(z.mul(z))));
        const ph = w.mul(Math.PI * 2);
        dir = select(len.greaterThan(1e-6), off.div(max(len, 1e-6)), vec3(cos(ph).mul(s), z, sin(ph).mul(s)));
      } else {
        const ax = normalize(p.axis);
        const cosT = float(1).sub(u.mul(float(1).sub(p.cosAngle)));
        const sinT = sqrt(max(float(0), float(1).sub(cosT.mul(cosT))));
        const phi = w.mul(Math.PI * 2);
        // Any vector not parallel to the axis gives a perpendicular pair.
        const bRaw = select(abs(ax.y).lessThan(0.9), vec3(ax.z.negate(), 0, ax.x), vec3(0, ax.z, ax.y.negate()));
        const b = normalize(bRaw);
        const cc = vec3(ax.y.mul(b.z).sub(ax.z.mul(b.y)), ax.z.mul(b.x).sub(ax.x.mul(b.z)), ax.x.mul(b.y).sub(ax.y.mul(b.x)));
        dir = ax.mul(cosT).add(b.mul(cos(phi).mul(sinT))).add(cc.mul(sin(phi).mul(sinT)));
      }
      const speed = mix(p.speed.x, p.speed.y, rnd());
      const life = mix(p.life.x, p.life.y, rnd());
      const scale = mix(p.size.x, p.size.y, rnd());
      const rot = rnd().mul(Math.PI * 2);
      const spin = mix(p.spin.x, p.spin.y, rnd());
      this.posAge.element(slot).assign(vec4(p.origin.add(off), 0));
      this.velLife.element(slot).assign(vec4(dir.mul(speed), life));
      this.misc.element(slot).assign(vec4(scale, rot, spin, 0));
    })();
  }

  /** The update kernel: one fixed step for every live particle (the same maths as Pool.step). */
  private buildUpdate(): N {
    const p = this.p;
    return Fn(() => {
      const i = instanceIndex;
      const pa = this.posAge.element(i).toVar();
      const vl = this.velLife.element(i).toVar();
      const ms = this.misc.element(i).toVar();
      If(pa.w.lessThan(vl.w), () => {
        const a = pa.w.add(p.dt);
        If(a.greaterThanEqual(vl.w), () => {
          // Past its life: age meets life, which is what "dead" is.
          this.posAge.element(i).assign(vec4(pa.xyz, vl.w));
        }).Else(() => {
          // Drag as an exponential, so the result does not depend on the step length.
          const keep = exp(p.drag.negate().mul(p.dt));
          const v = vec3(vl.x.mul(keep), vl.y.mul(keep).add(p.gravity.mul(p.dt)), vl.z.mul(keep));
          this.posAge.element(i).assign(vec4(pa.xyz.add(v.mul(p.dt)), a));
          this.velLife.element(i).assign(vec4(v, vl.w));
          this.misc.element(i).assign(vec4(ms.x, ms.y.add(ms.z.mul(p.dt)), ms.z, ms.w));
        });
      });
    })();
  }

  /** Asks for `count` particles at `at` during the fixed step number `this.ticks` of this frame. */
  spawn(count: number, x: number, y: number, z: number, dir: V3 | undefined, seed: number): void {
    if (count <= 0) return;
    const n = Math.min(count, this.max);
    if (this.queued >= QUEUE) { this.dropped += n; return; }
    const r = this.queue[this.queued++]!;
    r.tick = this.ticks;
    r.count = n;
    r.start = this.head;
    r.x = x; r.y = y; r.z = z;
    r.aimed = dir !== undefined;
    if (dir) { r.dx = dir.x; r.dy = dir.y; r.dz = dir.z; }
    r.seed = seed >>> 0;
    this.head = (this.head + n) % this.max;
    this.total += n;
    this.log.push({ t: this.clock, n });
  }

  /** Marks the end of a fixed step: spawns queued before it run before the update that belongs to it. */
  endTick(dt: number): void {
    this.ticks++;
    this.clock += dt;
    // Keep only what can still be alive.
    const horizon = this.clock - this.c.lifeMax;
    while (this.log.length > 0 && this.log[0]!.t < horizon) this.log.shift();
  }

  /** Runs this frame's spawns and steps on the GPU, then points the draw at the live range. */
  frame(renderer: WebGPURenderer, dt: number, ahead: number): void {
    const p = this.p;
    const steps = Math.min(this.ticks, MAX_STEPS);
    // Steps beyond the cap are dropped from the front: the effect is cosmetic, and a test that steps 10,000 ticks at
    // once only cares that the last stretch is simulated.
    const skipped = this.ticks - steps;
    p.dt.value = dt;
    let q = 0;
    for (let t = 0; t < this.ticks; t++) {
      while (q < this.queued && this.queue[q]!.tick <= t) {
        this.runSpawn(renderer, this.queue[q]!);
        q++;
      }
      if (t >= skipped) renderer.compute(this.updateKernel);
    }
    while (q < this.queued) this.runSpawn(renderer, this.queue[q++]!);
    this.ticks = 0;
    this.queued = 0;
    p.ahead.value = ahead;
    const live = Math.min(this.total, this.max);
    this.geometry.instanceCount = live;
    this.mesh.visible = live > 0;
  }

  private runSpawn(renderer: WebGPURenderer, r: SpawnRequest): void {
    const p = this.p;
    p.start.value = r.start;
    p.seed.value = r.seed;
    (p.origin.value as Vector3).set(r.x, r.y, r.z);
    if (r.aimed) {
      const len = Math.hypot(r.dx, r.dy, r.dz);
      if (len > 1e-6) (p.axis.value as Vector3).set(r.dx / len, r.dy / len, r.dz / len);
    } else {
      (p.axis.value as Vector3).set(this.c.cone.x, this.c.cone.y, this.c.cone.z);
    }
    this.spawnKernel.count = r.count;
    renderer.compute(this.spawnKernel);
  }

  /** An estimate of live particles: those spawned within one mean life, fading out across the life range. */
  liveEstimate(): number {
    const c = this.c;
    let live = 0;
    for (const e of this.log) {
      const age = this.clock - e.t;
      const f = age <= c.lifeMin ? 1 : age >= c.lifeMax ? 0 : 1 - (age - c.lifeMin) / Math.max(1e-6, c.lifeMax - c.lifeMin);
      live += e.n * f;
    }
    return Math.min(this.max, Math.round(live));
  }

  get spawned(): number { return this.total; }

  /** For the bench page and tests: reads back the first `n` particles (position and age, velocity and life). Slow; not for a frame. */
  async debugRead(renderer: WebGPURenderer, n: number): Promise<{ posAge: number[]; velLife: number[] }> {
    const r = renderer as unknown as { getArrayBufferAsync(a: unknown): Promise<ArrayBuffer> };
    const pa = new Float32Array(await r.getArrayBufferAsync(this.posAge.value)).slice(0, n * 4);
    const vl = new Float32Array(await r.getArrayBufferAsync(this.velLife.value)).slice(0, n * 4);
    return { posAge: Array.from(pa), velLife: Array.from(vl) };
  }

  clear(): void {
    this.head = 0;
    this.total = 0;
    this.queued = 0;
    this.ticks = 0;
    this.log.length = 0;
    this.geometry.instanceCount = 0;
    this.mesh.visible = false;
    // Dead is "age has reached life"; zeroing the buffers on the GPU is a kernel away, and nothing is drawn past
    // instanceCount, so stale slots are never shown. They are overwritten as the ring fills again.
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
