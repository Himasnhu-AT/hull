// Distance attenuation and panning: pure maths, so the roll-off can be tested and tuned without a speaker.

export type Vec3 = readonly [number, number, number];

/**
 * Linear gain at `distance`: full level inside `ref`, a 1/d fall-off beyond it (6 dB per doubling, like the air),
 * and a fade to exactly silent at `max` so a far sound can be dropped instead of kept alive for nothing.
 */
export function distanceGain(distance: number, ref: number, max: number): number {
  if (distance <= ref) return 1;
  if (distance >= max) return 0;
  const inverse = ref / distance;
  // Over the last quarter of the range the 1/d curve is blended down to zero.
  const fadeStart = ref + (max - ref) * 0.75;
  if (distance <= fadeStart) return inverse;
  const t = (distance - fadeStart) / (max - fadeStart);
  return inverse * (1 - t * t * (3 - 2 * t));
}

/** Low-pass cutoff in Hz for air absorption: open at `ref`, closing on a log scale to 1.2 kHz at `max`. */
export function airCutoff(distance: number, ref: number, max: number): number {
  const t = Math.min(1, Math.max(0, (distance - ref) / Math.max(1e-6, max - ref)));
  return 20000 * Math.pow(1200 / 20000, t);
}

/** Stereo pan, -1 (left) to 1 (right), from where the source is relative to a listener facing `forward`. */
export function panFor(listener: Vec3, forward: Vec3, source: Vec3): number {
  const dx = source[0] - listener[0];
  const dz = source[2] - listener[2];
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return 0;
  // Right-hand side of a listener facing `forward` on the ground plane (y up): right = forward x up.
  const rx = -forward[2];
  const rz = forward[0];
  const rl = Math.hypot(rx, rz) || 1;
  // Not a full -1/1 at 90 degrees: sources close to the side should still leave a little in the other ear.
  return Math.max(-1, Math.min(1, ((dx * rx + dz * rz) / (len * rl)) * 0.9));
}

export const distanceBetween = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
