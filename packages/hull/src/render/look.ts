// The `look` kind, resolved to plain numbers a backend can apply. Pure: no three.js, so it runs and is tested in Node.
import type { Look } from '../schema/look.ts';

export type ToneMapping = 'none' | 'linear' | 'reinhard' | 'cineon' | 'aces' | 'agx' | 'neutral';

export interface ResolvedLook {
  /** Flat sky colour, or null when a gradient is used. */
  skyColor: string | null;
  /** Gradient colours, used when `skyColor` is null. */
  horizon: string;
  mid: string;
  zenith: string;
  fog: { color: string; near: number; far: number; density: number } | null;
  ambient: { color: string; intensity: number };
  sun: {
    color: string;
    intensity: number;
    /** Unit vector from the scene towards the sun. */
    dir: readonly [number, number, number];
    shadows: boolean;
    shadowRange: number;
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
  if (f !== undefined) fog = { color: f.color, near: f.near ?? 0, far: f.far ?? 1000, density: f.density ?? 0 };
  const ambient = look?.ambient;
  return {
    skyColor: gradient ? null : sky?.color ?? d.sky!.color!,
    horizon,
    mid: sky?.mid ?? horizon,
    zenith: sky?.zenith ?? sky?.mid ?? horizon,
    fog,
    ambient: { color: ambient?.color ?? '#ffffff', intensity: ambient?.intensity ?? d.ambient!.intensity! },
    sun: {
      color: sun?.color ?? '#ffffff',
      intensity: sun?.strength ?? d.sun!.strength!,
      dir: sunDirection(sun?.elevationDeg ?? d.sun!.elevationDeg!, sun?.azimuthDeg ?? d.sun!.azimuthDeg!),
      shadows: sun?.shadows ?? false,
      shadowRange: sun?.shadowRange ?? 40,
    },
    exposure: look?.exposure ?? 1,
    toneMapping: look?.toneMapping ?? 'none',
  };
}
