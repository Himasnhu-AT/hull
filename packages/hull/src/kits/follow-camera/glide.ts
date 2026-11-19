// The maths of a chase camera that a game with its own camera node can use without the FollowCamera behaviour:
// how far back it sits for a speed, how it eases out of and back from a wall, how wide its lens opens.

/** An exponential catch-up factor for a rate (1/s): the share of the remaining gap closed in `dt`. */
export function damp(rate: number, dt: number): number { return 1 - Math.exp(-rate * dt); }

/** Distance behind the target: `base` plus `perSpeed` per m/s up to `speedCap`, plus `extra`. */
export function followDistance(base: number, speed: number, perSpeed: number, speedCap: number, extra: number): number {
  return base + Math.min(speed, speedCap) * perSpeed + extra;
}

export function smoothstep(x: number, lo: number, hi: number): number {
  if (x <= lo) return 0;
  if (x >= hi) return 1;
  const t = (x - lo) / (hi - lo);
  return t * t * (3 - 2 * t);
}

/** Lens angle that opens from `fov` to `fovMax` as speed goes from `lo` to `hi`. */
export function followFov(fov: number, fovMax: number, speed: number, lo: number, hi: number): number {
  return fov + (fovMax - fov) * smoothstep(speed, lo, hi);
}

/**
 * How far from the pivot the camera really sits when a wall may be in the way. `reach` follows the clear distance:
 * it glides in at `inRate` and back out at `outRate`, never beyond `len`, the wanted distance.
 */
export class Reach {
  /** NaN until the first update. */
  value = NaN;

  /** Returns true when the camera is moving in toward a wall, so the caller may check the spot for overlap. */
  update(len: number, clear: number, dt: number, inRate: number, outRate: number): boolean {
    if (Number.isNaN(this.value) || this.value > len) this.value = Math.min(Number.isNaN(this.value) ? len : this.value, len);
    if (clear < this.value) {
      this.value += (clear - this.value) * damp(inRate, dt);
      return true;
    }
    this.value += (Math.min(clear, len) - this.value) * damp(outRate, dt);
    return false;
  }
}
