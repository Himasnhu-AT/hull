// One-shot sound effects. Every function takes the Audio instance `A` first and builds a short-lived
// node graph through a `Rig` (see dsp.ts) that disposes itself when its last source ends.
import { clamp, rand, pick, perc } from './dsp';
import type { Rig } from './dsp';
import type { Audio, Vec3Like } from './audio';
import { R } from '../sim';

/** Which launcher: 0 / 'left' / 'l' is the left one, anything else the right. */
export type Side = number | string | null | undefined;
type Pos = Vec3Like | null | undefined;

export const now = (A: Audio): number => (A.ctx as BaseAudioContext).currentTime + 0.004;
const sideInfo = (side: Side): number => ((side === 0 || side === 'left' || side === 'l') ? -0.6 : 0.6);
export const finite = (v: number | undefined, d: number): number => (v !== undefined && Number.isFinite(v) ? v : d);

// ───────────────────────────────────────────────────────────────────────── tether gear

export function hookFire(A: Audio, side?: Side): void {
  const r = A._rig('hook', 6); if (!r) return;
  const t = now(A);
  const o = A._dest(r, { pan: sideInfo(side), rev: 0.1, vol: 0.9 });
  // pneumatic launch: piston thump + "pshh" + sharp transient
  r.tone(o, { f0: 240, f1: 52, glide: 0.07, t, peak: 0.6, d: 0.12 });
  r.burst(o, { t, peak: 0.5, a: 0.003, d: 0.15, type: 'bandpass', f0: 3400, f1: 1100, sweep: 0.13, q: 0.9 });
  r.burst(o, { t, peak: 0.32, a: 0.0008, d: 0.03, type: 'highpass', f0: 4200, q: 0.7 });
  // metallic "k": the hook leaving its cradle
  r.modes(o, { t: t + 0.055, f: [2350, 3180, 4620], decay: 0.035, peak: 0.2 });
  // ratchet of the wire unspooling
  for (let i = 0; i < 5; i++) {
    const tt = t + 0.07 + i * 0.034 + i * i * 0.0012;
    r.modes(o, { t: tt, f: [rand(1800, 2000), rand(2850, 3050), 4100], decay: 0.016, peak: 0.13 * (1 - i * 0.12) });
    r.burst(o, { t: tt, peak: 0.07, a: 0.0005, d: 0.01, type: 'bandpass', f0: 3600, q: 2 });
  }
  // whizzing wire, dropping in pitch as the hook speeds away (kept short: this fires constantly)
  r.burst(o, { t: t + 0.02, peak: 0.28, a: 0.01, d: 0.3, type: 'bandpass', f0: 6800, f1: 1700, sweep: 0.28, q: 8 });
  r.tone(o, { f0: 3300, f1: 1900, glide: 0.28, t: t + 0.03, peak: 0.045, a: 0.015, d: 0.24 });
}

export function hookHit(A: Audio, material?: string, pos?: Pos): void {
  const r = A._rig('hit', 5); if (!r) return;
  const pl = pos ? A._place(r, pos, 4, { ref: 25 }) : null;
  const t = now(A);
  const o = A._dest(r, { rev: 0.12, vol: 0.85, to: pl && pl.in, revScale: pl ? pl.rev : 1 });
  // Each surface answers in its own band (thud -> squelch -> crunch -> knock -> clack -> crack -> ring), so they tell
  // apart on any speaker; the low thump stays modest because this fires constantly and would pump the mix.
  const j = rand(0.94, 1.06);
  const bite = (peak = 0.07): void => { // the steel head biting in
    r.modes(o, { t, f: [3300 * j, 4700 * j], decay: 0.02, peak });
    r.burst(o, { t, peak: peak * 2, a: 0.0005, d: 0.008, type: 'highpass', f0: 3200 });
  };
  const ticks = (n: number, lo: number, hi: number, span: number, peak: number, q = 3): void => {
    for (let i = 0; i < n; i++) r.burst(o, { t: t + rand(0.012, span), peak: peak * rand(0.5, 1), a: 0.0005, d: rand(0.012, 0.026), type: 'bandpass', f0: rand(lo, hi), q });
  };
  switch (material) {
    case 'wood': // hollow knock of a beam or a plank
      r.tone(o, { f0: 200 * j, f1: 78, glide: 0.08, t, peak: 0.4, d: 0.11 });
      r.burst(o, { t, peak: 0.5, a: 0.001, d: 0.04, type: 'lowpass', f0: 1900, q: 0.7 });
      r.modes(o, { t, f: [430 * j, 760 * j, 1290 * j, 2100 * j], decay: 0.1, peak: 0.5 });
      r.modes(o, { t: t + 0.042, f: [520 * j, 930 * j], decay: 0.04, peak: 0.13 }); // the board answering
      bite();
      break;
    case 'bark': // dull crunch, splinters
      r.tone(o, { f0: 150 * j, f1: 56, glide: 0.09, t, peak: 0.34, d: 0.13 });
      r.burst(o, { kind: 'pink', t, peak: 0.9, d: 0.07, type: 'lowpass', f0: 850, q: 0.7 });
      r.burst(o, { t, peak: 1.0, a: 0.001, d: 0.05, type: 'bandpass', f0: 1500 * j, q: 1 });
      r.modes(o, { t, f: [310 * j, 560 * j], decay: 0.08, peak: 0.2 });
      ticks(4, 1800, 3800, 0.11, 0.45, 2.5);
      bite(0.05);
      break;
    case 'stone': // crack, ring, chips
      r.burst(o, { t, peak: 0.42, a: 0.0006, d: 0.03, type: 'highpass', f0: 2500 });
      r.modes(o, { t, f: [1830 * j, 2740 * j, 4310 * j, 5900 * j], decay: 0.13, peak: 0.27 });
      r.tone(o, { f0: 150, f1: 60, glide: 0.06, t, peak: 0.4, d: 0.1 });
      ticks(4, 1800, 4400, 0.22, 0.2);
      break;
    case 'flesh': // wet slap into a titan
      r.tone(o, { f0: 125, f1: 44, glide: 0.1, t, peak: 0.3, d: 0.15 });
      r.burst(o, { kind: 'pink', t, peak: 0.9, d: 0.1, type: 'lowpass', f0: 600, q: 0.7 });
      r.burst(o, { kind: 'pink', t, peak: 1.4, a: 0.004, d: 0.15, type: 'bandpass', f0: 1150, f1: 420, sweep: 0.14, q: 2.2 });
      r.burst(o, { kind: 'pink', t: t + 0.03, peak: 0.7, a: 0.02, d: 0.12, type: 'bandpass', f0: 1900, f1: 700, sweep: 0.14, q: 3 });
      break;
    case 'roof': // clay tile: clack, crack, a shard skittering off
      r.modes(o, { t, f: [1100 * j, 2080 * j, 3300 * j, 4400 * j], decay: 0.06, peak: 0.36 });
      r.burst(o, { t, peak: 0.34, a: 0.0008, d: 0.03, type: 'bandpass', f0: 2800, q: 1.2 });
      r.burst(o, { t, peak: 0.24, a: 0.0006, d: 0.016, type: 'highpass', f0: 4200 });
      r.tone(o, { f0: 170, f1: 80, glide: 0.06, t, peak: 0.32, d: 0.09 });
      r.modes(o, { t: t + rand(0.055, 0.08), f: [980 * j, 1900 * j, 2900 * j], decay: 0.05, peak: 0.16 });
      r.modes(o, { t: t + rand(0.12, 0.17), f: [1350 * j, 2500 * j], decay: 0.03, peak: 0.08 });
      break;
    case 'metal': // struck plate ringing on
      r.burst(o, { t, peak: 0.4, a: 0.0006, d: 0.025, type: 'highpass', f0: 3000 });
      r.modes(o, { t, f: [640 * j, 1130 * j, 1790 * j, 2530 * j, 3720 * j], decay: [0.55, 0.44, 0.34, 0.26, 0.2], peak: 0.16 });
      r.tone(o, { f0: 120, f1: 70, glide: 0.05, t, peak: 0.3, d: 0.08 });
      break;
    case 'ground':
    default: // dull thud, dirt thrown up
      r.tone(o, { f0: 110, f1: 42, glide: 0.1, t, peak: 0.3, d: 0.15 });
      r.burst(o, { kind: 'pink', t, peak: 1.0, d: 0.11, type: 'lowpass', f0: 420, q: 0.7 });
      r.burst(o, { kind: 'pink', t, peak: 1.0, a: 0.004, d: 0.12, type: 'bandpass', f0: 1100, f1: 550, sweep: 0.12, q: 0.8 });
      ticks(3, 900, 2200, 0.16, 0.3, 2);
      break;
  }
}

export function hookRetract(A: Audio, side?: Side): void {
  const r = A._rig('hook', 6); if (!r) return;
  const t = now(A);
  const o = A._dest(r, { pan: sideInfo(side), rev: 0.06, vol: 0.8 });
  // quick zip
  r.burst(o, { t, peak: 0.3, a: 0.01, d: 0.11, type: 'bandpass', f0: 800, f1: 5200, sweep: 0.1, q: 3 });
  r.tone(o, { f0: 1500, f1: 4200, glide: 0.1, t, peak: 0.05, a: 0.008, d: 0.1 });
  // latch click
  r.modes(o, { t: t + 0.1, f: [2900, 4300, 6100], decay: 0.02, peak: 0.22 });
  r.burst(o, { t: t + 0.1, peak: 0.2, a: 0.0006, d: 0.012, type: 'highpass', f0: 3500 });
}

export function hookMiss(A: Audio): void {
  const r = A._rig('hook', 6); if (!r) return;
  const t = now(A);
  const o = A._dest(r, { rev: 0.08, vol: 0.8 });
  // wire whip
  r.burst(o, { t, peak: 0.34, a: 0.012, d: 0.1, type: 'bandpass', f0: 5600, f1: 900, sweep: 0.09, q: 3 });
  r.burst(o, { t: t + 0.085, peak: 0.28, a: 0.0006, d: 0.02, type: 'highpass', f0: 3000 }); // crack
  // dry click of the empty launcher
  r.modes(o, { t: t + 0.28, f: [1650, 2500], decay: 0.014, peak: 0.16 });
  r.burst(o, { t: t + 0.28, peak: 0.13, a: 0.0005, d: 0.01, type: 'bandpass', f0: 3000, q: 2 });
}

// ───────────────────────────────────────────────────────────────────────── combat

export function slash(A: Audio, hit: boolean): void {
  const r = A._rig('slash', 6); if (!r) return;
  const t = now(A);
  const o = A._dest(r, { rev: hit ? 0.14 : 0.08, vol: hit ? 1 : 0.9, pan: rand(-0.12, 0.12) });
  r.burst(o, { t, peak: hit ? 0.42 : 0.5, a: 0.035, d: 0.16, type: 'bandpass', f0: 1200, f1: 5200, sweep: 0.09, q: 1.3 });
  r.burst(o, { t: t + 0.02, peak: 0.18, a: 0.03, d: 0.15, type: 'highpass', f0: 3500 });
  const rf = rand(2050, 2350);
  r.modes(o, { t: t + 0.012, f: [rf, rf * 1.504, rf * 2.12, rf * 2.97], decay: 0.4, peak: hit ? 0.12 : 0.14 });
  if (hit) {
    const h = t + 0.045;
    // (the low end is held back on purpose: the master compressor trades it against the cut itself)
    r.burst(o, { kind: 'pink', t: h, peak: 0.7, a: 0.004, d: 0.18, type: 'lowpass', f0: 1800, f1: 350, sweep: 0.12, q: 0.8 });
    r.tone(o, { f0: 170, f1: 55, glide: 0.07, t: h, peak: 0.42, d: 0.2 });
    r.burst(o, { kind: 'pink', t: h + 0.005, peak: 1.5, a: 0.004, d: 0.2, type: 'bandpass', f0: 900, f1: 500, sweep: 0.14, q: 1.2 });
    // the edge going through: a hard "shk" in the presence band, so a hit always reads over a miss
    r.burst(o, { t: h, peak: 2.1, a: 0.001, d: 0.16, type: 'bandpass', f0: 3000, f1: 1500, sweep: 0.09, q: 1.1 });
    r.burst(o, { t: h, peak: 0.5, a: 0.0006, d: 0.02, type: 'highpass', f0: 4500 });
  }
}

export function napeKill(A: Audio): void {
  const r = A._rig('kill', 3); if (!r) return;
  const t = now(A);
  // The kill plays on the top bus while the rest of the world ducks under it for a beat: the audio hit-stop.
  const o = A._dest(r, { rev: 0.32, vol: 1, to: A.sfxTop });
  A._duckSfx(0.42, 0.24, 0.4);
  // blade swish into a heavy slice
  r.burst(o, { t, peak: 0.45, a: 0.02, d: 0.1, type: 'bandpass', f0: 1500, f1: 6500, sweep: 0.07, q: 1.4 });
  r.modes(o, { t: t + 0.01, f: [2200, 3300, 4700, 6500], decay: 0.5, peak: 0.15 });
  const h = t + 0.06;
  r.tone(o, { f0: 190, f1: 48, glide: 0.09, t: h, peak: 0.7, d: 0.3 });
  r.burst(o, { kind: 'pink', t: h, peak: 0.9, a: 0.005, d: 0.16, type: 'lowpass', f0: 2200, f1: 280, sweep: 0.15, q: 0.8 });
  r.burst(o, { t: h, peak: 0.6, a: 0.001, d: 0.05, type: 'highpass', f0: 2500 });
  // bright crack of the cut and a mid "chunk", so the hit carries on small speakers as well as in the sub
  r.burst(o, { t: h, peak: 1.2, a: 0.0006, d: 0.05, type: 'bandpass', f0: 3800, q: 0.8 });
  r.burst(o, { kind: 'pink', t: h, peak: 1.5, a: 0.004, d: 0.14, type: 'bandpass', f0: 1300, f1: 520, sweep: 0.08, q: 1.1 });
  // crunchy bone / flesh layer
  r.burst(o, { t: h + 0.01, peak: 0.35, a: 0.003, d: 0.2, type: 'bandpass', f0: 700, f1: 260, sweep: 0.2, q: 2 });
  // blood spray: spattering droplets
  for (let i = 0; i < 9; i++) {
    r.burst(o, { t: h + 0.04 + i * rand(0.03, 0.06), peak: rand(0.1, 0.24), a: 0.003, d: rand(0.05, 0.12), type: 'bandpass', f0: rand(900, 2600), q: 1.6 });
  }
  // rising steam hiss
  r.burst(o, { t: h + 0.12, peak: 0.34, a: 0.75, d: 1.3, type: 'highpass', f0: 1800, f1: 3600, sweep: 1.5, q: 0.7, type2: 'lowpass', f2: 9000 });
  r.burst(o, { t: h + 0.15, peak: 0.16, a: 0.8, d: 1.3, type: 'bandpass', f0: 5200, q: 6 });
  // low stinger boom
  r.tone(o, { f0: 78, f1: 33, glide: 0.9, t: h + 0.03, peak: 0.55, a: 0.006, d: 1.5 });
  r.tone(o, { f0: 156, f1: 66, glide: 0.5, t: h + 0.03, peak: 0.16, a: 0.006, d: 0.6 });
}

export function bladeBreak(A: Audio): void {
  const r = A._rig('break', 3); if (!r) return;
  const t = now(A);
  const o = A._dest(r, { rev: 0.3, vol: 0.95 });
  // steel snap
  r.burst(o, { t, peak: 0.7, a: 0.0005, d: 0.02, type: 'highpass', f0: 2200 });
  r.modes(o, { t, f: [1750, 2980, 4900, 7400], decay: 0.16, peak: 0.34 });
  r.tone(o, { f0: 260, f1: 90, glide: 0.05, t, peak: 0.34, d: 0.08 });
  r.burst(o, { t: t + 0.004, peak: 0.28, a: 0.001, d: 0.05, type: 'bandpass', f0: 5200, q: 1.5 });
  // tinkling shards
  for (let i = 0; i < 12; i++) {
    const tt = t + 0.04 + Math.pow(R.fx(), 1.6) * 0.65;
    r.tone(o, { f0: rand(2300, 9500), t: tt, peak: rand(0.03, 0.09), a: 0.0004, d: rand(0.07, 0.24) });
  }
}

export function bladeSwap(A: Audio): void {
  const r = A._rig('swap', 3); if (!r) return;
  const t = now(A);
  const o = A._dest(r, { rev: 0.1, vol: 0.85 });
  // click
  r.modes(o, { t, f: [1900, 3100, 4700], decay: 0.02, peak: 0.28 });
  r.burst(o, { t, peak: 0.24, a: 0.0005, d: 0.012, type: 'highpass', f0: 3200 });
  // scrape of the blade sliding out of the sheath/holder
  r.burst(o, { t: t + 0.025, peak: 0.2, a: 0.02, d: 0.12, type: 'bandpass', f0: 3600, f1: 2000, sweep: 0.12, q: 4 });
  // clack of the new blade seating
  r.modes(o, { t: t + 0.12, f: [880, 1480, 2300, 3700], decay: 0.04, peak: 0.24 });
  r.burst(o, { t: t + 0.12, peak: 0.2, a: 0.0005, d: 0.025, type: 'bandpass', f0: 1800, q: 1.2 });
  r.tone(o, { f0: 190, f1: 110, glide: 0.04, t: t + 0.12, peak: 0.2, d: 0.07 });
}

export function refill(A: Audio): void {
  const r = A._rig('refill', 2); if (!r) return;
  const t = now(A);
  const o = A._dest(r, { rev: 0.16, vol: 0.9 });
  // docking clunk
  r.modes(o, { t, f: [210, 410, 880, 1750], decay: 0.12, peak: 0.45 });
  r.tone(o, { f0: 130, f1: 60, glide: 0.05, t, peak: 0.5, d: 0.12 });
  r.burst(o, { t, peak: 0.3, a: 0.001, d: 0.04, type: 'bandpass', f0: 1500, q: 1 });
  // gas filling: hiss whose pitch climbs as the tank pressurises
  r.burst(o, { t: t + 0.08, peak: 0.34, a: 0.18, d: 0.85, type: 'bandpass', f0: 2200, f1: 5200, sweep: 0.9, q: 1.1, type2: 'highpass', f2: 1200 });
  r.burst(o, { t: t + 0.08, peak: 0.12, a: 0.3, d: 0.7, type: 'bandpass', f0: 7000, q: 8 });
  // blade rack ticks
  for (let i = 0; i < 4; i++) r.modes(o, { t: t + 0.35 + i * 0.12, f: [2100, 3300], decay: 0.014, peak: 0.12 });
  // latch
  r.modes(o, { t: t + 1.0, f: [320, 640, 1900], decay: 0.1, peak: 0.28 });
  r.tone(o, { f0: 150, f1: 70, glide: 0.04, t: t + 1.0, peak: 0.28, d: 0.1 });
  r.modes(o, { t: t + 1.13, f: [2400, 3600], decay: 0.02, peak: 0.2 });
}

export function impact(A: Audio, strength?: number): void {
  const s = clamp(finite(strength, 0.5), 0, 1);
  if (s < 0.02) return;
  const r = A._rig('thump', 4); if (!r) return;
  const t = now(A);
  const o = A._dest(r, { rev: 0.08 + 0.12 * s, vol: 0.35 + 0.75 * s });
  r.tone(o, { f0: 120 - 30 * s, f1: 38, glide: 0.1, t, peak: 0.85, d: 0.1 + 0.2 * s });
  r.burst(o, { t, peak: 0.6, d: 0.06 + 0.1 * s, type: 'lowpass', f0: 500 + 600 * s, q: 0.7 });
  r.burst(o, { kind: 'pink', t, peak: 0.8, a: 0.002, d: 0.05 + 0.04 * s, type: 'bandpass', f0: 620, q: 1 }); // body of the knock (the thump alone vanishes on small speakers)
  if (s > 0.3) { // gear and clothing rattling
    r.burst(o, { t: t + 0.01, peak: 0.12 * s, a: 0.004, d: 0.12, type: 'highpass', f0: 2200 });
    r.modes(o, { t: t + 0.015, f: [1250, 2100, 3400], decay: 0.05, peak: 0.1 * s });
  }
  if (s > 0.6) r.tone(o, { f0: 60, f1: 30, glide: 0.3, t, peak: 0.4 * s, d: 0.4 });
}

export function land(A: Audio, strength?: number): void {
  const s = clamp(finite(strength, 0.5), 0, 1);
  if (s < 0.02) return;
  const r = A._rig('thump', 4); if (!r) return;
  const t = now(A);
  const o = A._dest(r, { rev: 0.06 + 0.1 * s, vol: 0.3 + 0.7 * s });
  r.tone(o, { f0: 95 - 25 * s, f1: 42, glide: 0.08, t, peak: 0.8, d: 0.08 + 0.18 * s });
  r.burst(o, { t, peak: 0.5, d: 0.05 + 0.08 * s, type: 'lowpass', f0: 420 + 400 * s, q: 0.7 });
  r.burst(o, { kind: 'pink', t, peak: 0.7, a: 0.002, d: 0.045, type: 'bandpass', f0: 520, q: 1 }); // boot soles
  r.burst(o, { t: t + 0.004, peak: 0.28 * (0.4 + s), a: 0.003, d: 0.1 + 0.1 * s, type: 'bandpass', f0: 1500, f1: 700, sweep: 0.15, q: 0.8 }); // dust and gravel
  r.modes(o, { t: t + 0.02, f: [1400, 2300], decay: 0.04, peak: 0.1 * s }); // buckles
}

export function grabbed(A: Audio): void {
  const r = A._rig('grab', 2); if (!r) return;
  const t = now(A);
  const o = A._dest(r, { rev: 0.2, vol: 0.95 });
  // heavy squeeze: creaking low saw + rubbing leather
  const g = r.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.24, t + 0.12);
  g.gain.setTargetAtTime(0, t + 0.45, 0.14);
  const lp = r.filter('lowpass', 420, 4);
  lp.frequency.setValueAtTime(260, t);
  lp.frequency.linearRampToValueAtTime(700, t + 0.5);
  const s1 = r.osc('sawtooth', 62, t, t + 1.3);
  s1.frequency.linearRampToValueAtTime(48, t + 0.6);
  const s2 = r.osc('sawtooth', 62.7, t, t + 1.3);
  s2.frequency.linearRampToValueAtTime(48.6, t + 0.6);
  s1.connect(lp); s2.connect(lp); lp.connect(g); g.connect(o);
  r.burst(o, { t, peak: 0.34, a: 0.1, d: 0.5, type: 'bandpass', f0: 500, f1: 1300, sweep: 0.5, q: 3 }); // grip rubbing
  r.modes(o, { t: t + 0.05, f: [3200, 3900], decay: 0.03, peak: 0.1 });
  for (let i = 0; i < 3; i++) r.burst(o, { t: t + 0.12 + i * rand(0.09, 0.15), peak: 0.16, a: 0.002, d: 0.04, type: 'bandpass', f0: rand(300, 700), q: 3 }); // joints creak
  r.tone(o, { f0: 90, f1: 40, glide: 0.1, t, peak: 0.55, d: 0.25 }); // thump of the grab
  // gasp: sharp inhale
  r.burst(o, { t: t + 0.2, peak: 0.42, a: 0.09, d: 0.3, type: 'bandpass', f0: 900, f1: 2000, sweep: 0.22, q: 2.2, type2: 'highpass', f2: 500 });
  r.burst(o, { t: t + 0.2, peak: 0.16, a: 0.1, d: 0.3, type: 'bandpass', f0: 2900, q: 3 });
}

export function eaten(A: Audio): void {
  const r = A._rig('eaten', 2); if (!r) return;
  const t = now(A);
  const o = A._dest(r, { rev: 0.28, vol: 1 });
  // wet crunches (bone and armour)
  let tt = t + 0.02;
  for (let i = 0; i < 7; i++) {
    const v = rand(0.7, 1);
    r.burst(o, { t: tt, peak: 0.6 * v, a: 0.0008, d: 0.045, type: 'highpass', f0: rand(900, 1600), q: 0.8 });
    r.burst(o, { t: tt, peak: 0.55 * v, a: 0.001, d: 0.09, type: 'bandpass', f0: rand(220, 420), q: 1.6 });
    r.tone(o, { f0: rand(110, 170), f1: 50, glide: 0.05, t: tt, peak: 0.5 * v, d: 0.12 });
    if (i % 2 === 0) r.modes(o, { t: tt, f: [pick([2100, 2600, 3300]), 4300], decay: 0.02, peak: 0.12 * v });
    tt += rand(0.06, 0.12);
  }
  // squelch
  r.burst(o, { t: t + 0.1, peak: 0.45, a: 0.05, d: 0.55, type: 'bandpass', f0: 1100, f1: 250, sweep: 0.5, q: 3 });
  // gulp and the heavy final thud
  r.tone(o, { f0: 230, f1: 70, glide: 0.18, t: tt + 0.05, peak: 0.45, a: 0.02, d: 0.25 });
  r.tone(o, { f0: 80, f1: 30, glide: 0.5, t: tt + 0.1, peak: 0.85, a: 0.004, d: 0.9 });
  r.burst(o, { t: tt + 0.1, peak: 0.4, d: 0.5, type: 'lowpass', f0: 300, q: 0.7 });
}

export function hurt(A: Audio): void {
  const r = A._rig('hurt', 3); if (!r) return;
  const t = now(A);
  const o = A._dest(r, { rev: 0.1, vol: 0.9 });
  r.tone(o, { f0: 130, f1: 44, glide: 0.09, t, peak: 0.85, d: 0.18 });
  r.burst(o, { t, peak: 0.55, d: 0.12, type: 'lowpass', f0: 900, q: 0.7 });
  r.burst(o, { t: t + 0.01, peak: 0.26, a: 0.003, d: 0.1, type: 'bandpass', f0: 2200, q: 0.9 });
  // short pained grunt (formant-filtered saw)
  const g = r.gain(0);
  g.gain.setValueAtTime(0, t + 0.02);
  g.gain.linearRampToValueAtTime(0.5, t + 0.05);
  g.gain.setTargetAtTime(0, t + 0.11, 0.04);
  const s = r.osc('sawtooth', 150, t + 0.02, t + 0.4);
  s.frequency.linearRampToValueAtTime(95, t + 0.3);
  const f1 = r.filter('bandpass', 620, 5);
  const f2 = r.filter('bandpass', 1150, 6);
  const sum = r.gain(1.3);
  s.connect(f1); s.connect(f2); f1.connect(sum); f2.connect(sum); sum.connect(g); g.connect(o);
}

// ───────────────────────────────────────────────────────────────────────── titans (3D)

function sizeOf(size: number | undefined, d = 10): number { return clamp(finite(size, d), 1.5, 120); }

export function titanStep(A: Audio, pos?: Pos, sizeIn?: number): void {
  const size = sizeOf(sizeIn);
  const r = A._rig('step', 7); if (!r) return;
  const pl = A._place(r, pos, size, { ref: clamp(size * 1.5, 4, 70), air: 6000 });
  if (!pl) { r.abort(); return; }
  const k = clamp(size / 15, 0.2, 3);
  const f0 = clamp(120 / Math.sqrt(size / 3), 27, 105) * rand(0.95, 1.05);
  const t = now(A);
  const o = A._dest(r, { to: pl.in, rev: 0.12 + 0.18 * clamp(k, 0, 1), revScale: pl.rev, vol: clamp(0.5 + size / 26, 0.5, 2.2) });
  // sub-bass thump (+ an audible 2nd harmonic for small speakers)
  r.tone(o, { f0: f0 * 1.9, f1: f0, glide: 0.06, t, peak: 0.9, a: 0.004, d: 0.22 + 0.025 * size });
  r.tone(o, { type: 'triangle', f0: f0 * 2.6, f1: f0 * 1.6, glide: 0.08, t, peak: 0.28, d: 0.12 + 0.01 * size });
  // ground rumble + gravel crunch
  r.burst(o, { kind: 'brown', t, peak: 1.2, a: 0.006, d: 0.35 + 0.03 * size, type: 'lowpass', f0: 170 + 40 * k, f1: 70, sweep: 0.4 + 0.02 * size, q: 0.7 });
  r.burst(o, { t, peak: 0.22, a: 0.004, d: 0.12 + 0.01 * size, type: 'bandpass', f0: 750, f1: 320, sweep: 0.2, q: 0.8 });
}

/** Formant growl: sawtooth source -> parallel formant filters, with a rough amplitude modulation. */
export interface GrowlOpts { t: number; dur: number; f0: number; peak?: number; vowel?: number; rough?: number; breath?: number; glideTo?: number }

export function growlVoice(A: Audio, r: Rig, out: AudioNode, { t, dur, f0, peak = 1, vowel = 0, rough = 0.4, breath = 0.25, glideTo = 0.78 }: GrowlOpts): GainNode {
  const end = t + dur * 1.35 + 0.3;
  const env = r.gain(0);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(peak, t + dur * 0.28);
  env.gain.setTargetAtTime(0, t + dur * 0.55, dur * 0.17);
  // growl amplitude modulation
  const am = r.gain(1 - rough * 0.5);
  const lfoA = r.osc('sine', rand(24, 34), t, end);
  const lfoAg = r.gain(rough * 0.5);
  lfoA.connect(lfoAg); lfoAg.connect(am.gain);
  // pitch contour: rises, then sags
  const contour = (o: OscillatorNode, mul: number): void => {
    o.frequency.setValueAtTime(f0 * 0.86 * mul, t);
    o.frequency.linearRampToValueAtTime(f0 * 1.14 * mul, t + dur * 0.35);
    o.frequency.linearRampToValueAtTime(f0 * glideTo * mul, t + dur);
  };
  const vib = r.osc('sine', rand(4.6, 6), t, end);
  const vibG = r.gain(f0 * 0.022);
  vib.connect(vibG);
  const src = r.gain(1);
  const voices: [OscillatorType, number, number][] = [['sawtooth', 1, 0.5], ['sawtooth', 1.0065, 0.42], ['square', 0.5, 0.28]];
  for (const [type, mul, lvl] of voices) {
    const o = r.osc(type, f0 * mul, t, end);
    contour(o, mul);
    vibG.connect(o.frequency);
    const lg = r.gain(lvl);
    o.connect(lg); lg.connect(src);
  }
  // breath noise
  const n = r.noise('pink', t, dur * 1.35 + 0.3);
  const ng = r.gain(breath);
  n.connect(ng); ng.connect(src);
  // formants ("uuoooaah"): F1 low -> open -> closing
  const VOWELS: [number, number, number][][] = [
    [[300, 700, 420], [800, 1150, 760], [2300, 2600, 2250]],
    [[260, 560, 340], [700, 960, 640], [2250, 2450, 2150]],
  ];
  const V = VOWELS[vowel] || VOWELS[0];
  const gains = [1.4, 0.9, 0.45];
  const qs = [4.5, 7, 9];
  const sum = r.gain(1);
  V.forEach(([a, b, c], i) => {
    const f = r.filter('bandpass', a, qs[i]);
    f.frequency.setValueAtTime(a, t);
    f.frequency.linearRampToValueAtTime(b, t + dur * 0.4);
    f.frequency.linearRampToValueAtTime(c, t + dur);
    const fg = r.gain(gains[i]);
    src.connect(f); f.connect(fg); fg.connect(sum);
  });
  const body = r.filter('lowpass', 260, 0.7);
  const bg = r.gain(0.45);
  src.connect(body); body.connect(bg); bg.connect(sum);
  sum.connect(am); am.connect(env); env.connect(out);
  return env;
}

export function titanGroan(A: Audio, pos?: Pos, sizeIn?: number): void {
  const size = sizeOf(sizeIn);
  const r = A._rig('groan', 4); if (!r) return;
  const pl = A._place(r, pos, size, { ref: clamp(size * 1.8, 5, 90), air: 5500 });
  if (!pl) { r.abort(); return; }
  const t = now(A);
  const dur = clamp(1.3 + size * 0.05, 1.4, 3.6) * rand(0.9, 1.15);
  const f0 = clamp(115 * Math.pow(3 / size, 0.45), 32, 125) * rand(0.9, 1.1);
  const o = A._dest(r, { to: pl.in, rev: 0.3, revScale: pl.rev, vol: clamp(0.75 + size / 40, 0.75, 1.6) });
  growlVoice(A, r, o, { t, dur, f0, peak: 1, vowel: R.fx() < 0.5 ? 0 : 1, rough: rand(0.3, 0.55) });
}

export function titanFall(A: Audio, pos?: Pos, sizeIn?: number): void {
  const size = sizeOf(sizeIn);
  const r = A._rig('fall', 3); if (!r) return;
  const pl = A._place(r, pos, size, { ref: clamp(size * 2.2, 6, 110), air: 5000, cut: 0.002 });
  if (!pl) { r.abort(); return; }
  const k = clamp(size / 15, 0.35, 3);
  const t = now(A);
  const o = A._dest(r, { to: pl.in, rev: 0.5, revScale: pl.rev, vol: clamp(0.7 + k * 0.35, 0.75, 1.4) });
  // sub boom and impact thump
  r.tone(o, { f0: 75, f1: 24, glide: 1.1, t, peak: 1.0, a: 0.01, d: 1.0 + 0.4 * k });
  r.tone(o, { f0: 140, f1: 45, glide: 0.2, t, peak: 0.7, a: 0.004, d: 0.45 });
  // crash: ground and flesh
  r.burst(o, { kind: 'brown', t, peak: 1.5, a: 0.01, d: 1.4 + 0.5 * k, type: 'lowpass', f0: 600, f1: 70, sweep: 1.6, q: 0.7 });
  r.burst(o, { t, peak: 0.7, a: 0.004, d: 0.7 + 0.2 * k, type: 'lowpass', f0: 4000, f1: 300, sweep: 0.9, q: 0.8 });
  // dust and rubble tail
  for (let i = 0; i < 6 + k * 5; i++) {
    r.burst(o, { t: t + 0.12 + Math.pow(R.fx(), 1.4) * (1.8 + k * 0.5), peak: rand(0.08, 0.25), a: 0.002, d: rand(0.05, 0.16), type: 'bandpass', f0: rand(200, 1400), q: 1.2 });
  }
  r.burst(o, { kind: 'pink', t: t + 0.1, peak: 0.28, a: 0.15, d: 1.8 + 0.4 * k, type: 'bandpass', f0: 1200, f1: 400, sweep: 2.2, q: 0.6 });
}

export function steamHiss(A: Audio, pos?: Pos, sizeIn?: number): void {
  const size = sizeOf(sizeIn);
  const r = A._rig('steam', 5); if (!r) return;
  const pl = A._place(r, pos, size, { ref: clamp(size * 1.6, 5, 80), air: 9000 });
  if (!pl) { r.abort(); return; }
  const t = now(A);
  const dur = clamp(0.9 + size * 0.045, 1, 3.4) * rand(0.9, 1.1);
  const o = A._dest(r, { to: pl.in, rev: 0.2, revScale: pl.rev, vol: clamp(0.9 + size / 50, 0.9, 1.6) });
  r.burst(o, { t, peak: 0.7, a: 0.07, d: dur, type: 'highpass', f0: 1500, q: 0.7, type2: 'lowpass', f2: 11000 });
  r.burst(o, { t, peak: 0.5, a: 0.09, d: dur * 0.9, type: 'bandpass', f0: 4300, f1: 3000, sweep: dur, q: 2.2 });
  r.burst(o, { t, peak: 0.14, a: 0.1, d: dur * 0.8, type: 'bandpass', f0: 7000, q: 11 });
  r.burst(o, { kind: 'pink', t, peak: 0.45, a: 0.02, d: 0.35, type: 'lowpass', f0: 420, q: 0.7 }); // the "whoomph" of release
}

/** The Behemoth appears at the wall. */
export function behemothAppear(A: Audio): void {
  const r = A._rig('behemoth', 1); if (!r) return;
  const t = now(A);
  const o = A._dest(r, { rev: 0.55, vol: 0.85 });
  const sat = A.satHard;
  // 1) thunder crack: violent broadband crack followed by crackling roll
  const crack = r.gain(0);
  perc(crack.gain, t, 1.0, 0.003, 0.35);
  const cn = r.noise('white', t, 0.6);
  const chp = r.filter('highpass', 900, 0.7);
  chp.frequency.setValueAtTime(5000, t);
  chp.frequency.exponentialRampToValueAtTime(700, t + 0.3);
  const cs = r.shaper(sat);
  cn.connect(chp); chp.connect(cs); cs.connect(crack); crack.connect(o);
  for (let i = 0; i < 9; i++) {
    r.burst(o, { t: t + 0.08 + i * rand(0.06, 0.12), peak: rand(0.15, 0.5), a: 0.003, d: rand(0.08, 0.25), type: 'bandpass', f0: rand(500, 3200), q: 0.7 });
  }
  // 2) explosive boom
  r.tone(o, { f0: 120, f1: 20, glide: 1.8, t: t + 0.02, peak: 1.2, a: 0.004, d: 2.8 });
  const bn = r.gain(0);
  perc(bn.gain, t + 0.02, 1.3, 0.004, 1.8);
  const bsrc = r.noise('brown', t + 0.02, 2.4);
  const bf = r.filter('lowpass', 1400, 0.7);
  bf.frequency.setValueAtTime(1400, t + 0.02);
  bf.frequency.exponentialRampToValueAtTime(90, t + 1.6);
  const bs = r.shaper(sat);
  bsrc.connect(bf); bf.connect(bs); bs.connect(bn); bn.connect(o);
  // 3) long rumble
  const rg = r.gain(0);
  rg.gain.setValueAtTime(0, t);
  rg.gain.linearRampToValueAtTime(0.9, t + 0.8);
  rg.gain.setTargetAtTime(0, t + 2.4, 1.3);
  const rn = r.noise('brown', t, 11);
  const rf = r.filter('lowpass', 150, 0.8);
  const trem = r.osc('sine', 7, t, t + 11);
  const tremG = r.gain(0.25);
  trem.connect(tremG); tremG.connect(rg.gain);
  rn.connect(rf); rf.connect(rg); rg.connect(o);
  // 4) deep roar of the Behemoth
  growlVoice(A, r, o, { t: t + 0.55, dur: 4.2, f0: 31, peak: 1.5, vowel: 1, rough: 0.6, breath: 0.35, glideTo: 0.9 });
  growlVoice(A, r, o, { t: t + 0.65, dur: 3.8, f0: 47, peak: 0.7, vowel: 0, rough: 0.5, breath: 0.2, glideTo: 0.85 });
  // the world ducks under it
  A._duckMusic(0.3, 0.25, 4.5);
}

// two-note fingers-in-mouth whistle for your horse: a rising "fweet", then a longer falling call
export function whistle(A: Audio): void {
  const r = A._rig('ui', 3); if (!r) return;
  const t = now(A);
  const o = A._dest(r, { rev: 0.25, vol: 0.55 });
  r.tone(o, { f0: 1900, f1: 2900, glide: 0.09, t, peak: 0.22, a: 0.02, d: 0.13 });
  r.tone(o, { f0: 2950, f1: 2200, glide: 0.42, t: t + 0.2, peak: 0.26, a: 0.03, d: 0.42 });
  r.burst(o, { t, peak: 0.05, a: 0.02, d: 0.6, type: 'bandpass', f0: 2600, q: 3 });
}
