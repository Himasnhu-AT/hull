// What a hit on a body part does, as numbers: below the first threshold nothing, above it a shallow wound, above the
// second the part comes off (or the eye is put out). The game decides what "comes off" means; this says whether it does.

export const ZONE_NONE = 0;
export const ZONE_SHALLOW = 1;
export const ZONE_CUT = 2;

/**
 * `damage` against a part that is cut at `cutAt` and only wounded above `shallowAt`. Returns ZONE_CUT, ZONE_SHALLOW or
 * ZONE_NONE. A `cutAt` of 0 or less means the part cannot be cut.
 */
export function zoneEffect(damage: number, cutAt: number, shallowAt: number): number {
  if (cutAt > 0 && damage >= cutAt) return ZONE_CUT;
  return damage > shallowAt ? ZONE_SHALLOW : ZONE_NONE;
}

/** Damage after a part's cover: `cover` 0 to 1 (a hunched neck), `strength` how much full cover takes away (0.7 = 70 per cent). */
export function coveredDamage(damage: number, cover: number, strength: number): number {
  return damage * (1 - strength * cover);
}

/** Hit points regained over `dt` once `sinceHurt` seconds have passed without a hurt; `hp` and the result are fractions of full. */
export function regenerate(hp: number, dt: number, sinceHurt: number, delay: number, rate: number): number {
  return sinceHurt > delay && hp < 1 ? Math.min(1, hp + dt * rate) : hp;
}
