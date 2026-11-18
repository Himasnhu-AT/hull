// The WebGL2 backend, on three.js's WebGLRenderer. Everything three-specific about drawing a frame lives here.
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  AmbientLight,
  CineonToneMapping,
  Color,
  DirectionalLight,
  Fog,
  FogExp2,
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
import { resolveLook, type ResolvedLook, type ToneMapping } from './look.ts';

const QUALITY: Record<Quality, { dprCap: number; antialias: boolean; shadowMap: number }> = {
  low: { dprCap: 1, antialias: false, shadowMap: 1024 },
  medium: { dprCap: 1.5, antialias: true, shadowMap: 2048 },
  high: { dprCap: 2, antialias: true, shadowMap: 4096 },
};

const TONE: Record<ToneMapping, ThreeToneMapping> = {
  none: NoToneMapping,
  linear: LinearToneMapping,
  reinhard: ReinhardToneMapping,
  cineon: CineonToneMapping,
  aces: ACESFilmicToneMapping,
  agx: AgXToneMapping,
  neutral: NeutralToneMapping,
};

// A dome around the camera, painted by the direction of each pixel: horizon colour at and below the horizon,
// mid colour at about 20 degrees up, zenith colour straight up.
const skyMaterial = new ShaderMaterial({
  uniforms: { horizon: { value: new Color() }, mid: { value: new Color() }, zenith: { value: new Color() } },
  vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform vec3 horizon; uniform vec3 mid; uniform vec3 zenith; varying vec3 vDir;
    void main() {
      float h = normalize(vDir).y;
      vec3 c = mix(horizon, mid, smoothstep(0.0, 0.35, h));
      c = mix(c, zenith, smoothstep(0.35, 1.0, h));
      gl_FragColor = vec4(c, 1.0);
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
  private readonly ambient = new AmbientLight();
  private readonly sun = new DirectionalLight();
  private readonly dome = new Mesh(new SphereGeometry(1, 24, 12), skyMaterial);
  private quality: Quality = 'medium';
  private world: World | null = null;
  private rootParent: Object3D | null = null;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private look: ResolvedLook = resolveLook(undefined);
  private lastCamera: Node | null = null;
  private lastAlpha = 1;
  private ms = 0;
  private fps = 0;
  private lastDraw = 0;
  private calls = 0;
  private tris = 0;
  private canvas: HTMLCanvasElement | null = null;

  init(canvas: HTMLCanvasElement, quality: Quality): void {
    const q = QUALITY[quality];
    // three throws "Error creating WebGL context" when the device has none: mountRender reports that and moves on.
    const renderer = new WebGLRenderer({ canvas, antialias: q.antialias, powerPreference: 'high-performance' });
    this.renderer = renderer;
    this.canvas = canvas;
    this.quality = quality;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;

    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;
    const sun = this.sun;
    sun.shadow.mapSize.set(q.shadowMap, q.shadowMap);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 400;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    this.scene.add(this.ambient, sun, sun.target, this.dome, debugLines.object);
    debugLines.attach();
    this.setLook(undefined);
  }

  can(cap: Capability): boolean {
    return cap === 'shadows' || cap === 'instancing' || (cap === 'msaa' && QUALITY[this.quality].antialias);
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
        const d = this.look.sun.dir;
        this.sun.target.position.set(cx, cy, cz);
        this.sun.position.set(cx + d[0] * 150, cy + d[1] * 150, cz + d[2] * 150);
        this.sun.visible = state.suns === 0;
        debugLines.upload();
        renderer.render(this.scene, view);
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

  setLook(look: Look | undefined): void {
    const r = resolveLook(look);
    this.look = r;
    const renderer = this.renderer;
    const scene = this.scene;
    if (r.skyColor !== null) {
      const bg = scene.background instanceof Color ? scene.background : new Color();
      bg.set(r.skyColor);
      scene.background = bg;
      this.dome.visible = false;
    } else {
      scene.background = null;
      skyMaterial.uniforms['horizon']!.value.set(r.horizon);
      skyMaterial.uniforms['mid']!.value.set(r.mid);
      skyMaterial.uniforms['zenith']!.value.set(r.zenith);
      this.dome.visible = true;
    }
    if (r.fog === null) {
      scene.fog = null;
    } else if (r.fog.density > 0) {
      if (scene.fog instanceof FogExp2) { scene.fog.color.set(r.fog.color); scene.fog.density = r.fog.density; }
      else scene.fog = new FogExp2(r.fog.color, r.fog.density);
    } else if (scene.fog instanceof Fog) {
      scene.fog.color.set(r.fog.color); scene.fog.near = r.fog.near; scene.fog.far = r.fog.far;
    } else {
      scene.fog = new Fog(r.fog.color, r.fog.near, r.fog.far);
    }
    this.ambient.color.set(r.ambient.color);
    this.ambient.intensity = r.ambient.intensity;
    const sun = this.sun;
    sun.color.set(r.sun.color);
    sun.intensity = r.sun.intensity;
    sun.castShadow = r.sun.shadows;
    const c = sun.shadow.camera;
    const range = r.sun.shadowRange;
    if (c.right !== range) {
      c.left = -range; c.right = range; c.top = range; c.bottom = -range;
      c.updateProjectionMatrix();
    }
    if (renderer) {
      renderer.toneMapping = TONE[r.toneMapping];
      renderer.toneMappingExposure = r.exposure;
    }
  }

  resize(width: number, height: number, dpr: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.dpr = Math.min(dpr, QUALITY[this.quality].dprCap);
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
    this.releaseWorld();
    debugLines.detach();
    this.scene.remove(debugLines.object);
    this.sun.dispose();
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
