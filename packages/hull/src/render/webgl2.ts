// The WebGL2 backend, on three.js's WebGLRenderer. Everything three-specific about drawing a frame lives here.
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  CineonToneMapping,
  DirectionalLight,
  HemisphereLight,
  LinearToneMapping,
  Mesh,
  NoToneMapping,
  NeutralToneMapping,
  PCFShadowMap,
  ReinhardToneMapping,
  Scene,
  ShaderMaterial,
  BackSide,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Object3D,
  type ToneMapping as ThreeToneMapping,
} from 'three';
import type { Node, World } from '../core/index.ts';
import type { Look } from '../schema/look.ts';
import type { Backend, Capability, Quality, RenderStats } from './backend.ts';
import { Camera } from './behaviours.ts';
import { debugLines } from './debug.ts';
import { stateFor } from './interp.ts';
import { SkyEnvironment, SKY_GLSL, setSkyUniforms, skyUniforms } from './environment.ts';
import { PostChain } from './post.ts';
import { setRenderRuntime } from './runtime.ts';
import { NEUTRAL_POST, postFor, resolveLook, TIERS, type ResolvedLook, type ToneMapping } from './look.ts';
import type { PostFx } from './postfx.ts';
import { applyRig, flatBackground, placeSun, skyFor } from './rig.ts';

const TONE: Record<ToneMapping, ThreeToneMapping> = {
  none: NoToneMapping,
  linear: LinearToneMapping,
  reinhard: ReinhardToneMapping,
  cineon: CineonToneMapping,
  aces: ACESFilmicToneMapping,
  agx: AgXToneMapping,
  neutral: NeutralToneMapping,
};

// A dome around the camera, painted by the direction of each pixel (the same gradient the environment map is baked
// from, with the fog colour banded in at the horizon).
const skyUnis = skyUniforms();
const skyMaterial = new ShaderMaterial({
  uniforms: skyUnis,
  vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `${SKY_GLSL}
    varying vec3 vDir;
    void main() {
      gl_FragColor = vec4(skyColor(vDir), 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
  side: BackSide,
  depthTest: false,
  depthWrite: false,
  fog: false,
});

export class WebGL2Backend implements Backend {
  readonly name = 'webgl2';

  private renderer: WebGLRenderer | null = null;
  private readonly scene = new Scene();
  private readonly ambient = new HemisphereLight();
  private env: SkyEnvironment | null = null;
  private post: PostChain | null = null;
  private readonly size2 = new Vector2();
  private readonly snapped: [number, number, number] = [0, 0, 0];
  private lookValue: Look | undefined = undefined;
  private readonly sun = new DirectionalLight();
  private readonly dome = new Mesh(new SphereGeometry(1, 24, 12), skyMaterial);
  private quality: Quality = 'medium';
  private shadowMapSize = 2048;
  private world: World | null = null;
  private rootParent: Object3D | null = null;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private rawDpr = 1;
  private look: ResolvedLook = resolveLook(undefined);
  private readonly fx: PostFx = { speed: 0, impact: 0, impactAt: null, time: 0 };
  private readonly projected = new Vector3();
  private lastCamera: Node | null = null;
  private lastAlpha = 1;
  private ms = 0;
  private fps = 0;
  private lastDraw = 0;
  private calls = 0;
  private tris = 0;
  private canvas: HTMLCanvasElement | null = null;

  init(canvas: HTMLCanvasElement, quality: Quality): void {
    const q = TIERS[quality];
    // three throws "Error creating WebGL context" when the device has none: mountRender reports that and moves on.
    const renderer = new WebGLRenderer({ canvas, antialias: quality !== 'low', powerPreference: 'high-performance' });
    this.renderer = renderer;
    this.canvas = canvas;
    this.quality = quality;
    renderer.shadowMap.enabled = q.shadows;
    renderer.shadowMap.type = PCFShadowMap;
    this.env = new SkyEnvironment(renderer);
    this.post = new PostChain(renderer);

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
    setRenderRuntime({ backend: 'webgl2', compute: false, renderer });
  }

  can(cap: Capability): boolean {
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
    if (!renderer || !world) return;
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
        // The look's sun rides with the camera so its shadows cover what is on screen.
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
          this.post.resize(this.size2.x, this.size2.y, t.samples, t.bloomLevels);
          this.post.render(this.scene, view, post, renderer.toneMapping, renderer.toneMappingExposure, this.fx, cxu, cyu);
        } else {
          renderer.render(this.scene, view);
        }
        const info = renderer.info.render;
        this.calls = info.calls;
        this.tris = info.triangles;
      } else {
        renderer.clear();
      }
    } finally {
      // Always, even if drawing threw: the simulation must find its own transforms.
      state.interp.restore();
      debugLines.clear();
    }
    const now = performance.now();
    this.ms = now - t0;
    if (this.lastDraw > 0) {
      const inst = 1000 / Math.max(0.001, now - this.lastDraw);
      this.fps = this.fps === 0 ? inst : this.fps + (inst - this.fps) * 0.1;
    }
    this.lastDraw = now;
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
      setSkyUniforms(skyUnis, sky);
      this.dome.visible = true;
    }
    if (renderer && this.env) {
      // A flat sky has no gradient to bake, so give it a uniform one in its own colour.
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
    this.dpr = Math.min(dpr, TIERS[this.quality].dprCap);
    this.renderer?.setPixelRatio(this.dpr);
    this.renderer?.setSize(this.width, this.height, false);
  }

  stats(): RenderStats {
    return { drawCalls: this.calls, triangles: this.tris, ms: this.ms, fps: this.fps };
  }

  shot(): Promise<Blob> {
    const canvas = this.canvas;
    if (!canvas || !this.world) return Promise.reject(new Error('render: shot() before the first frame'));
    // The drawing buffer is only readable in the task that drew it, so draw again now and read at once.
    this.sync(this.world, this.lastAlpha);
    this.draw(this.lastCamera);
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('render: the canvas gave no image'))), 'image/png');
    });
  }

  dispose(): void {
    setRenderRuntime(null);
    this.releaseWorld();
    debugLines.detach();
    this.scene.remove(debugLines.object);
    this.sun.dispose();
    this.env?.dispose();
    this.post?.dispose();
    this.dome.geometry.dispose();
    this.renderer?.dispose();
    this.renderer = null;
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
