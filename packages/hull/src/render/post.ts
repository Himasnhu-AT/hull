// The post chain, on three.js's render targets. The scene is drawn into a multisampled half-float target (so values
// above 1 survive for bloom), then:
//   bloom      bright-pass, a pyramid of blurred halves, tent upsample
//   composite  bloom added, tone mapped, then in display space: lift/gamma/gain, contrast, saturation, vignette, grain
//   fxaa       optional, on the finished picture
// Every pass is one full-screen triangle. Targets are reused; nothing allocates per frame.
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  BufferAttribute,
  BufferGeometry,
  CineonToneMapping,
  HalfFloatType,
  LinearFilter,
  LinearToneMapping,
  Mesh,
  NeutralToneMapping,
  OrthographicCamera,
  UnsignedByteType,
  RawShaderMaterial,
  ReinhardToneMapping,
  Scene,
  Vector2,
  WebGLRenderTarget,
  type Camera,
  type Texture,
  type TextureDataType,
  type ToneMapping,
  type WebGLRenderer,
} from 'three';
import type { ResolvedPost } from './look.ts';

const VERT = /* glsl */ `
precision highp float;
attribute vec3 position;
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const HEAD = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
`;

// Soft-knee bright pass on a 2x2 average, so one hot pixel does not flicker the whole glow.
const BRIGHT = HEAD + /* glsl */ `
uniform float uThreshold;
void main() {
  vec3 c = (texture2D(tSrc, vUv + uTexel * vec2(-0.5, -0.5)).rgb + texture2D(tSrc, vUv + uTexel * vec2(0.5, -0.5)).rgb
          + texture2D(tSrc, vUv + uTexel * vec2(-0.5, 0.5)).rgb + texture2D(tSrc, vUv + uTexel * vec2(0.5, 0.5)).rgb) * 0.25;
  c = min(c, vec3(64.0));
  float l = max(c.r, max(c.g, c.b));
  float knee = uThreshold * 0.5 + 1e-4;
  float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  gl_FragColor = vec4(c * max(soft, l - uThreshold) / max(l, 1e-4), 1.0);
}`;

// 13-tap downsample: stable, so small bright things do not shimmer.
const DOWN = HEAD + /* glsl */ `
void main() {
  vec2 t = uTexel;
  vec3 a = texture2D(tSrc, vUv + t * vec2(-2.0, 2.0)).rgb, b = texture2D(tSrc, vUv + t * vec2(0.0, 2.0)).rgb, c = texture2D(tSrc, vUv + t * vec2(2.0, 2.0)).rgb;
  vec3 d = texture2D(tSrc, vUv + t * vec2(-2.0, 0.0)).rgb, e = texture2D(tSrc, vUv).rgb, f = texture2D(tSrc, vUv + t * vec2(2.0, 0.0)).rgb;
  vec3 g = texture2D(tSrc, vUv + t * vec2(-2.0, -2.0)).rgb, h = texture2D(tSrc, vUv + t * vec2(0.0, -2.0)).rgb, i = texture2D(tSrc, vUv + t * vec2(2.0, -2.0)).rgb;
  vec3 j = texture2D(tSrc, vUv + t * vec2(-1.0, 1.0)).rgb, k = texture2D(tSrc, vUv + t * vec2(1.0, 1.0)).rgb;
  vec3 l = texture2D(tSrc, vUv + t * vec2(-1.0, -1.0)).rgb, m = texture2D(tSrc, vUv + t * vec2(1.0, -1.0)).rgb;
  gl_FragColor = vec4(e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125, 1.0);
}`;

// 3x3 tent upsample of the smaller level, added to the same-size level from the way down.
const UP = HEAD + /* glsl */ `
uniform sampler2D tAdd;
void main() {
  vec2 t = uTexel;
  vec3 s = texture2D(tSrc, vUv).rgb * 4.0
    + (texture2D(tSrc, vUv + vec2(t.x, 0.0)).rgb + texture2D(tSrc, vUv - vec2(t.x, 0.0)).rgb + texture2D(tSrc, vUv + vec2(0.0, t.y)).rgb + texture2D(tSrc, vUv - vec2(0.0, t.y)).rgb) * 2.0
    + texture2D(tSrc, vUv + t).rgb + texture2D(tSrc, vUv - t).rgb + texture2D(tSrc, vUv + vec2(t.x, -t.y)).rgb + texture2D(tSrc, vUv + vec2(-t.x, t.y)).rgb;
  gl_FragColor = vec4(s / 16.0 + texture2D(tAdd, vUv).rgb, 1.0);
}`;

const COMPOSITE = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform float uBloom, uContrast, uSaturation, uVignette, uGrain, uSeed, uAspect;
uniform vec3 uLift, uGamma, uGain;
#include <tonemapping_pars_fragment>
vec3 encode(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(0.41666667)) - 0.055, step(vec3(0.0031308), c));
}
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
void main() {
  vec3 c = texture2D(tScene, vUv).rgb;
  #ifdef BLOOM
    c += texture2D(tBloom, vUv).rgb * uBloom;
  #endif
  #if defined(LINEAR_TONE_MAPPING)
    c = LinearToneMapping(c);
  #elif defined(REINHARD_TONE_MAPPING)
    c = ReinhardToneMapping(c);
  #elif defined(CINEON_TONE_MAPPING)
    c = CineonToneMapping(c);
  #elif defined(ACES_FILMIC_TONE_MAPPING)
    c = ACESFilmicToneMapping(c);
  #elif defined(AGX_TONE_MAPPING)
    c = AgXToneMapping(c);
  #elif defined(NEUTRAL_TONE_MAPPING)
    c = NeutralToneMapping(c);
  #endif
  c = encode(c);
  // Grade in display space, where the sliders behave the way a person expects.
  c = pow(max(c * uGain + uLift, vec3(0.0)), 1.0 / max(uGamma, vec3(0.01)));
  c = (c - 0.5) * uContrast + 0.5;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSaturation);
  vec2 d = (vUv - 0.5) * vec2(uAspect, 1.0);
  c *= 1.0 - uVignette * smoothstep(0.25, 0.95, dot(d, d) * 2.0);
  c += (hash(gl_FragCoord.xy + uSeed) - 0.5) * uGrain;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

// FXAA 3.11, the quality-12 path trimmed: finds edges by luma and blends along them.
const FXAA = HEAD + /* glsl */ `
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
  vec3 cM = texture2D(tSrc, vUv).rgb;
  float lM = luma(cM);
  float lN = luma(texture2D(tSrc, vUv + vec2(0.0, uTexel.y)).rgb);
  float lS = luma(texture2D(tSrc, vUv - vec2(0.0, uTexel.y)).rgb);
  float lE = luma(texture2D(tSrc, vUv + vec2(uTexel.x, 0.0)).rgb);
  float lW = luma(texture2D(tSrc, vUv - vec2(uTexel.x, 0.0)).rgb);
  float lMax = max(lM, max(max(lN, lS), max(lE, lW)));
  float lMin = min(lM, min(min(lN, lS), min(lE, lW)));
  float range = lMax - lMin;
  if (range < max(0.0312, lMax * 0.125)) { gl_FragColor = vec4(cM, 1.0); return; }
  float lNW = luma(texture2D(tSrc, vUv + vec2(-uTexel.x, uTexel.y)).rgb);
  float lNE = luma(texture2D(tSrc, vUv + vec2(uTexel.x, uTexel.y)).rgb);
  float lSW = luma(texture2D(tSrc, vUv + vec2(-uTexel.x, -uTexel.y)).rgb);
  float lSE = luma(texture2D(tSrc, vUv + vec2(uTexel.x, -uTexel.y)).rgb);
  float edgeH = abs(lNW + lNE - 2.0 * lN) + 2.0 * abs(lW + lE - 2.0 * lM) + abs(lSW + lSE - 2.0 * lS);
  float edgeV = abs(lNW + lSW - 2.0 * lW) + 2.0 * abs(lN + lS - 2.0 * lM) + abs(lNE + lSE - 2.0 * lE);
  bool horizontal = edgeH >= edgeV;
  float l1 = horizontal ? lS : lW;
  float l2 = horizontal ? lN : lE;
  float g1 = abs(l1 - lM), g2 = abs(l2 - lM);
  bool steep1 = g1 >= g2;
  float step = horizontal ? uTexel.y : uTexel.x;
  float lAvg = 0.5 * (steep1 ? l1 + lM : l2 + lM);
  if (steep1) step = -step;
  vec2 pos = vUv;
  vec2 off = horizontal ? vec2(uTexel.x, 0.0) : vec2(0.0, uTexel.y);
  if (horizontal) pos.y += step * 0.5; else pos.x += step * 0.5;
  float gradScaled = max(g1, g2) * 0.25;
  vec2 p1 = pos - off, p2 = pos + off;
  float e1 = luma(texture2D(tSrc, p1).rgb) - lAvg, e2 = luma(texture2D(tSrc, p2).rgb) - lAvg;
  bool d1 = abs(e1) >= gradScaled, d2 = abs(e2) >= gradScaled;
  for (int i = 0; i < 8; i++) {
    if (!d1) { p1 -= off; e1 = luma(texture2D(tSrc, p1).rgb) - lAvg; d1 = abs(e1) >= gradScaled; }
    if (!d2) { p2 += off; e2 = luma(texture2D(tSrc, p2).rgb) - lAvg; d2 = abs(e2) >= gradScaled; }
  }
  float dist1 = horizontal ? vUv.x - p1.x : vUv.y - p1.y;
  float dist2 = horizontal ? p2.x - vUv.x : p2.y - vUv.y;
  bool nearer1 = dist1 < dist2;
  float distMin = min(dist1, dist2);
  float span = dist1 + dist2;
  bool goodSpan = ((nearer1 ? e1 : e2) < 0.0) != (lM - lAvg < 0.0);
  float pixelOffset = goodSpan ? -distMin / span + 0.5 : 0.0;
  float avg3 = (2.0 * (lN + lS + lE + lW) + lNW + lNE + lSW + lSE) / 12.0;
  float subpix = clamp(abs(avg3 - lM) / range, 0.0, 1.0);
  subpix = smoothstep(0.0, 1.0, subpix);
  float finalOffset = max(pixelOffset, subpix * subpix * 0.75);
  vec2 uv = vUv;
  if (horizontal) uv.y += step * finalOffset; else uv.x += step * finalOffset;
  gl_FragColor = vec4(texture2D(tSrc, uv).rgb, 1.0);
}`;

const TONE_DEFINE: [ToneMapping, string][] = [
  [LinearToneMapping, 'LINEAR_TONE_MAPPING'],
  [ReinhardToneMapping, 'REINHARD_TONE_MAPPING'],
  [CineonToneMapping, 'CINEON_TONE_MAPPING'],
  [ACESFilmicToneMapping, 'ACES_FILMIC_TONE_MAPPING'],
  [AgXToneMapping, 'AGX_TONE_MAPPING'],
  [NeutralToneMapping, 'NEUTRAL_TONE_MAPPING'],
];

function pass(fragment: string, uniforms: Record<string, { value: unknown }>): RawShaderMaterial {
  return new RawShaderMaterial({
    vertexShader: VERT,
    fragmentShader: fragment,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });
}

function target(w: number, h: number, type: TextureDataType = HalfFloatType, samples = 0, depth = false): WebGLRenderTarget {
  const t = new WebGLRenderTarget(w, h, { type, samples, depthBuffer: depth, minFilter: LinearFilter, magFilter: LinearFilter, generateMipmaps: false });
  t.texture.name = 'hull.post';
  return t;
}

export class PostChain {
  private readonly quad: Mesh;
  private readonly scene = new Scene();
  private readonly cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly tSrc = { value: null as Texture | null };
  private readonly texel = { value: new Vector2() };
  private readonly bright: RawShaderMaterial;
  private readonly down: RawShaderMaterial;
  private readonly up: RawShaderMaterial;
  private readonly fxaa: RawShaderMaterial;
  private readonly composite: RawShaderMaterial;
  private readonly tAdd = { value: null as Texture | null };
  private readonly threshold = { value: 1 };
  private sceneRT: WebGLRenderTarget | null = null;
  private ldrRT: WebGLRenderTarget | null = null;
  private downs: WebGLRenderTarget[] = [];
  private ups: WebGLRenderTarget[] = [];
  private w = 0;
  private h = 0;
  private samples = -1;
  private levels = -1;
  private seed = 0;
  private toneKey: ToneMapping = -1 as ToneMapping;
  private bloomOn = false;

  constructor(private readonly renderer: WebGLRenderer) {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const u = (extra: Record<string, { value: unknown }> = {}) => ({ tSrc: this.tSrc, uTexel: this.texel, ...extra });
    this.bright = pass(BRIGHT, u({ uThreshold: this.threshold }));
    this.down = pass(DOWN, u());
    this.up = pass(UP, u({ tAdd: this.tAdd }));
    this.fxaa = pass(FXAA, u());
    this.composite = pass(COMPOSITE, {
      tScene: { value: null }, tBloom: { value: null },
      uBloom: { value: 0 }, uContrast: { value: 1 }, uSaturation: { value: 1 }, uVignette: { value: 0 }, uGrain: { value: 0 }, uSeed: { value: 0 }, uAspect: { value: 1 },
      uLift: { value: [0, 0, 0] }, uGamma: { value: [1, 1, 1] }, uGain: { value: [1, 1, 1] },
      toneMappingExposure: { value: 1 },
    });
    this.quad = new Mesh(g, this.bright);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  /** Sizes in device pixels. Cheap to call every frame: it only rebuilds targets that changed. */
  resize(w: number, h: number, samples: number, levels: number): void {
    if (w === this.w && h === this.h && samples === this.samples && levels === this.levels) return;
    this.w = w; this.h = h; this.samples = samples; this.levels = levels;
    this.disposeTargets();
    this.sceneRT = target(w, h, HalfFloatType, samples, true);
    this.ldrRT = target(w, h, UnsignedByteType, 0, false);
    let bw = w, bh = h;
    for (let i = 0; i < levels; i++) {
      bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
      this.downs.push(target(bw, bh));
      this.ups.push(target(bw, bh));
    }
  }

  private run(mat: RawShaderMaterial, src: Texture, out: WebGLRenderTarget | null, texelW: number, texelH: number): void {
    this.quad.material = mat;
    this.tSrc.value = src;
    this.texel.value.set(1 / texelW, 1 / texelH);
    this.renderer.setRenderTarget(out);
    this.renderer.render(this.scene, this.cam);
  }

  /** Draws `scene` through `camera` and the whole chain to the screen. Returns nothing; the canvas holds the result. */
  render(scene: Scene, camera: Camera, p: ResolvedPost, toneMapping: ToneMapping, exposure: number): void {
    const r = this.renderer;
    const sceneRT = this.sceneRT!;
    r.setRenderTarget(sceneRT);
    r.clear();
    r.render(scene, camera);

    const levels = this.downs.length;
    const bloom = p.bloom > 0 && levels > 0;
    if (bloom) {
      this.threshold.value = p.bloomThreshold;
      this.run(this.bright, sceneRT.texture, this.downs[0]!, this.w, this.h);
      // downs[0] holds the bright pass at half size; the rest shrink it further.
      for (let i = 1; i < levels; i++) {
        const prev = this.downs[i - 1]!;
        this.run(this.down, prev.texture, this.downs[i]!, prev.width, prev.height);
      }
      let low = this.downs[levels - 1]!;
      for (let i = levels - 2; i >= 0; i--) {
        this.tAdd.value = this.downs[i]!.texture;
        this.run(this.up, low.texture, this.ups[i]!, low.width, low.height);
        low = this.ups[i]!;
      }
      this.composite.uniforms['tBloom']!.value = low.texture;
    }

    const m = this.composite;
    if (bloom !== this.bloomOn || toneMapping !== this.toneKey) {
      this.bloomOn = bloom;
      this.toneKey = toneMapping;
      const defs: Record<string, string> = {};
      if (bloom) defs['BLOOM'] = '';
      for (const [mode, name] of TONE_DEFINE) if (mode === toneMapping) defs[name] = '';
      m.defines = defs;
      m.needsUpdate = true;
    }
    const u = m.uniforms;
    u['tScene']!.value = sceneRT.texture;
    u['uBloom']!.value = p.bloom;
    u['uContrast']!.value = p.contrast;
    u['uSaturation']!.value = p.saturation;
    u['uVignette']!.value = p.vignette;
    u['uGrain']!.value = p.grain;
    // The grain moves from frame to frame; it never touches the game's random streams.
    u['uSeed']!.value = (this.seed = (this.seed + 1) % 1024) * 7.31;
    u['uAspect']!.value = this.w / this.h;
    u['toneMappingExposure']!.value = exposure;
    copy3(u['uLift']!.value as number[], p.lift);
    copy3(u['uGamma']!.value as number[], p.gamma);
    copy3(u['uGain']!.value as number[], p.gain);

    this.quad.material = m;
    r.setRenderTarget(p.fxaa ? this.ldrRT : null);
    r.render(this.scene, this.cam);
    if (p.fxaa) this.run(this.fxaa, this.ldrRT!.texture, null, this.w, this.h);
  }

  private disposeTargets(): void {
    this.sceneRT?.dispose();
    this.ldrRT?.dispose();
    for (const t of this.downs) t.dispose();
    for (const t of this.ups) t.dispose();
    this.downs = [];
    this.ups = [];
    this.sceneRT = null;
    this.ldrRT = null;
  }

  dispose(): void {
    this.disposeTargets();
    for (const m of [this.bright, this.down, this.up, this.fxaa, this.composite]) m.dispose();
    this.quad.geometry.dispose();
  }
}

function copy3(out: number[], v: readonly number[]): void {
  out[0] = v[0]!; out[1] = v[1]!; out[2] = v[2]!;
}
