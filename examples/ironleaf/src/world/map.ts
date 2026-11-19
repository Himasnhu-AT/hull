// The map of Hoshiro: where things are and how high the ground is. Pure functions of (x, z), no scene objects, so
// tests, the sound code and the spawner can all ask the same questions. Metres; +y is up; the player lands on the west beach.
import { clamp, fbm, lerp, smoothstep } from './rng';

export interface Spot { x: number; z: number; r: number }

/** The island's sea level: the ground is 0 at the water's edge. */
export const SEA = 0;
/** Where Aya starts: the landing beach. */
export const LANDING = { x: -84, z: 30, yaw: -Math.PI / 2 };
export const VILLAGE: Spot = { x: 62, z: -20, r: 30 };
export const SHRINE: Spot = { x: 90, z: -64, r: 22 };
export const GROVES: Spot[] = [{ x: -55, z: -60, r: 30 }, { x: 22, z: 64, r: 26 }, { x: 104, z: 24, r: 20 }];
export const PAMPAS: Spot[] = [{ x: -48, z: 8, r: 58 }, { x: -5, z: -28, r: 36 }, { x: 8, z: 30, r: 28 }, { x: -76, z: -20, r: 22 }];
export const GATE = { x: 44, z: -12 };

/** The main paths, as polylines of (x, z). Every one starts or ends at another, so the island reads as a road network. */
export const PATHS: number[][][] = [
  [[-84, 30], [-62, 22], [-34, 12], [-4, 2], [24, -6], [44, -12], [62, -20]],
  [[62, -20], [74, -34], [84, -50], [90, -62]],
  [[-4, 2], [8, 30], [14, 50], [22, 64]],
  [[-34, 12], [-44, -20], [-52, -44], [-55, -60]],
  [[62, -20], [86, 4], [104, 24]],
];

export function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const t = clamp(((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1), 0, 1);
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

/** Distance to the nearest path. */
export function pathDistance(x: number, z: number): number {
  let best = 1e9;
  for (const p of PATHS) for (let i = 0; i + 1 < p.length; i++) best = Math.min(best, distToSegment(x, z, p[i]![0]!, p[i]![1]!, p[i + 1]![0]!, p[i + 1]![1]!));
  return best;
}

const inSpot = (x: number, z: number, s: Spot): number => 1 - smoothstep(s.r * 0.6, s.r, Math.hypot(x - s.x, z - s.z));

/** Ground height in metres. */
export function groundHeight(x: number, z: number): number {
  const rr = Math.hypot(x, z * 1.12) / 132;
  const land = 1 - smoothstep(0.52, 1.0, rr);
  let h = -3.2 + land * 5.9;
  h += (fbm(x * 0.012, z * 0.012, 3) - 0.5) * 7 * land;
  h += (fbm(x * 0.05, z * 0.05, 9) - 0.5) * 0.9 * land;
  // a shallow basin under the pampas, a plateau for the village, a steep hill for the shrine
  h -= inSpot(x, z, PAMPAS[0]!) * 0.8;
  h = lerp(h, 6.4, inSpot(x, z, VILLAGE));
  h += inSpot(x, z, SHRINE) * 10;
  // paths are trodden a little lower
  h -= (1 - smoothstep(0.5, 2.4, pathDistance(x, z))) * 0.12 * land;
  return h;
}

export type Surface = 'grass' | 'dirt' | 'sand' | 'stone' | 'wood' | 'mud';

/** What a footstep lands on. */
export function surfaceAt(x: number, z: number): Surface {
  const h = groundHeight(x, z);
  if (h < 0.9) return 'sand';
  if (Math.hypot(x - SHRINE.x, z - SHRINE.z) < 7) return 'stone';
  if (Math.hypot(x - VILLAGE.x, z - VILLAGE.z) < 9) return 'wood';
  if (pathDistance(x, z) < 2.2) return 'dirt';
  return 'grass';
}

/** How much pampas grows at a point, 0..1. */
export function pampasAmount(x: number, z: number): number {
  const h = groundHeight(x, z);
  if (h < 0.7 || h > 8) return 0;
  let m = 0;
  for (const s of PAMPAS) m = Math.max(m, inSpot(x, z, s));
  m *= 0.55 + 0.9 * fbm(x * 0.045, z * 0.045, 21);
  m *= smoothstep(1.0, 3.5, pathDistance(x, z));
  m *= 1 - inSpot(x, z, VILLAGE);
  for (const s of GROVES) m *= 1 - inSpot(x, z, s);
  return clamp(m, 0, 1);
}

/** How much bamboo stands at a point, 0..1. */
export function bambooAmount(x: number, z: number): number {
  let m = 0;
  for (const s of GROVES) m = Math.max(m, inSpot(x, z, s));
  return clamp(m * (0.4 + fbm(x * 0.08, z * 0.08, 33)) * smoothstep(2.2, 4, pathDistance(x, z)), 0, 1);
}

/** Where the raiders stand. Each is a spot on the map, the character and how it faces. */
export const CAST: { id: string; kind: string; x: number; z: number; yaw: number }[] = [
  { id: 'camp-sword-1', kind: 'ashblade', x: -22, z: 14, yaw: 0.6 },
  { id: 'camp-sword-2', kind: 'ashblade', x: -17, z: 22, yaw: 0.2 },
  { id: 'camp-sword-3', kind: 'ashblade', x: -27, z: 20, yaw: 1.0 },
  { id: 'camp-spear-1', kind: 'ashpike', x: -12, z: 12, yaw: 0.9 },
  { id: 'camp-spear-2', kind: 'ashpike', x: -24, z: 7, yaw: 1.4 },
  { id: 'gate-hulk', kind: 'hulk', x: 52, z: -14, yaw: 1.9 },
  { id: 'rock-archer', kind: 'ashkite', x: 28, z: -34, yaw: 0.7 },
  { id: 'stairs-duelist', kind: 'kagari', x: 82, z: -50, yaw: 2.6 },
];
