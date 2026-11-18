// The sky as light. The sky gradient (with the fog colour banded in at the horizon) is drawn once into a cube and
// prefiltered with PMREM, then set as the scene's environment: metals reflect the sky instead of black, and every
// material gets a soft fill from above. Rebaked only when the colours change.
import {
  BackSide,
  Color,
  Mesh,
  PMREMGenerator,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  type Scene as ThreeScene,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';

/** The one gradient used by the visible sky dome and by the environment bake, so reflections match what is seen. */
export const SKY_GLSL = /* glsl */ `
uniform vec3 horizon; uniform vec3 mid; uniform vec3 zenith; uniform vec3 ground;
uniform vec3 fogColor; uniform float fogAmount; uniform float skyBlend;
vec3 skyColor(vec3 dir) {
  float h = normalize(dir).y;
  vec3 c = mix(horizon, mid, smoothstep(0.0, 0.35, h));
  c = mix(c, zenith, smoothstep(0.35, 1.0, h));
  // Fog climbs the sky from the horizon, so distant geometry fades into a sky of the same colour.
  float k = 1.0 - smoothstep(0.0, max(skyBlend, 0.001), max(h, 0.0));
  return mix(c, fogColor, k * fogAmount);
}`;

export interface SkyColors {
  horizon: string;
  mid: string;
  zenith: string;
  ground: string;
  fogColor: string;
  fogAmount: number;
  skyBlend: number;
}

export function skyUniforms() {
  return {
    horizon: { value: new Color() }, mid: { value: new Color() }, zenith: { value: new Color() }, ground: { value: new Color() },
    fogColor: { value: new Color() }, fogAmount: { value: 0 }, skyBlend: { value: 0.35 },
  };
}

export function setSkyUniforms(u: ReturnType<typeof skyUniforms>, s: SkyColors): void {
  u.horizon.value.set(s.horizon);
  u.mid.value.set(s.mid);
  u.zenith.value.set(s.zenith);
  u.ground.value.set(s.ground);
  u.fogColor.value.set(s.fogColor);
  u.fogAmount.value = s.fogAmount;
  u.skyBlend.value = s.skyBlend;
}

export class SkyEnvironment {
  private readonly pmrem: PMREMGenerator;
  private readonly envScene = new Scene();
  private readonly uniforms = skyUniforms();
  private target: WebGLRenderTarget | null = null;
  private key = '';

  constructor(renderer: WebGLRenderer) {
    this.pmrem = new PMREMGenerator(renderer);
    const mat = new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      uniforms: this.uniforms,
      vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `${SKY_GLSL}
        varying vec3 vDir;
        void main() {
          // Below the horizon a reflection sees the ground, not the sky.
          vec3 c = vDir.y >= 0.0 ? skyColor(vDir) : mix(skyColor(vec3(vDir.x, 0.0, vDir.z)), ground, smoothstep(0.0, 0.5, -normalize(vDir).y));
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.envScene.add(new Mesh(new SphereGeometry(10, 32, 16), mat));
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
      setSkyUniforms(this.uniforms, s);
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
    (m.material as ShaderMaterial).dispose();
  }
}
