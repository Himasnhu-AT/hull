// The sky for WebGPU: the same gradient as environment.ts (SKY_GLSL), written in TSL. One function paints both the
// visible dome and the environment bake, so reflections match what is seen, as on WebGL2.
import { BackSide, Color, Mesh, MeshBasicNodeMaterial, PMREMGenerator, Scene, SphereGeometry, type RenderTarget, type Scene as ThreeScene, type WebGPURenderer } from 'three/webgpu';
import * as TSLModule from 'three/tsl';
import type { SkyColors } from './environment.ts';

// TSL's own typings cannot follow its operator chaining, so the shader code is typed loosely on purpose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { Fn, float, max, mix, normalize, positionLocal, select, smoothstep, uniform, vec3 } = TSLModule as any;

export function makeSkyNodes() {
  const horizon = uniform(new Color());
  const mid = uniform(new Color());
  const zenith = uniform(new Color());
  const ground = uniform(new Color());
  const fogColor = uniform(new Color());
  const fogAmount = uniform(0);
  const skyBlend = uniform(0.35);

  const skyColor = Fn(([dir]: [any]) => {
    const h = normalize(dir).y;
    const c0 = mix(horizon, mid, smoothstep(0, 0.35, h));
    const c1 = mix(c0, zenith, smoothstep(0.35, 1, h));
    // Fog climbs the sky from the horizon, so distant geometry fades into a sky of the same colour.
    const k = float(1).sub(smoothstep(0, max(skyBlend, 0.001), max(h, 0)));
    return mix(c1, fogColor, k.mul(fogAmount));
  });

  return {
    set(s: SkyColors): void {
      horizon.value.set(s.horizon);
      mid.value.set(s.mid);
      zenith.value.set(s.zenith);
      ground.value.set(s.ground);
      fogColor.value.set(s.fogColor);
      fogAmount.value = s.fogAmount;
      skyBlend.value = s.skyBlend;
    },
    /** A dome material: paints each pixel by the direction of the dome's local position. */
    domeMaterial(): MeshBasicNodeMaterial {
      const m = new MeshBasicNodeMaterial();
      m.side = BackSide;
      m.depthTest = false;
      m.depthWrite = false;
      m.fog = false;
      m.colorNode = skyColor(positionLocal);
      return m;
    },
    /** The environment bake's material: below the horizon a reflection sees the ground, not the sky. */
    envMaterial(): MeshBasicNodeMaterial {
      const m = new MeshBasicNodeMaterial();
      m.side = BackSide;
      m.depthWrite = false;
      m.fog = false;
      m.toneMapped = false;
      const d = normalize(positionLocal);
      const below = mix(skyColor(vec3(d.x, 0, d.z)), ground, smoothstep(0, 0.5, d.y.negate()));
      m.colorNode = select(d.y.greaterThanEqual(0), skyColor(d), below);
      return m;
    },
  };
}

export class WebGPUSkyEnvironment {
  private readonly pmrem: PMREMGenerator;
  private readonly envScene = new Scene();
  private readonly nodes = makeSkyNodes();
  private target: RenderTarget | null = null;
  private key = '';
  private readonly mat;

  constructor(renderer: WebGPURenderer) {
    this.pmrem = new PMREMGenerator(renderer);
    this.mat = this.nodes.envMaterial();
    this.envScene.add(new Mesh(new SphereGeometry(10, 32, 16), this.mat));
  }

  /** Bakes (when the colours changed) and attaches it. `intensity` 0 detaches. */
  apply(scene: ThreeScene, s: SkyColors, intensity: number): void {
    if (intensity <= 0) {
      scene.environment = null;
      scene.environmentIntensity = 0;
      return;
    }
    const key = `${s.horizon}${s.mid}${s.zenith}${s.ground}${s.fogColor}${s.fogAmount}${s.skyBlend}`;
    if (key !== this.key || this.target === null) {
      this.key = key;
      this.nodes.set(s);
      const old = this.target;
      this.target = this.pmrem.fromScene(this.envScene, 0, 0.1, 50);
      old?.dispose();
    }
    scene.environment = this.target.texture;
    scene.environmentIntensity = intensity;
  }

  dispose(): void {
    this.target?.dispose();
    this.pmrem.dispose();
    const m = this.envScene.children[0] as Mesh;
    m.geometry.dispose();
    this.mat.dispose();
  }
}
