// The WebGPU post chain: the same passes as post.ts, written as TSL nodes and drawn with full-screen quads.
//   bloom      bright-pass, a pyramid of blurred halves, tent upsample
//   composite  bloom added, tone mapped, then in display space: lift/gamma/gain, contrast, saturation, vignette, grain
//   fxaa       optional, on the finished picture (three's own FXAA 3.11 node)
// The maths is copied pass for pass from the GLSL, so the two backends differ only where TSL and GLSL differ in
// rounding. Targets and materials are rebuilt when the size or the switches change, never per frame.
import {
  ColorManagement,
  HalfFloatType,
  LinearFilter,
  NodeMaterial,
  NoToneMapping,
  QuadMesh,
  RenderTarget,
  UnsignedByteType,
  Vector2,
  Vector3,
  type Camera,
  type Scene,
  type Texture,
  type TextureDataType,
  type ToneMapping,
  type WebGPURenderer,
} from 'three/webgpu';
import * as TSLModule from 'three/tsl';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import type { ResolvedPost } from './look.ts';
import type { PostFx } from './postfx.ts';

// TSL's own typings cannot follow its operator chaining, so the shader code is typed loosely on purpose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { clamp, float, Fn, max, min, mix, pow, screenCoordinate, smoothstep, step, texture, toneMapping, uniform, uv, vec2, vec3, vec4, fract } = TSLModule as any;

function target(w: number, h: number, type: TextureDataType = HalfFloatType, samples = 0, depth = false): RenderTarget {
  const t = new RenderTarget(w, h, { type, samples, depthBuffer: depth, minFilter: LinearFilter, magFilter: LinearFilter, generateMipmaps: false });
  t.texture.name = 'hull.post';
  return t;
}

function quad(fragment: unknown): QuadMesh {
  const m = new NodeMaterial();
  m.fragmentNode = fragment as never;
  m.depthTest = false;
  m.depthWrite = false;
  return new QuadMesh(m);
}

/** Sampler of `tex` at `uvNode` (a TSL node). */
const sample = (tex: Texture, uvNode: unknown) => texture(tex).sample(uvNode as never);

export class WebGPUPostChain {
  private w = 0;
  private h = 0;
  private samples = -1;
  private levels = -1;
  private tone: ToneMapping = -1 as ToneMapping;
  private bloomOn = false;
  private fxaaOn = false;
  private speedOn = false;
  private sceneRT: RenderTarget | null = null;
  private ldrRT: RenderTarget | null = null;
  private downs: RenderTarget[] = [];
  private ups: RenderTarget[] = [];
  private bright: QuadMesh | null = null;
  private downQuads: QuadMesh[] = [];
  private upQuads: QuadMesh[] = [];
  private composite: QuadMesh | null = null;
  private fxaaQuad: QuadMesh | null = null;
  private fxaaNode: unknown = null;
  private frame = 0;

  // Uniforms the passes read; changing them needs no rebuild.
  private readonly u = {
    threshold: uniform(1),
    bloom: uniform(0),
    contrast: uniform(1),
    saturation: uniform(1),
    vignette: uniform(0),
    grain: uniform(0),
    seed: uniform(0),
    aspect: uniform(1),
    exposure: uniform(1),
    speed: uniform(0),
    time: uniform(0),
    impact: uniform(0),
    impactC: uniform(new Vector2(0.5, 0.5)),
    lift: uniform(new Vector3(0, 0, 0)),
    gamma: uniform(new Vector3(1, 1, 1)),
    gain: uniform(new Vector3(1, 1, 1)),
  };

  constructor(private readonly renderer: WebGPURenderer) {}

  /**
   * Sizes in device pixels. Cheap to call every frame: it only rebuilds when something changed. `bloom` and `fxaa`
   * say which optional passes this frame needs, `tone` is the three tone-mapping constant.
   */
  prepare(w: number, h: number, samples: number, levels: number, bloom: boolean, useFxaa: boolean, tone: ToneMapping, speedOn = false): void {
    if (w === this.w && h === this.h && samples === this.samples && levels === this.levels && bloom === this.bloomOn && useFxaa === this.fxaaOn && tone === this.tone && speedOn === this.speedOn) return;
    this.speedOn = speedOn;
    this.w = w; this.h = h; this.samples = samples; this.levels = levels; this.bloomOn = bloom; this.fxaaOn = useFxaa; this.tone = tone;
    this.disposeAll();
    this.sceneRT = target(w, h, HalfFloatType, samples, true);
    this.ldrRT = target(w, h, UnsignedByteType, 0, false);
    const u = this.u;
    const s = (tex: Texture, at: unknown) => sample(tex, at);

    if (bloom && levels > 0) {
      let bw = w, bh = h;
      for (let i = 0; i < levels; i++) {
        bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
        this.downs.push(target(bw, bh));
        this.ups.push(target(bw, bh));
      }
      // Soft-knee bright pass on a 2x2 average, so one hot pixel does not flicker the whole glow.
      const tx = vec2(1 / w, 1 / h);
      const src = this.sceneRT.texture;
      this.bright = quad(Fn(() => {
        const p = uv();
        const c0 = s(src, p.add(tx.mul(vec2(-0.5, -0.5)))).rgb
          .add(s(src, p.add(tx.mul(vec2(0.5, -0.5)))).rgb)
          .add(s(src, p.add(tx.mul(vec2(-0.5, 0.5)))).rgb)
          .add(s(src, p.add(tx.mul(vec2(0.5, 0.5)))).rgb).mul(0.25);
        const c = min(c0, vec3(64));
        const l = max(c.r, max(c.g, c.b));
        const knee = u.threshold.mul(0.5).add(1e-4);
        const k2 = knee.mul(2);
        const soft0 = clamp(l.sub(u.threshold).add(knee), 0, k2);
        const soft = soft0.mul(soft0).div(knee.mul(4));
        return vec4(c.mul(max(soft, l.sub(u.threshold))).div(max(l, 1e-4)), 1);
      })());
      // 13-tap downsample: stable, so small bright things do not shimmer.
      for (let i = 1; i < levels; i++) {
        const prev = this.downs[i - 1]!;
        const t = vec2(1 / prev.width, 1 / prev.height);
        const ps = prev.texture;
        this.downQuads.push(quad(Fn(() => {
          const p = uv();
          const o = (x: number, y: number) => s(ps, p.add(t.mul(vec2(x, y)))).rgb;
          const a = o(-2, 2), b = o(0, 2), c = o(2, 2), d = o(-2, 0), e = o(0, 0), f = o(2, 0), g = o(-2, -2), h2 = o(0, -2), i2 = o(2, -2);
          const j = o(-1, 1), k = o(1, 1), l = o(-1, -1), m = o(1, -1);
          const out = e.mul(0.125).add(a.add(c).add(g).add(i2).mul(0.03125)).add(b.add(d).add(f).add(h2).mul(0.0625)).add(j.add(k).add(l).add(m).mul(0.125));
          return vec4(out, 1);
        })()));
      }
      // 3x3 tent upsample of the smaller level, added to the same-size level from the way down.
      for (let i = levels - 2; i >= 0; i--) {
        const lowRT = i === levels - 2 ? this.downs[levels - 1]! : this.ups[i + 1]!;
        const t = vec2(1 / lowRT.width, 1 / lowRT.height);
        const lt = lowRT.texture;
        const addT = this.downs[i]!.texture;
        this.upQuads[i] = quad(Fn(() => {
          const p = uv();
          const o = (x: number, y: number) => s(lt, p.add(t.mul(vec2(x, y)))).rgb;
          const sum = o(0, 0).mul(4)
            .add(o(1, 0).add(o(-1, 0)).add(o(0, 1)).add(o(0, -1)).mul(2))
            .add(o(1, 1)).add(o(-1, -1)).add(o(1, -1)).add(o(-1, 1));
          return vec4(sum.div(16).add(s(addT, p).rgb), 1);
        })());
      }
    }

    const sceneTex = this.sceneRT.texture;
    const bloomTex = bloom && levels > 0 ? (levels > 1 ? this.ups[0]! : this.downs[0]!).texture : null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const encode = (c: any) => {
      const cc = max(c, vec3(0));
      return mix(cc.mul(12.92), pow(cc, vec3(0.41666667)).mul(1.055).sub(0.055), step(vec3(0.0031308), cc));
    };
    const hash = (p: any) => {
      const q0 = fract(p.mul(vec2(123.34, 456.21)));
      const q = q0.add(q0.x.mul(q0.x.add(45.32)).add(q0.y.mul(q0.y.add(45.32))));
      return fract(q.x.mul(q.y));
    };
    this.composite = quad(Fn(() => {
      const p = uv();
      let c = s(sceneTex, p).rgb;
      if (speedOn) {
        // Radial blur: samples slide towards the middle, more so near the edge, so the centre stays sharp.
        const dc = p.sub(0.5);
        const r0 = dc.mul(vec2(u.aspect, 1));
        const zoom = u.speed.mul(0.06).mul(smoothstep(0.15, 0.9, r0.x.mul(r0.x).add(r0.y.mul(r0.y)).sqrt()));
        let acc = vec3(0);
        for (let i = 0; i < 6; i++) acc = acc.add(s(sceneTex, dc.mul(float(1).sub(zoom.mul(i / 5))).add(0.5)).rgb);
        c = acc.div(6);
      }
      {
        // Impact: a chromatic split that grows away from the cut (no offset, so no change, while the pulse is idle).
        const off = p.sub(u.impactC).mul(u.impact.mul(0.007));
        c = vec3(s(sceneTex, p.add(off)).r, c.g, s(sceneTex, p.sub(off)).b);
      }
      if (bloomTex) c = c.add(s(bloomTex, p).rgb.mul(u.bloom));
      if (tone !== NoToneMapping) c = toneMapping(tone, u.exposure, c).rgb;
      let d = encode(c);
      // Grade in display space, where the sliders behave the way a person expects.
      d = pow(max(d.mul(u.gain).add(u.lift), vec3(0)), vec3(1).div(max(u.gamma, vec3(0.01))));
      d = d.sub(0.5).mul(u.contrast).add(0.5);
      const l = d.x.mul(0.2126).add(d.y.mul(0.7152)).add(d.z.mul(0.0722));
      d = vec3(l).add(d.sub(vec3(l)).mul(u.saturation));
      const dd = p.sub(0.5).mul(vec2(u.aspect, 1));
      d = d.mul(float(1).sub(u.vignette.mul(smoothstep(0.25, 0.95, dd.x.mul(dd.x).add(dd.y.mul(dd.y)).mul(2)))));
      if (speedOn) {
        const sc = p.sub(0.5).mul(2);
        const rn = sc.x.mul(sc.x).add(sc.y.mul(sc.y)).sqrt();
        const pp = sc.mul(vec2(u.aspect, 1));
        const vig = smoothstep(0.6, 1.5, rn).mul(0.28).mul(u.speed);
        const an = TSLModule.atan(pp.y, pp.x).div(6.2831853).add(0.5);
        const x = an.mul(96);
        const id = TSLModule.floor(x);
        const f = fract(x);
        const hh = fract(TSLModule.sin(id.mul(127.1).add(311.7)).mul(43758.5453));
        const line = float(1).sub(smoothstep(0.08, 0.3, TSLModule.abs(f.sub(0.5)).mul(2)));
        const len = pp.x.mul(pp.x).add(pp.y.mul(pp.y)).sqrt();
        const flow = fract(len.mul(0.5).sub(u.time.mul(hh.mul(0.8).add(0.9))).add(hh.mul(7)));
        const dash = smoothstep(0, 0.15, flow).mul(float(1).sub(smoothstep(0.35, 0.8, flow)));
        const streak = line.mul(dash).mul(step(0.6, hh)).mul(smoothstep(0.85, 1.4, rn)).mul(0.12).mul(u.speed);
        const a = clamp(vig.add(streak), 0, 1);
        d = mix(d, vec3(streak.div(max(a, 1e-4))), a);
      }
      {
        // The hit moment: colour drains (blood keeps its red), exposure dips, contrast bites, a vignette closes on the cut.
        const il = d.x.mul(0.2126).add(d.y.mul(0.7152)).add(d.z.mul(0.0722));
        const red = smoothstep(0.04, 0.18, d.x.sub(max(d.y, d.z)));
        const k = u.impact;
        let e = mix(d, vec3(il), k.mul(0.7).mul(float(1).sub(red.mul(0.75))));
        e = e.mul(float(1).sub(k.mul(0.2)));
        e = mix(e, e.mul(e).mul(vec3(3).sub(e.mul(2))), k.mul(0.3));
        const di = p.sub(u.impactC).mul(vec2(u.aspect, 1));
        const iv = smoothstep(0.3, 1.25, di.x.mul(di.x).add(di.y.mul(di.y)).sqrt());
        d = e.mul(float(1).sub(iv.mul(0.45).mul(k)));
      }
      d = d.add(hash(screenCoordinate.xy.add(u.seed)).sub(0.5).mul(u.grain));
      return vec4(clamp(d.rgb, 0, 1), 1);
    })());
    this.fxaaNode = useFxaa ? fxaa(texture(this.ldrRT.texture)) : null;
    this.fxaaQuad = this.fxaaNode ? quad(this.fxaaNode) : null;
  }

  /** Draws `scene` through `camera` and the whole chain to the canvas. */
  render(scene: Scene, camera: Camera, p: ResolvedPost, exposure: number, fx: PostFx, centreX: number, centreY: number): void {
    const r = this.renderer;
    const sceneRT = this.sceneRT!;
    r.setRenderTarget(sceneRT);
    r.render(scene, camera);

    const levels = this.downs.length;
    const u = this.u;
    if (this.bright && levels > 0) {
      u.threshold.value = p.bloomThreshold;
      this.pass(this.bright, this.downs[0]!);
      for (let i = 1; i < levels; i++) this.pass(this.downQuads[i - 1]!, this.downs[i]!);
      for (let i = levels - 2; i >= 0; i--) this.pass(this.upQuads[i]!, this.ups[i]!);
    }
    u.bloom.value = this.bloomOn ? p.bloom : 0;
    u.contrast.value = p.contrast;
    u.saturation.value = p.saturation;
    u.vignette.value = p.vignette;
    u.grain.value = p.grain;
    // The grain moves from frame to frame; it never touches the game's random streams.
    u.seed.value = (this.frame = (this.frame + 1) % 1024) * 7.31;
    u.aspect.value = this.w / this.h;
    u.exposure.value = exposure;
    u.speed.value = fx.speed * p.speedBlur;
    u.time.value = fx.time;
    u.impact.value = fx.impact;
    (u.impactC.value as Vector2).set(centreX, centreY);
    (u.lift.value as Vector3).set(p.lift[0], p.lift[1], p.lift[2]);
    (u.gamma.value as Vector3).set(p.gamma[0], p.gamma[1], p.gamma[2]);
    (u.gain.value as Vector3).set(p.gain[0], p.gain[1], p.gain[2]);

    // The composite writes display-space values already, so the renderer's own tone mapping and colour-space
    // conversion are switched off for these last passes (the same thing three's RenderPipeline does).
    const tm = r.toneMapping;
    const cs = r.outputColorSpace;
    r.toneMapping = NoToneMapping;
    r.outputColorSpace = ColorManagement.workingColorSpace;
    try {
      if (this.fxaaOn && this.fxaaQuad) {
        this.pass(this.composite!, this.ldrRT!);
        this.pass(this.fxaaQuad, null);
      } else {
        this.pass(this.composite!, null);
      }
    } finally {
      r.toneMapping = tm;
      r.outputColorSpace = cs;
    }
  }

  private pass(q: QuadMesh, out: RenderTarget | null): void {
    this.renderer.setRenderTarget(out);
    q.render(this.renderer);
  }

  private disposeAll(): void {
    this.sceneRT?.dispose();
    this.ldrRT?.dispose();
    for (const t of this.downs) t.dispose();
    for (const t of this.ups) t.dispose();
    for (const q of [this.bright, this.composite, this.fxaaQuad, ...this.downQuads, ...this.upQuads]) {
      if (q) (q.material as NodeMaterial).dispose();
    }
    this.downs = []; this.ups = []; this.downQuads = []; this.upQuads = [];
    this.sceneRT = null; this.ldrRT = null; this.bright = null; this.composite = null; this.fxaaQuad = null;
    this.fxaaNode = null;
  }

  dispose(): void {
    this.disposeAll();
  }
}
