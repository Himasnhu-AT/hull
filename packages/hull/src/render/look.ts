// The `look` kind, resolved to plain numbers a backend can apply. Pure: no three.js, so it runs and is tested in Node.
import type { Look } from '../schema/look.ts';

export type ToneMapping = 'none' | 'linear' | 'reinhard' | 'cineon' | 'aces' | 'agx' | 'neutral';

export interface ResolvedPost {
  bloom: number;
  bloomThreshold: number;
  contrast: number;
  saturation: number;
  lift: readonly [number, number, number];
  gamma: readonly [number, number, number];
  gain: readonly [number, number, number];
  vignette: number;
  grain: number;
  fxaa: boolean;
  /** Most the speed cue draws at full speed; 0 is off. */
  speedBlur: number;
}

export interface ResolvedLook {
  /** Flat sky colour, or null when a gradient is used. */
  skyColor: string | null;
  /** Gradient colours, used when `skyColor` is null. */
  horizon: string;
  mid: string;
  zenith: string;
  fog: { color: string; near: number; far: number; density: number; skyBlend: number } | null;
  /** Hemisphere light: `color` from above, `ground` from below (the same colour when the look names none). */
  ambient: { color: string; ground: string; intensity: number; hemisphere: boolean };
  /** Sky light baked into an environment map; 0 means none. */
  environment: { intensity: number };
  /** Null when the look asks for no post effect at all, so the scene can go straight to the screen. */
  post: ResolvedPost | null;
  sun: {
    color: string;
    intensity: number;
    /** Unit vector from the scene towards the sun. */
    dir: readonly [number, number, number];
    shadows: boolean;
    shadowRange: number;
    /** Fraction of the range the shadowed area leads the camera by. */
    shadowLead: number;
    shadowSoftness: number;
    shadowNormalBias: number;
  };
  exposure: number;
  toneMapping: ToneMapping;
}

/** The rig the M0 cube was lit with, so a game with no look file looks the same as it always did. */
export const defaultLook: Look = {
  kind: 'look',
  sky: { color: '#14161b' },
  ambient: { color: '#ffffff', intensity: 0.6 },
  sun: { color: '#ffffff', strength: 2.2, elevationDeg: 45, azimuthDeg: 143.13, shadows: false },
  exposure: 1,
  toneMapping: 'none',
};

/** Compass bearing (0 is -Z, 90 is +X) and elevation above the horizon to the direction towards the sun. */
export function sunDirection(elevationDeg: number, azimuthDeg: number): [number, number, number] {
  const el = (elevationDeg * Math.PI) / 180;
  const az = (azimuthDeg * Math.PI) / 180;
  const flat = Math.cos(el);
  return [flat * Math.sin(az), Math.sin(el), -flat * Math.cos(az)];
}

/** Fills every gap from the default look, then turns angles into a direction. */
export function resolveLook(look: Look | undefined): ResolvedLook {
  const d = defaultLook;
  const sky = look?.sky;
  const gradient = sky !== undefined && (sky.horizon !== undefined || sky.mid !== undefined || sky.zenith !== undefined);
  const horizon = sky?.horizon ?? sky?.mid ?? sky?.zenith ?? '#a9c6dc';
  const sun = look?.sun;
  const f = look?.fog;
  let fog: ResolvedLook['fog'] = null;
  if (f !== undefined) fog = { color: f.color, near: f.near ?? 0, far: f.far ?? 1000, density: f.density ?? 0, skyBlend: f.skyBlend ?? 0.35 };
  const ambient = look?.ambient;
  const ambientColor = ambient?.color ?? '#ffffff';
  return {
    skyColor: gradient ? null : sky?.color ?? d.sky!.color!,
    horizon,
    mid: sky?.mid ?? horizon,
    zenith: sky?.zenith ?? sky?.mid ?? horizon,
    fog,
    ambient: { color: ambientColor, ground: ambient?.ground ?? ambientColor, intensity: ambient?.intensity ?? d.ambient!.intensity!, hemisphere: ambient?.ground !== undefined },
    // A gradient sky gets sky light by default so metals have something to reflect; a flat sky keeps the M0 look.
    environment: { intensity: look?.environment?.intensity ?? (gradient ? 0.4 : 0) },
    post: resolvePost(look?.post),
    sun: {
      color: sun?.color ?? '#ffffff',
      intensity: sun?.strength ?? d.sun!.strength!,
      dir: sunDirection(sun?.elevationDeg ?? d.sun!.elevationDeg!, sun?.azimuthDeg ?? d.sun!.azimuthDeg!),
      shadows: sun?.shadows ?? false,
      shadowRange: sun?.shadowRange ?? 40,
      shadowLead: sun?.shadowLead ?? 0,
      shadowSoftness: sun?.shadowSoftness ?? 1,
      shadowNormalBias: sun?.shadowNormalBias ?? 0.02,
    },
    exposure: look?.exposure ?? 1,
    toneMapping: look?.toneMapping ?? 'none',
  };
}

const ONE: readonly [number, number, number] = [1, 1, 1];
const ZERO: readonly [number, number, number] = [0, 0, 0];

/** Fills defaults; returns null when nothing in it changes the picture. */
export function resolvePost(p: NonNullable<Look['post']> | undefined): ResolvedPost | null {
  if (p === undefined) return null;
  const r: ResolvedPost = {
    bloom: p.bloom ?? 0,
    bloomThreshold: p.bloomThreshold ?? 1,
    contrast: p.contrast ?? 1,
    saturation: p.saturation ?? 1,
    lift: p.lift ?? ZERO,
    gamma: p.gamma ?? ONE,
    gain: p.gain ?? ONE,
    vignette: p.vignette ?? 0,
    grain: p.grain ?? 0,
    fxaa: p.aa === 'fxaa',
    speedBlur: p.speedBlur ?? 0,
  };
  const flat = (v: readonly number[], x: number): boolean => v.every((n) => n === x);
  const idle = r.bloom === 0 && r.contrast === 1 && r.saturation === 1 && flat(r.lift, 0) && flat(r.gamma, 1) && flat(r.gain, 1) && r.vignette === 0 && r.grain === 0 && !r.fxaa && r.speedBlur === 0;
  return idle ? null : r;
}

/** A post that changes nothing, for an impact pulse over a look with no post of its own. */
export const NEUTRAL_POST: ResolvedPost = {
  bloom: 0, bloomThreshold: 1, contrast: 1, saturation: 1, lift: ZERO, gamma: ONE, gain: ONE, vignette: 0, grain: 0, fxaa: false, speedBlur: 0,
};

/** What each quality tier keeps. Low draws straight to the screen with no shadows. */
export interface Tier {
  post: boolean;
  shadows: boolean;
  shadowMap: number;
  /** MSAA samples on the scene target when post is on. */
  samples: number;
  grain: boolean;
  fxaa: boolean;
  /** Levels in the bloom pyramid. */
  bloomLevels: number;
  dprCap: number;
}

export const TIERS: Record<'low' | 'medium' | 'high', Tier> = {
  low: { post: false, shadows: false, shadowMap: 1024, samples: 0, grain: false, fxaa: false, bloomLevels: 0, dprCap: 1 },
  medium: { post: true, shadows: true, shadowMap: 2048, samples: 4, grain: false, fxaa: false, bloomLevels: 4, dprCap: 1.5 },
  high: { post: true, shadows: true, shadowMap: 4096, samples: 4, grain: true, fxaa: true, bloomLevels: 5, dprCap: 2 },
};

/** The post settings a tier will really draw: null when the tier has no post, else the look's with the tier's cuts. */
export function postFor(post: ResolvedPost | null, tier: Tier): ResolvedPost | null {
  if (post === null || !tier.post) return null;
  const r = { ...post, grain: tier.grain ? post.grain : 0, fxaa: tier.fxaa ? post.fxaa : false };
  if (tier.bloomLevels === 0) r.bloom = 0;
  return r;
}

/**
 * Moves the shadow camera's target to a whole number of shadow-map texels along the light's right and up axes.
 * Without this, the shadow map slides by fractions of a texel as the camera moves and the edges shimmer.
 * `dir` is the unit vector towards the sun; `range` the half-width of the shadowed square. Writes into `out`.
 */
export function snapShadowTarget(
  x: number, y: number, z: number,
  dir: readonly [number, number, number],
  range: number,
  mapSize: number,
  out: [number, number, number],
): void {
  const texel = (2 * range) / mapSize;
  // The light's basis: d (towards the sun), r (right), u (up).
  const [dx, dy, dz] = dir;
  let rx: number, ry: number, rz: number;
  if (Math.abs(dy) > 0.99) { rx = 1; ry = 0; rz = 0; }
  else { rx = dz; ry = 0; rz = -dx; } // cross(up, d) with up = (0,1,0)
  const rl = Math.hypot(rx, ry, rz);
  rx /= rl; ry /= rl; rz /= rl;
  const ux = dy * rz - dz * ry, uy = dz * rx - dx * rz, uz = dx * ry - dy * rx;
  const a = x * rx + y * ry + z * rz;
  const b = x * ux + y * uy + z * uz;
  const da = Math.round(a / texel) * texel - a;
  const db = Math.round(b / texel) * texel - b;
  out[0] = x + rx * da + ux * db;
  out[1] = y + ry * da + uy * db;
  out[2] = z + rz * da + uz * db;
}
