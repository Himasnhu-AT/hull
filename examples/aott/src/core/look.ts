// The realistic look, game side: an aerial-perspective fog curve and a tight sun-shadow frustum that follows the action
// without shimmering. Tone mapping, exposure, the sky-baked image light and the post chain are the engine's: they come
// from config/look/*.json (see PORT.md), so the renderer is never touched from here.
import * as THREE from 'hull/three';

/** Values other modules tune their materials against. */
export const LOOK = {
  toneMapping: THREE.ACESFilmicToneMapping as THREE.ToneMapping,
  exposure: 1.0,
  /** scene.environmentIntensity for the sky-gradient IBL (it adds to the world's hemisphere light). */
  envIntensity: 0.4,
  /** Haze extinction length as a multiple of the fog's far distance (see installAerialFog). */
  hazeLength: 1.1,
} as const;

/** Per-quality sun shadow settings: map size, half-width of the ortho frustum (m), PCF blur radius (texels). */
export interface ShadowPreset { map: number; half: number; radius: number }
export const SHADOW: Record<'high' | 'medium', ShadowPreset> = {
  high: { map: 2048, half: 75, radius: 3 },
  medium: { map: 1024, half: 62, radius: 2 },
};

let _fogPatched = false;
/**
 * Swaps three's linear fog curve for aerial perspective: an exponential haze from the camera out (extinction length
 * hazeLength x far), topped up by the linear near..far ramp so the world's edge is still fully hidden at `far`.
 * Every material and custom shader that includes the fog chunks gets it; THREE.Fog's near/far API is unchanged.
 * Call before the first render.
 */
export function installAerialFog(hazeLength: number = LOOK.hazeLength): void {
  if (_fogPatched) return;
  _fogPatched = true;
  THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = max( 1.0 - exp( - vFogDepth / ( ${hazeLength.toFixed(3)} * fogFar ) ), smoothstep( fogNear, fogFar, vFogDepth ) );
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`;
}

/** Sizes the sun's shadow map and ortho frustum for a quality preset (null: shadows off). */
export function fitSunShadow(sun: THREE.DirectionalLight, preset: ShadowPreset | null): void {
  sun.castShadow = !!preset;
  if (!preset) return;
  const sh = sun.shadow, cam = sh.camera;
  if (sh.mapSize.x !== preset.map) {
    sh.mapSize.set(preset.map, preset.map);
    sh.map?.dispose();
    sh.map = null;
  }
  cam.left = -preset.half; cam.right = preset.half; cam.top = preset.half; cam.bottom = -preset.half;
  cam.updateProjectionMatrix();
  sh.radius = preset.radius;
}

const _UP = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3(), _right = new THREE.Vector3(), _upL = new THREE.Vector3(), _c = new THREE.Vector3();
/**
 * Centres the sun's shadow frustum on `centre` pushed `lead` metres along `forward` (horizontal), so more of the
 * map covers what the camera sees. The centre snaps to whole shadow texels in light space, so shadows stay still
 * while the frustum slides. `offset`: sun position relative to its target (fixed length).
 */
export function followSunShadow(sun: THREE.DirectionalLight, centre: THREE.Vector3, forward: THREE.Vector3 | null, lead: number, offset: THREE.Vector3): void {
  _c.copy(centre);
  if (forward) {
    const fx = forward.x, fz = forward.z, l = Math.sqrt(fx * fx + fz * fz);
    if (l > 1e-4) { _c.x += (fx / l) * lead; _c.z += (fz / l) * lead; }
  }
  // the shadow camera's basis (Object3D.lookAt from the sun towards its target, up = +y)
  _dir.copy(offset).normalize();
  _right.crossVectors(_UP, _dir).normalize();
  _upL.crossVectors(_dir, _right);
  const cam = sun.shadow.camera;
  const texel = (cam.right - cam.left) / Math.max(1, sun.shadow.mapSize.x);
  const a = Math.round(_c.dot(_right) / texel) * texel;
  const b = Math.round(_c.dot(_upL) / texel) * texel;
  const d = _c.dot(_dir);
  sun.target.position.set(0, 0, 0).addScaledVector(_right, a).addScaledVector(_upL, b).addScaledVector(_dir, d);
  sun.position.copy(sun.target.position).add(offset);
  sun.target.updateMatrixWorld();
}
