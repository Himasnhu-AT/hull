// The part of a frame's setup that both backends share: fog, ambient light, the sun and its shadow box. These are
// plain three.js scene objects (the core classes are the same ones `three` and `three/webgpu` export), so the two
// backends light the scene from one piece of code and cannot drift apart.
import { Color, Fog, FogExp2, type DirectionalLight, type HemisphereLight, type Scene } from 'three';
import { snapShadowTarget, type ResolvedLook, type Tier } from './look.ts';

/** Fog, hemisphere light and sun from a resolved look. The tier says whether the sun may cast shadows. */
export function applyRig(scene: Scene, ambient: HemisphereLight, sun: DirectionalLight, r: ResolvedLook, q: Tier): void {
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
  ambient.color.set(r.ambient.color);
  ambient.groundColor.set(r.ambient.ground);
  ambient.intensity = r.ambient.intensity;
  sun.color.set(r.sun.color);
  sun.intensity = r.sun.intensity;
  sun.castShadow = r.sun.shadows && q.shadows;
  const c = sun.shadow.camera;
  const range = r.sun.shadowRange;
  const reach = Math.max(60, range * 4);
  if (c.right !== range || c.far !== reach + range * 2) {
    c.left = -range; c.right = range; c.top = range; c.bottom = -range;
    c.near = 0.5;
    c.far = reach + range * 2;
    c.updateProjectionMatrix();
  }
}

/** The sky colour as a scene background, for looks with a flat sky; the gradient dome is drawn instead otherwise. */
export function flatBackground(scene: Scene, hex: string): void {
  const bg = scene.background instanceof Color ? scene.background : new Color();
  bg.set(hex);
  scene.background = bg;
}

/**
 * Puts the sun where it lights what the camera sees: its target is snapped to whole shadow-map texels (so edges do not
 * crawl as the camera moves) and it stands `reach` metres towards the sun from there. `snapped` is scratch.
 */
export function placeSun(sun: DirectionalLight, r: ResolvedLook, cx: number, cy: number, cz: number, shadowMapSize: number, snapped: [number, number, number]): void {
  const d = r.sun.dir;
  snapShadowTarget(cx, cy, cz, d, r.sun.shadowRange, shadowMapSize, snapped);
  sun.target.position.set(snapped[0], snapped[1], snapped[2]);
  const reach = Math.max(60, r.sun.shadowRange * 4);
  sun.position.set(snapped[0] + d[0] * reach, snapped[1] + d[1] * reach, snapped[2] + d[2] * reach);
}

/** A hex colour at 40% brightness, for the ground a reflection sees when the look names no ground colour. */
export function darken(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.round(v * 0.4).toString(16).padStart(2, '0');
  return `#${f((n >> 16) & 255)}${f((n >> 8) & 255)}${f(n & 255)}`;
}

/** The sky colours both the dome and the environment bake are drawn from, for a resolved look. */
export function skyFor(r: ResolvedLook) {
  const fogOn = r.fog !== null;
  return {
    horizon: r.horizon,
    mid: r.mid,
    zenith: r.zenith,
    ground: r.ambient.hemisphere ? r.ambient.ground : darken(r.horizon),
    fogColor: r.fog?.color ?? r.horizon,
    fogAmount: fogOn ? 1 : 0,
    skyBlend: r.fog?.skyBlend ?? 0.35,
  };
}
