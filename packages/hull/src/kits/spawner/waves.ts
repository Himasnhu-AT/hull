// The clock of an endless wave run, without any enemies in it: when the next wave starts, when a cleared wave is
// announced, and when a straggler walks in. A game that builds its own enemies (not the kit's Chaser) keeps its own
// state object with these four fields and calls `stepWaves` once per step; what a wave contains stays the game's.

/** The numbers of the clock. A game's tunables block can be passed as is: it is read live on every call. */
export interface WaveRules {
  /** Seconds between "wave cleared" and the next wave. */
  clearPause: number;
  /** A wave also starts on a clock, even if enemies are left: after `max(clockMin, clockBase - wave * clockPerWave)` seconds. */
  clockBase: number;
  clockPerWave: number;
  clockMin: number;
  /** The most enemies alive while a straggler or a clock wave may still come: `min(capMax, capBase + wave * capPerWave)`. */
  capBase: number;
  capPerWave: number;
  capMax: number;
  /** Seconds between stragglers: `max(trickleMin, trickleBase - wave * trickleDrop)`; the first one waits `firstTrickle`. */
  trickleBase: number;
  trickleDrop: number;
  trickleMin: number;
  firstTrickle: number;
}

/** The four timers; any object with these fields (a game's flow) is a wave state. */
export interface WaveState {
  /** Waves started so far. */
  wave: number;
  /** Seconds until the next wave while the field is clear; 0 when not counting. */
  waveClear: number;
  /** Seconds the current wave has run. */
  waveT: number;
  /** Seconds until the next straggler. */
  trickleT: number;
}

export const WAVE_NONE = 0;
/** Start the next wave now (call `beginWave` and spawn it). */
export const WAVE_NEXT = 1;
/** The field just emptied: announce it; `waveClear` is now counting down to the next wave. */
export const WAVE_CLEARED = 2;
/** Send one straggler. */
export const WAVE_TRICKLE = 3;

export function newWaveState(): WaveState { return { wave: 0, waveClear: 0, waveT: 0, trickleT: 0 }; }

export function resetWaves(s: WaveState): void { s.wave = 0; s.waveClear = 0; s.waveT = 0; s.trickleT = 0; }

/** Most enemies alive for this wave number. */
export function waveCap(wave: number, r: WaveRules): number { return Math.min(r.capMax, r.capBase + wave * r.capPerWave); }

/** Seconds a wave may run before the next one comes regardless. */
export function waveClock(wave: number, r: WaveRules): number { return Math.max(r.clockMin, r.clockBase - wave * r.clockPerWave); }

/**
 * Count up the wave number and restart its timers. Returns the zero-based index of the wave that starts (0 for the
 * first), which is what a wave table is indexed by.
 */
export function beginWave(s: WaveState, r: WaveRules): number {
  const idx = s.wave;
  s.wave++;
  s.waveT = 0;
  s.trickleT = r.firstTrickle;
  return idx;
}

/**
 * How much a wave past the end of the table grows: 1 inside the table, then `growth` more for each extra wave.
 */
export function waveScale(idx: number, tableLength: number, growth: number): number {
  return 1 + Math.max(0, idx - tableLength + 1) * growth;
}

/**
 * One step of the clock. `alive` counts enemies up, `queued` those waiting to be built, `hold` is true while something
 * (a boss still standing) keeps the field from counting as clear. Returns one of the WAVE_ codes; no allocation.
 */
export function stepWaves(s: WaveState, dt: number, alive: number, queued: number, hold: boolean, r: WaveRules): number {
  if (s.waveClear > 0) {
    s.waveClear -= dt;
    return s.waveClear <= 0 ? WAVE_NEXT : WAVE_NONE;
  }
  if (alive === 0 && queued === 0 && !hold) {
    s.waveClear = r.clearPause;
    return s.wave > 0 ? WAVE_CLEARED : WAVE_NONE;
  }
  if (s.wave <= 0) return WAVE_NONE;
  s.waveT += dt;
  const cap = waveCap(s.wave, r);
  if (s.waveT > waveClock(s.wave, r) && alive < cap) return WAVE_NEXT;
  s.trickleT -= dt;
  if (s.trickleT <= 0) {
    s.trickleT = Math.max(r.trickleMin, r.trickleBase - s.wave * r.trickleDrop);
    if (alive + queued < cap) return WAVE_TRICKLE;
  }
  return WAVE_NONE;
}
