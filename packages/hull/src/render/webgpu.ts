// The WebGPU backend, on three.js's WebGPURenderer. It draws the same scene graph as the WebGL2 backend (the node
// materials are made from the Mesh behaviours' standard materials by three itself), lights it through the shared
// rig, and keeps the same look: sky, environment, fog, shadows, tone mapping and the post chain, the latter two
// written as TSL (see webgpu-post.ts and webgpu-sky.ts). It also has what WebGL2 does not: compute.
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  CineonToneMapping,
  DirectionalLight,
  HemisphereLight,
  LinearToneMapping,
  Mesh,
  Node as ThreeNode,
  NeutralToneMapping,
  NoToneMapping,
  PCFShadowMap,
  ReinhardToneMapping,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGPURenderer,
  type Object3D,
  type ToneMapping as ThreeToneMapping,
} from 'three/webgpu';
import type { Node, World } from '../core/index.ts';
import type { Look } from '../schema/look.ts';
import type { Backend, Capability, Quality, RenderStats } from './backend.ts';
import { Camera } from './behaviours.ts';
import { debugLines } from './debug.ts';
import { stateFor } from './interp.ts';
import { NEUTRAL_POST, postFor, resolveLook, TIERS, type ResolvedLook, type ToneMapping } from './look.ts';
import type { PostFx } from './postfx.ts';
import { webgpuRefusal } from './pick.ts';
import { applyRig, flatBackground, placeSun, skyFor } from './rig.ts';
import { registerWebgpuVfx, setRenderRuntime } from './runtime.ts';
import { WebGPUPostChain } from './webgpu-post.ts';
import { makeSkyNodes, WebGPUSkyEnvironment } from './webgpu-sky.ts';

const TONE: Record<ToneMapping, ThreeToneMapping> = {
  none: NoToneMapping,
  linear: LinearToneMapping,
  reinhard: ReinhardToneMapping,
  cineon: CineonToneMapping,
  aces: ACESFilmicToneMapping,
  agx: AgXToneMapping,
  neutral: NeutralToneMapping,
};

interface GpuAdapterLike {
  readonly isFallbackAdapter?: boolean;
  readonly features: { has(name: string): boolean };
  readonly limits: { maxStorageBuffersPerShaderStage: number; maxStorageBufferBindingSize: number };
}

export class WebGPUBackend implements Backend {
  readonly name = 'webgpu';
  onProblem: ((message: string) => void) | undefined = undefined;

  private renderer: WebGPURenderer | null = null;
  private readonly scene = new Scene();
  private readonly ambient = new HemisphereLight();
  private env: WebGPUSkyEnvironment | null = null;
  private post: WebGPUPostChain | null = null;
  private readonly fx: PostFx = { speed: 0, impact: 0, impactAt: null, time: 0 };
  private readonly projected = new Vector3();
  private readonly sky = makeSkyNodes();
  private readonly size2 = new Vector2();
  private readonly snapped: [number, number, number] = [0, 0, 0];
  private lookValue: Look | undefined = undefined;
  private readonly sun = new DirectionalLight();
  private readonly dome = new Mesh(new SphereGeometry(1, 24, 12), this.sky.domeMaterial());
  private quality: Quality = 'medium';
  private shadowMapSize = 2048;
  private world: World | null = null;
  private rootParent: Object3D | null = null;
  private width = 1;
  private height = 1;
  private rawDpr = 1;
  private look: ResolvedLook = resolveLook(undefined);
  private lastCamera: Node | null = null;
  private lastAlpha = 1;
  private ms = 0;
  private fps = 0;
  private lastDraw = 0;
  private calls = 0;
  private tris = 0;
  private gpuMs: number | undefined = undefined;
  private timing = false;
  private resolving = false;
  private framesSinceRead = 0;
  private canvas: HTMLCanvasElement | null = null;
  private deviceLost = false;

  async init(canvas: HTMLCanvasElement, quality: Quality): Promise<void> {
    const gpu = (globalThis.navigator as unknown as { gpu?: { requestAdapter(o?: object): Promise<GpuAdapterLike | null> } }).gpu;
    if (!gpu) throw new Error('this browser has no navigator.gpu');
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    const refusal = webgpuRefusal({
      adapter: adapter === null ? null : {
        fallback: adapter.isFallbackAdapter === true,
        maxStorageBuffers: adapter.limits.maxStorageBuffersPerShaderStage,
        maxStorageBufferBytes: adapter.limits.maxStorageBufferBindingSize,
      },
    });
    if (refusal !== null || adapter === null) throw new Error(refusal ?? 'no adapter');
    this.timing = adapter.features.has('timestamp-query');

    if (new URLSearchParams(globalThis.location?.search ?? '').has('tslTrace')) (ThreeNode as unknown as { captureStackTrace: boolean }).captureStackTrace = true;
    const q = TIERS[quality];
    // Ask for the adapter's own storage limits: a 200,000-particle effect is a few buffers of a few MB each.
    const renderer = new WebGPURenderer({
      canvas,
      antialias: quality !== 'low',
      powerPreference: 'high-performance',
      trackTimestamp: this.timing,
      requiredLimits: { maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, 1 << 30) },
    });
    this.renderer = renderer;
    try {
      await renderer.init();
      // three quietly runs on a WebGL2 backend of its own when WebGPU is missing; that is not what was asked for.
      if ((renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend !== true) throw new Error('three fell back to its WebGL backend');
    } catch (e) {
      renderer.dispose();
      this.renderer = null;
      throw e;
    }
    const device = (renderer.backend as unknown as { device?: { lost: Promise<{ message: string }> } }).device;
    void device?.lost.then((info) => {
      if (this.renderer === null) return; // disposed on purpose
      this.deviceLost = true;
      this.onProblem?.(`render: the WebGPU device was lost (${info.message}); drawing stops.`);
    });

    this.canvas = canvas;
    this.quality = quality;
    renderer.shadowMap.enabled = q.shadows;
    renderer.shadowMap.type = PCFShadowMap;
    this.env = new WebGPUSkyEnvironment(renderer);
    this.post = new WebGPUPostChain(renderer);

    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;
    const sun = this.sun;
    sun.shadow.mapSize.set(q.shadowMap, q.shadowMap);
    this.shadowMapSize = q.shadowMap;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 400;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    this.scene.add(this.ambient, sun, sun.target, this.dome, debugLines.object);
    debugLines.attach();
    this.setLook(undefined);
    // The particle system draws differently here and uses compute; load its WebGPU half before anything is drawn.
    registerWebgpuVfx(await import('../vfx/webgpu.ts'));
    setRenderRuntime({ backend: 'webgpu', compute: true, renderer });
  }

  can(cap: Capability): boolean {
    if (cap === 'compute') return !this.deviceLost;
    return (cap === 'shadows' && TIERS[this.quality].shadows) || cap === 'instancing' || (cap === 'post' && TIERS[this.quality].post) || (cap === 'msaa' && TIERS[this.quality].samples > 0);
  }

  sync(world: World, alpha: number): void {
    if (this.world !== world) {
      this.releaseWorld();
      this.world = world;
      const root = world.root.object3d;
      this.rootParent = root.parent;
      this.scene.add(root);
    }
    this.lastAlpha = alpha;
    stateFor(world).interp.apply(alpha);
  }

  draw(cameraNode: Node | null): void {
    const renderer = this.renderer;
    const world = this.world;
    if (!renderer || !world || this.deviceLost) return;
    const t0 = performance.now();
    this.lastCamera = cameraNode;
    const state = stateFor(world);
    try {
      const cam = cameraNode?.get(Camera);
      const view = cam?.view;
      if (cam && view) {
        const aspect = this.width / this.height;
        if (view.fov !== cam.fov || view.near !== cam.near || view.far !== cam.far || view.aspect !== aspect) {
          view.fov = cam.fov;
          view.near = cam.near;
          view.far = cam.far;
          view.aspect = aspect;
          view.updateProjectionMatrix();
        }
        // The blended transforms are in place; one matrix pass lets the dome and sun follow the camera exactly.
        this.scene.updateMatrixWorld();
        const e = view.matrixWorld.elements;
        const cx = e[12]!;
        const cy = e[13]!;
        const cz = e[14]!;
        this.dome.position.set(cx, cy, cz);
        const r = Math.max(1, view.far * 0.5);
        this.dome.scale.set(r, r, r);
        placeSun(this.sun, this.look, cx, cy, cz, this.shadowMapSize, this.snapped, -e[8]!, -e[10]!);
        this.sun.visible = state.suns === 0;
        debugLines.upload();
        let post = postFor(this.look.post, TIERS[this.quality]);
        // A pulse needs the chain even when the look asks for no post.
        if (!post && this.fx.impact > 0 && TIERS[this.quality].post) post = NEUTRAL_POST;
        if (post && this.post) {
          let cxu = 0.5, cyu = 0.5;
          const at = this.fx.impactAt;
          if (at && this.fx.impact > 0) {
            this.projected.set(at[0], at[1], at[2]).project(view);
            if (this.projected.z <= 1) { cxu = this.projected.x * 0.5 + 0.5; cyu = this.projected.y * 0.5 + 0.5; }
          }
          renderer.getDrawingBufferSize(this.size2);
          const t = TIERS[this.quality];
          this.post.prepare(this.size2.x, this.size2.y, t.samples, t.bloomLevels, post.bloom > 0 && t.bloomLevels > 0, post.fxaa, renderer.toneMapping, post.speedBlur > 0);
          this.post.render(this.scene, view, post, renderer.toneMappingExposure, this.fx, cxu, cyu);
        } else {
          renderer.setRenderTarget(null);
          renderer.render(this.scene, view);
        }
        const info = renderer.info.render;
        this.calls = info.drawCalls;
        this.tris = info.triangles;
      } else {
        renderer.setRenderTarget(null);
        renderer.clear();
      }
    } finally {
      // Always, even if drawing threw: the simulation must find its own transforms.
      state.interp.restore();
      debugLines.clear();
    }
    this.readGpuTime();
    const now = performance.now();
    this.ms = now - t0;
    if (this.lastDraw > 0) {
      const inst = 1000 / Math.max(0.001, now - this.lastDraw);
      this.fps = this.fps === 0 ? inst : this.fps + (inst - this.fps) * 0.1;
    }
    this.lastDraw = now;
  }

  /**
   * Timestamp queries come back a frame or two later, and three adds up every pass recorded since the last read, so
   * the sum is divided by the frames it covers. One read at a time, never awaited by the frame.
   */
  private readGpuTime(): void {
    const renderer = this.renderer;
    if (!renderer || !this.timing) return;
    this.framesSinceRead++;
    if (this.resolving) return;
    this.resolving = true;
    const frames = this.framesSinceRead;
    this.framesSinceRead = 0;
    void Promise.all([renderer.resolveTimestampsAsync('render'), renderer.resolveTimestampsAsync('compute')])
      .then(() => {
        this.gpuMs = (renderer.info.render.timestamp + renderer.info.compute.timestamp) / Math.max(1, frames);
      })
      .catch(() => { this.timing = false; })
      .finally(() => { this.resolving = false; });
  }

  setFx(fx: PostFx): void {
    this.fx.speed = fx.speed;
    this.fx.impact = fx.impact;
    this.fx.impactAt = fx.impactAt;
    this.fx.time = fx.time;
  }

  setLook(look: Look | undefined): void {
    this.lookValue = look;
    this.applyLook();
  }

  /** Changes the quality tier at runtime: shadows, pixel ratio and post follow at once. */
  setQuality(quality: Quality): void {
    if (quality === this.quality) return;
    this.quality = quality;
    const q = TIERS[quality];
    this.shadowMapSize = q.shadowMap;
    this.sun.shadow.mapSize.set(q.shadowMap, q.shadowMap);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    this.resize(this.width, this.height, this.rawDpr);
    this.applyLook();
  }

  private applyLook(): void {
    const r = resolveLook(this.lookValue);
    this.look = r;
    const q = TIERS[this.quality];
    const renderer = this.renderer;
    const scene = this.scene;
    const sky = skyFor(r);
    if (r.skyColor !== null) {
      flatBackground(scene, r.skyColor);
      this.dome.visible = false;
    } else {
      scene.background = null;
      this.sky.set(sky);
      this.dome.visible = true;
    }
    if (renderer && this.env) {
      const flat = r.skyColor !== null;
      this.env.apply(scene, flat ? { ...sky, horizon: r.skyColor!, mid: r.skyColor!, zenith: r.skyColor!, fogAmount: 0 } : sky, r.environment.intensity);
    }
    applyRig(scene, this.ambient, this.sun, r, q);
    if (renderer) {
      renderer.shadowMap.enabled = q.shadows;
      renderer.toneMapping = TONE[r.toneMapping];
      renderer.toneMappingExposure = r.exposure;
    }
  }

  resize(width: number, height: number, dpr: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.rawDpr = dpr;
    const eff = Math.min(dpr, TIERS[this.quality].dprCap);
    this.renderer?.setPixelRatio(eff);
    this.renderer?.setSize(this.width, this.height, false);
  }

  stats(): RenderStats {
    const s: RenderStats = { drawCalls: this.calls, triangles: this.tris, ms: this.ms, fps: this.fps };
    if (this.gpuMs !== undefined) s.gpuMs = this.gpuMs;
    return s;
  }

  shot(): Promise<Blob> {
    const canvas = this.canvas;
    if (!canvas || !this.world) return Promise.reject(new Error('render: shot() before the first frame'));
    // A WebGPU canvas can only be read in the task that drew it, so draw again now and read at once.
    this.sync(this.world, this.lastAlpha);
    this.draw(this.lastCamera);
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('render: the canvas gave no image'))), 'image/png');
    });
  }

  dispose(): void {
    setRenderRuntime(null, this.renderer);
    this.releaseWorld();
    debugLines.detach();
    this.scene.remove(debugLines.object);
    this.sun.dispose();
    this.env?.dispose();
    this.post?.dispose();
    this.dome.geometry.dispose();
    (this.dome.material as { dispose(): void }).dispose();
    const r = this.renderer;
    this.renderer = null;
    r?.dispose();
  }

  private releaseWorld(): void {
    if (!this.world) return;
    const root = this.world.root.object3d;
    this.scene.remove(root);
    this.rootParent?.add(root);
    this.world = null;
    this.rootParent = null;
  }
}
