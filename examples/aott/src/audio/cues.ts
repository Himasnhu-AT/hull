// Stingers, voices and menu sounds: the combo chime, the rescue cues, civilians calling, UI ticks.
// The pitched ones read the score's current chord (music.ts) so they always land in the harmony that is sounding.
import { clamp, rand, lerp, mtof } from './dsp';
import type { Rig } from './dsp';
import { now, finite } from './sfx';
import type { Audio, Vec3Like } from './audio';
import { R } from '../sim';

interface Harmony { pc: number; third: number }

/** The chord under the listener right now (D minor while the score is not running). */
function harmony(A: Audio): Harmony {
  return A.music ? A.music.chord() : { pc: 2, third: 3 };
}

/** `count` ascending chord tones (root, third, fifth), starting with the first one at or above MIDI note `from`. */
function ladder(h: Harmony, from: number, count: number): number[] {
  const out: number[] = [];
  for (let m = from; out.length < count; m++) {
    const d = (((m - h.pc) % 12) + 12) % 12;
    if (d === 0 || d === h.third || d === 7) out.push(m);
  }
  return out;
}

/** The chord's root as the first MIDI note at or above `from`. */
const rootFrom = (h: Harmony, from: number): number => from + ((((h.pc - from) % 12) + 12) % 12);

// ───────────────────────────────────────────────────────────────────────── combo

/**
 * Kill-chain stinger: a struck-steel chime running up the current chord. Each level starts one chord tone higher,
 * opens up brighter partials and (from 4 and 8) gains a note; the top levels add a shimmer.
 */
export function combo(A: Audio, nIn?: number): void {
  const n = clamp(Math.round(finite(nIn, 2)), 2, 9);
  const r = A._rig('combo', 2); if (!r) return;
  const t = now(A);
  const k = (n - 2) / 7;
  const o = A._dest(r, { to: A.sfxTop, rev: 0.22 + 0.1 * k, vol: 0.55 + 0.1 * k });
  const count = n < 4 ? 2 : n < 8 ? 3 : 4;
  const tones = ladder(harmony(A), 57, n - 2 + count);
  const gap = lerp(0.085, 0.06, k);
  for (let i = 0; i < count; i++) {
    const f = mtof(tones[n - 2 + i]);
    const tt = t + i * gap;
    const last = i === count - 1;
    const pk = (last ? 0.3 : 0.22) * (f > 1400 ? 0.8 : 1); // the ear is keener up there
    r.tone(o, { type: 'triangle', f0: f, t: tt, peak: pk, a: 0.002, d: last ? 0.45 : 0.16 });
    r.tone(o, { f0: f * 2, t: tt, peak: pk * (0.25 + 0.35 * k), a: 0.001, d: last ? 0.3 : 0.1 });
    r.tone(o, { f0: f * 3.01, t: tt, peak: pk * (0.08 + 0.25 * k), a: 0.001, d: last ? 0.2 : 0.07 });
    if (k > 0.4) r.tone(o, { f0: f * 4.03, t: tt, peak: pk * 0.14 * k, a: 0.001, d: 0.09 });
    r.burst(o, { t: tt, peak: 0.07 + 0.08 * k, a: 0.0005, d: 0.012, type: 'bandpass', f0: 3200 + 2500 * k, q: 1.5 }); // hammer
  }
  if (n >= 7) r.burst(o, { t: t + (count - 1) * gap, peak: 0.07, a: 0.01, d: 0.35, type: 'bandpass', f0: 7500, q: 3 });
}

// ───────────────────────────────────────────────────────────────────────── rescue

/** Short horn note: two detuned saws through a low-pass that swells open. */
function horn(r: Rig, out: AudioNode, t: number, len: number, midi: number, vel: number): void {
  const f = mtof(midi);
  const g = r.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.2 * vel, t + 0.05);
  g.gain.setValueAtTime(0.18 * vel, t + len);
  g.gain.setTargetAtTime(0, t + len, 0.09);
  const lp = r.filter('lowpass', f * 1.5, 1.2);
  lp.frequency.setValueAtTime(f * 1.5, t);
  lp.frequency.exponentialRampToValueAtTime(f * 5, t + 0.09);
  lp.frequency.exponentialRampToValueAtTime(f * 2.5, t + len + 0.2);
  for (const dt of [-7, 6]) r.osc('sawtooth', f, t, t + len + 0.55, dt).connect(lp);
  lp.connect(g); g.connect(out);
}

/** Small bell on fundamental `f`: hum, strike note, a tierce matching the chord's third, quint, octave and up. */
function bell(r: Rig, out: AudioNode, t: number, f: number, peak: number, third: number): void {
  const tierce = Math.pow(2, third / 12);
  r.modes(out, {
    t, f: [f * 0.5, f, f * tierce, f * 1.5, f * 2, f * 2.74, f * 4.07],
    decay: [1.6, 1.3, 0.9, 0.7, 0.6, 0.35, 0.2], amp: [0.35, 1, 0.3, 0.25, 0.5, 0.3, 0.15], peak,
  });
  r.burst(out, { t, peak: peak * 0.5, a: 0.0005, d: 0.015, type: 'bandpass', f0: Math.min(9000, f * 3), q: 1.5 }); // clapper
}

/** You grabbed a civilian: an armful of coat, the weight taken, and two warm notes rising a fourth to the root. */
export function rescuePickup(A: Audio): void {
  const r = A._rig('rescue', 2); if (!r) return;
  const t = now(A);
  const o = A._dest(r, { to: A.sfxTop, rev: 0.25, vol: 0.5 });
  r.burst(o, { kind: 'pink', t, peak: 0.5, a: 0.03, d: 0.16, type: 'bandpass', f0: 1300, f1: 2700, sweep: 0.16, q: 1 });
  r.tone(o, { f0: 130, f1: 62, glide: 0.06, t: t + 0.01, peak: 0.35, d: 0.08 });
  const root = rootFrom(harmony(A), 69);
  [root - 5, root].forEach((m, i) => {
    const f = mtof(m);
    const tt = t + 0.05 + i * 0.13;
    r.tone(o, { f0: f, t: tt, peak: 0.3, a: 0.012, d: i ? 0.5 : 0.2 });
    r.tone(o, { type: 'triangle', f0: f / 2, t: tt, peak: 0.18, a: 0.015, d: i ? 0.4 : 0.18 });
    r.tone(o, { f0: f * 2, t: tt, peak: 0.05, a: 0.008, d: 0.12 });
  });
}

/**
 * You set a civilian down safe: the reward. A horn pickup on the fifth resolving up to the root chord, a bell struck on
 * the arrival and answered an octave up.
 */
export function rescueDeliver(A: Audio): void {
  const r = A._rig('rescue', 2); if (!r) return;
  const t = now(A);
  const o = A._dest(r, { to: A.sfxTop, rev: 0.4, vol: 0.65 });
  const h = harmony(A);
  const root = rootFrom(h, 57);
  // set down: cloth, a soft footfall
  r.burst(o, { kind: 'pink', t, peak: 0.4, a: 0.03, d: 0.14, type: 'bandpass', f0: 1400, f1: 800, sweep: 0.15, q: 1 });
  r.tone(o, { f0: 110, f1: 55, glide: 0.06, t: t + 0.02, peak: 0.3, d: 0.08 });
  const a = t + 0.24;
  horn(r, o, t + 0.04, 0.17, root - 5, 0.6);
  horn(r, o, a, 0.7, root, 0.75);
  horn(r, o, a, 0.7, root + 7, 0.5);
  horn(r, o, a, 0.55, root + 12 + h.third, 0.3);
  horn(r, o, a, 0.7, root - 12, 0.5);
  bell(r, o, a, mtof(root + 12), 0.26, h.third);
  bell(r, o, a + 0.012, mtof(root + 19), 0.12, h.third);
  bell(r, o, a + 0.3, mtof(root + 24), 0.16, h.third);
}

/** A civilian was taken: low strings a semitone apart over a tritone, all sagging, and one muffled drum. */
export function civilianLost(A: Audio): void {
  const r = A._rig('lost', 1); if (!r) return;
  const t = now(A);
  const o = A._dest(r, { to: A.sfxTop, rev: 0.5, vol: 0.32 });
  const root = rootFrom(harmony(A), 50);
  const voices: [number, number][] = [[root + 12, 0.2], [root + 13, 0.16], [root + 6, 0.16], [root, 0.2]];
  const lp = r.filter('lowpass', 1100, 0.7);
  lp.frequency.setValueAtTime(1300, t);
  lp.frequency.exponentialRampToValueAtTime(420, t + 1.1);
  const g = r.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(1, t + 0.04);
  g.gain.setValueAtTime(1, t + 0.3);
  g.gain.setTargetAtTime(0, t + 0.3, 0.3);
  for (const [m, lvl] of voices) {
    const f = mtof(m);
    const vg = r.gain(lvl);
    for (const dt of [-8, 7]) {
      const os = r.osc('sawtooth', f, t, t + 2, dt);
      os.frequency.exponentialRampToValueAtTime(f * 0.925, t + 1.1); // sagging by more than a semitone
      os.connect(vg);
    }
    vg.connect(lp);
  }
  lp.connect(g); g.connect(o);
  r.tone(o, { f0: 95, f1: 48, glide: 0.1, t, peak: 0.5, d: 0.3 });
  r.burst(o, { kind: 'brown', t, peak: 0.6, a: 0.004, d: 0.25, type: 'lowpass', f0: 240, q: 0.7 });
  r.burst(o, { t, peak: 0.12, a: 0.002, d: 0.05, type: 'bandpass', f0: 800, q: 1 });
}

// ───────────────────────────────────────────────────────────────────────── civilians calling

type Vowel = [number, number, number];
const EH: Vowel = [600, 1750, 2550]; // "h-e-y", "h-e-lp"
const AY: Vowel = [420, 2050, 2700]; // the glide closing "hey"
const AH: Vowel = [800, 1250, 2600]; // "aah"
const EL: Vowel = [470, 1100, 2500]; // the dark "l" of "help"

interface ShoutOpts { t: number; dur: number; f0: number; u: number; from: Vowel; to: Vowel; k: number; peak?: number; rise?: number; fall?: number; stop?: boolean }

/**
 * One shouted syllable: a saw/pulse "glottis" with a pitch arc and vibrato, breath noise, three narrow vowel formants
 * gliding `from` -> `to`, and a presence band near 3 kHz (what makes a raised voice carry). `u` (urgency) adds strain:
 * a fast amplitude roughness and more breath. `k` scales the formants (a smaller head = higher), `stop` cuts the end
 * dead like a closing consonant.
 */
function shout(r: Rig, out: AudioNode, { t, dur, f0, u, from, to, k, peak = 1, rise = 1.16, fall = 0.8, stop = false }: ShoutOpts): void {
  const end = t + dur + 0.14;
  const env = r.gain(0);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(peak, t + 0.03);
  env.gain.setValueAtTime(peak, t + dur * (stop ? 0.9 : 0.6));
  env.gain.setTargetAtTime(0, t + dur * (stop ? 0.9 : 0.6), stop ? 0.008 : dur * 0.12 + 0.012);
  const am = r.gain(1 - 0.3 * u);
  const rough = r.osc('sine', rand(58, 82), t, end);
  const rg = r.gain(0.3 * u * rand(0.6, 1));
  rough.connect(rg); rg.connect(am.gain);
  const vib = r.osc('sine', rand(5.5, 7), t, end);
  const vg = r.gain(f0 * 0.012);
  vib.connect(vg);
  const src = r.gain(1);
  const glottis: [OscillatorType, number, number][] = [['sawtooth', 1, 0.6], ['square', 1.003, 0.18]];
  for (const [type, mul, lvl] of glottis) {
    const os = r.osc(type, f0 * 0.9 * mul, t, end);
    os.frequency.linearRampToValueAtTime(f0 * rise * mul, t + dur * 0.3);
    os.frequency.linearRampToValueAtTime(f0 * fall * mul, t + dur);
    vg.connect(os.frequency);
    const g = r.gain(lvl);
    os.connect(g); g.connect(src);
  }
  const n = r.noise('pink', t, dur + 0.14);
  const ng = r.gain(0.12 + 0.25 * u);
  n.connect(ng); ng.connect(src);
  const sum = r.gain(1.15);
  const gains = [1, 0.7, 0.4];
  const qs = [7, 10, 12];
  for (let i = 0; i < 3; i++) {
    const f = r.filter('bandpass', from[i] * k, qs[i]);
    f.frequency.setValueAtTime(from[i] * k, t);
    f.frequency.linearRampToValueAtTime(to[i] * k, t + dur);
    const fg = r.gain(gains[i]);
    src.connect(f); f.connect(fg); fg.connect(sum);
  }
  const pres = r.filter('bandpass', 3300 * k, 5);
  const pg = r.gain(0.2 + 0.25 * u);
  src.connect(pres); pres.connect(pg); pg.connect(sum);
  sum.connect(am); am.connect(env); env.connect(out);
}

/**
 * A stranded civilian calling for help, placed in the world: "hey!", "he-elp!" or (more often as urgency rises) a long
 * "aaah!", in a man's or a woman's register. Wordless, but shaped like speech: breathy onset, vowel glide, pitch arc.
 */
export function civilianCry(A: Audio, pos?: Vec3Like | null, urgencyIn?: number): void {
  const u = clamp(finite(urgencyIn, 0.5), 0, 1);
  const r = A._rig('cry', 3); if (!r) return;
  const pl = A._place(r, pos, 2, { ref: 18, air: 9000, cut: 0.03 });
  if (!pl) { r.abort(); return; }
  const t = now(A);
  const o = A._dest(r, { to: pl.in, rev: 0.3, revScale: pl.rev, vol: 0.85 + 0.3 * u });
  const woman = R.fx() < 0.5;
  const k = woman ? rand(1.14, 1.22) : rand(0.96, 1.06);
  const f0 = (woman ? rand(300, 370) : rand(175, 225)) * (1 + 0.4 * u);
  const pickKind = R.fx();
  r.burst(o, { t, peak: 0.12 + 0.1 * u, a: 0.02, d: 0.05, type: 'bandpass', f0: 1800 * k, q: 1.5 }); // the "h"
  const v = t + 0.035;
  if (pickKind < 0.2 + 0.4 * u) {
    shout(r, o, { t: v, dur: rand(0.45, 0.6) + 0.25 * u, f0: f0 * 1.08, u, from: AH, to: AH, k, rise: 1.2 + 0.1 * u, fall: 0.72 });
  } else if (pickKind < 0.65 + 0.2 * u) {
    const d1 = rand(0.11, 0.14);
    shout(r, o, { t: v, dur: d1, f0: f0 * 0.94, u, from: EH, to: EH, k, peak: 0.8, rise: 1.04, fall: 1 });
    shout(r, o, { t: v + d1 + 0.04, dur: rand(0.26, 0.34), f0: f0 * 1.18, u, from: EH, to: EL, k, rise: 1.1, fall: 0.74, stop: true });
  } else {
    shout(r, o, { t: v, dur: rand(0.26, 0.34), f0, u, from: EH, to: AY, k, rise: 1.18, fall: 0.8 });
  }
}

// ───────────────────────────────────────────────────────────────────────── menu

/** Hover: a wooden tick. */
export function uiHover(A: Audio): void {
  const r = A._rig('uiHover', 3); if (!r) return;
  const t = now(A);
  const j = rand(0.94, 1.06);
  const o = A._dest(r, { to: A.sfxTop, vol: 0.8 });
  r.modes(o, { t, f: [1250 * j, 2050 * j], decay: 0.014, peak: 0.2 });
  r.burst(o, { t, peak: 0.12, a: 0.0005, d: 0.008, type: 'bandpass', f0: 2600, q: 1.2 });
}

/** Click: a wooden peg knocked home, with a steel tick. */
export function uiClick(A: Audio): void {
  const r = A._rig('uiClick', 3); if (!r) return;
  const t = now(A);
  const o = A._dest(r, { to: A.sfxTop, vol: 0.75, rev: 0.04 });
  r.tone(o, { f0: 260, f1: 150, glide: 0.03, t, peak: 0.4, d: 0.04 });
  r.modes(o, { t, f: [640, 1180, 1950], decay: 0.035, peak: 0.34 });
  r.burst(o, { t, peak: 0.28, a: 0.0005, d: 0.012, type: 'bandpass', f0: 2400, q: 1 });
  r.modes(o, { t: t + 0.004, f: [3100, 4500], decay: 0.02, peak: 0.08 });
}

/** Back: the peg drawn out again, lower, two soft knocks falling. */
export function uiBack(A: Audio): void {
  const r = A._rig('uiClick', 3); if (!r) return;
  const t = now(A);
  const o = A._dest(r, { to: A.sfxTop, vol: 0.7, rev: 0.04 });
  r.modes(o, { t, f: [520, 940, 1500], decay: 0.03, peak: 0.28 });
  r.burst(o, { t, peak: 0.18, a: 0.0005, d: 0.012, type: 'bandpass', f0: 1700, q: 1 });
  r.tone(o, { f0: 190, f1: 105, glide: 0.05, t: t + 0.06, peak: 0.38, d: 0.05 });
  r.modes(o, { t: t + 0.06, f: [380, 700], decay: 0.035, peak: 0.24 });
}
