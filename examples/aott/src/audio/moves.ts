// Traversal one-shots: running and wall running, climbing, the wire and the reel brake, fly-bys and speed accents.
// Same conventions as sfx.ts: every function takes the Audio instance first and builds a self-disposing Rig.
import { clamp, rand, lerp } from './dsp';
import { now, finite } from './sfx';
import type { Audio } from './audio';
import { R } from '../sim';

let stepCount = 0;

/**
 * One running footfall. `surface` is a collider material; `wall` = a wall-run step (less heel, a scuff of the sole,
 * brighter). Pitch, colour, level and side all drift from step to step so a run never machine-guns.
 */
export function footstep(A: Audio, surface?: string, strength?: number, wall?: boolean): void {
  const s = clamp(finite(strength, 0.5), 0, 1);
  const r = A._rig('foot', 5); if (!r) return;
  const t = now(A);
  const side = stepCount++ & 1 ? 1 : -1;
  const j = rand(0.86, 1.16); // pitch
  const c = j * rand(0.85, 1.2) * (wall ? 1.3 : 1); // noise colour
  const heel = wall ? 0.45 : 1;
  const o = A._dest(r, { vol: (0.26 + 0.4 * s) * rand(0.75, 1.08) * (wall ? 0.85 : 1), pan: side * rand(0.08, 0.22), rev: 0.05 });
  // Thumps are kept small and the surface's own band does the talking: a footfall that is all sub is silent on a laptop.
  switch (surface) {
    case 'stone':
      r.tone(o, { f0: 150 * j, f1: 70, glide: 0.04, t, peak: 0.3 * heel, d: 0.05 });
      r.burst(o, { t, peak: 2.2, a: 0.001, d: 0.03, type: 'bandpass', f0: 1900 * c, q: 1.1 });
      r.burst(o, { kind: 'pink', t, peak: 1.4 * heel, a: 0.001, d: 0.035, type: 'bandpass', f0: 520 * c, q: 1 });
      r.burst(o, { t: t + rand(0.014, 0.03), peak: 0.3, a: 0.0005, d: 0.02, type: 'bandpass', f0: rand(3200, 5200), q: 2.5 }); // grit
      break;
    case 'wood':
      r.tone(o, { f0: 190 * j, f1: 95, glide: 0.04, t, peak: 0.3 * heel, d: 0.06 });
      r.modes(o, { t, f: [230 * j, 510 * j, 880 * j, 1420 * j], decay: 0.05, peak: 0.32 });
      r.burst(o, { kind: 'pink', t, peak: 0.9, a: 0.001, d: 0.03, type: 'lowpass', f0: 1300 * c, q: 0.7 });
      break;
    case 'bark':
      r.tone(o, { f0: 140 * j, f1: 70, glide: 0.04, t, peak: 0.3 * heel, d: 0.055 });
      r.burst(o, { kind: 'pink', t, peak: 1.6, a: 0.0015, d: 0.045, type: 'bandpass', f0: 620 * c, q: 0.8 });
      r.burst(o, { t: t + 0.002, peak: 1.1, a: 0.002, d: 0.03, type: 'bandpass', f0: 2300 * c, q: 1.4 }); // crunch
      break;
    case 'roof':
      r.modes(o, { t, f: [1050 * j, 1980 * j, 3150 * j], decay: 0.035, peak: 0.34 });
      r.burst(o, { t, peak: 0.7, a: 0.0008, d: 0.02, type: 'bandpass', f0: 2700 * c, q: 1.2 });
      r.tone(o, { f0: 170 * j, f1: 90, glide: 0.04, t, peak: 0.22 * heel, d: 0.04 });
      if (R.fx() < 0.3) r.modes(o, { t: t + rand(0.04, 0.07), f: [900 * j, 1750 * j], decay: 0.03, peak: 0.1 }); // a loose tile
      break;
    case 'metal':
      r.modes(o, { t, f: [620 * j, 1090 * j, 1730 * j, 2480 * j], decay: 0.11, peak: 0.24 });
      r.burst(o, { t, peak: 0.5, a: 0.0006, d: 0.012, type: 'highpass', f0: 3000 });
      r.tone(o, { f0: 130 * j, f1: 75, glide: 0.04, t, peak: 0.25 * heel, d: 0.05 });
      break;
    case 'flesh':
      r.tone(o, { f0: 120 * j, f1: 50, glide: 0.06, t, peak: 0.26 * heel, d: 0.08 });
      r.burst(o, { kind: 'pink', t, peak: 1.1, d: 0.07, type: 'lowpass', f0: 520 * c, q: 0.7 });
      r.burst(o, { kind: 'pink', t, peak: 1.2, a: 0.006, d: 0.08, type: 'bandpass', f0: 950 * c, f1: 420, sweep: 0.08, q: 2.2 });
      break;
    case 'ground':
    default:
      r.tone(o, { f0: 105 * j, f1: 48, glide: 0.05, t, peak: 0.26 * heel, d: 0.07 });
      r.burst(o, { kind: 'pink', t, peak: 1.1, d: 0.06, type: 'lowpass', f0: 420 * c, q: 0.7 });
      r.burst(o, { kind: 'pink', t, peak: 1.5, a: 0.003, d: 0.05, type: 'bandpass', f0: 1300 * c, q: 0.8 }); // dirt and grass
      break;
  }
  if (wall) {
    // the sole dragging across the face as the foot rolls off
    r.burst(o, { t: t + 0.004, peak: 0.8, a: 0.006, d: 0.06, type: 'bandpass', f0: 2700 * j, f1: 1300 * j, sweep: 0.06, q: 1.2 });
  }
  if (s > 0.35 && R.fx() < 0.3) r.modes(o, { t: t + 0.012, f: [2700 * j, 3900 * j], decay: 0.02, peak: 0.035 }); // a buckle
}

/**
 * A fast fly-by. Noise through a band that rises into the pass and falls away after it, sliding out to the side it
 * passed on; `strength` scales the level and how low the band (and a brown-noise body) reaches.
 */
export function whoosh(A: Audio, strength?: number, pan?: number): void {
  const s = clamp(finite(strength, 0.5), 0, 1);
  if (s < 0.03) return;
  const r = A._rig('whoosh', 4); if (!r) return;
  const t = now(A);
  const p = clamp(finite(pan, 0), -1, 1);
  const a = 0.045 + 0.04 * s; // approach
  const d = 0.13 + 0.2 * s; // departure
  const out = r.gain(0.5 + 0.9 * s);
  let n: AudioNode = out;
  if (r.ctx.createStereoPanner) {
    const sp = r.ctx.createStereoPanner();
    sp.pan.setValueAtTime(p * 0.3, t);
    sp.pan.linearRampToValueAtTime(p, t + a + d * 0.4);
    r.nodes.push(sp);
    out.connect(sp);
    n = sp;
  }
  n.connect(A.sfx);
  const send = r.gain(0.08);
  n.connect(send); send.connect(A.revIn);

  const top = lerp(2700, 1500, s) * rand(0.9, 1.1);
  const g = r.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(1, t + a);
  g.gain.setTargetAtTime(0, t + a, d / 4);
  const src = r.noise('pink', t, a + d * 1.5);
  const bp = r.filter('bandpass', top * 0.7, 1.5 + s);
  bp.frequency.setValueAtTime(top * 0.72, t);
  bp.frequency.exponentialRampToValueAtTime(top, t + a);
  bp.frequency.exponentialRampToValueAtTime(lerp(900, 260, s), t + a + d);
  src.connect(bp); bp.connect(g); g.connect(out);
  r.burst(out, { t, peak: 0.1 + 0.08 * s, a, d: d * 0.5, type: 'highpass', f0: 4200, q: 0.7 }); // the air edge
  if (s > 0.45) { // something big displaces air you can feel
    r.burst(out, { kind: 'brown', t: t + a * 0.5, peak: 1.1 * (s - 0.3), a, d, type: 'lowpass', f0: 460, f1: 120, sweep: d, q: 0.8 });
  }
}

/** The brake-reel: ratchet ticks into a clunk that leaves the drum ringing (on), or the pawl lifting with a hiss (off). */
export function reelLock(A: Audio, on: boolean): void {
  const r = A._rig('lock', 3); if (!r) return;
  const t = now(A);
  const o = A._dest(r, { rev: on ? 0.12 : 0.06, vol: 0.85 });
  if (on) {
    for (let i = 0; i < 2; i++) { // the last two teeth
      const tt = t + i * 0.024;
      r.modes(o, { t: tt, f: [rand(2100, 2400), 3400, 4700], decay: 0.014, peak: 0.16 });
      r.burst(o, { t: tt, peak: 0.1, a: 0.0005, d: 0.008, type: 'bandpass', f0: 3800, q: 2 });
    }
    const c = t + 0.055; // the brake drops home
    r.tone(o, { f0: 210, f1: 78, glide: 0.05, t: c, peak: 0.6, d: 0.09 });
    r.modes(o, { t: c, f: [470, 860, 1390, 2250], decay: 0.06, peak: 0.4 });
    r.burst(o, { t: c, peak: 0.4, a: 0.0006, d: 0.022, type: 'bandpass', f0: 2400, q: 1 });
    const rf = rand(1280, 1420); // drum and loaded wire ring on
    r.modes(o, { t: c + 0.004, f: [rf, rf * 1.62, rf * 2.51, rf * 3.62], decay: [0.5, 0.36, 0.26, 0.16], amp: [1, 0.6, 0.4, 0.25], peak: 0.1 });
  } else {
    r.modes(o, { t, f: [2500, 3700, 5200], decay: 0.016, peak: 0.22 }); // the pawl lifts
    r.burst(o, { t, peak: 0.18, a: 0.0005, d: 0.01, type: 'highpass', f0: 3500 });
    r.tone(o, { f0: 150, f1: 85, glide: 0.04, t: t + 0.012, peak: 0.32, d: 0.06 });
    r.burst(o, { t: t + 0.012, peak: 0.2, a: 0.001, d: 0.03, type: 'bandpass', f0: 900, q: 1 });
    // pressure bleeding off the brake
    r.burst(o, { t: t + 0.015, peak: 0.34, a: 0.012, d: 0.16, type: 'bandpass', f0: 5200, f1: 2600, sweep: 0.16, q: 1.2, type2: 'highpass', f2: 1800 });
    r.modes(o, { t: t + 0.075, f: [1900, 2900], decay: 0.014, peak: 0.11 }); // the drum comes free
  }
}

/**
 * Steel wire under load. Stick-slip: a slow pulse train whose rate bends as a strand gives, ringing the wire's narrow
 * resonances ("crreeak"), under a thin high partial of the wire singing.
 */
export function wireCreak(A: Audio, strength?: number): void {
  const s = clamp(finite(strength, 0.5), 0, 1);
  const r = A._rig('creak', 2); if (!r) return;
  const t = now(A);
  const o = A._dest(r, { rev: 0.14, vol: 0.4 + 0.5 * s, pan: rand(-0.3, 0.3) });
  const count = R.fx() < 0.4 ? 2 : 1;
  let tt = t;
  for (let i = 0; i < count; i++) {
    const dur = rand(0.22, 0.48) * (0.8 + 0.5 * s);
    const f0 = rand(34, 52);
    const f1 = f0 * (R.fx() < 0.5 ? rand(1.35, 1.9) : rand(0.55, 0.75));
    const end = tt + dur + 0.2;
    const os = r.osc('sawtooth', f0, tt, end);
    os.frequency.exponentialRampToValueAtTime(f1, tt + dur);
    const jit = r.osc('sine', rand(9, 14), tt, end);
    const jg = r.gain(f0 * 0.12);
    jit.connect(jg); jg.connect(os.frequency);
    const env = r.gain(0);
    env.gain.setValueAtTime(0, tt);
    env.gain.linearRampToValueAtTime(1, tt + dur * 0.3);
    env.gain.setTargetAtTime(0, tt + dur * 0.75, dur * 0.1);
    const rf = rand(620, 980);
    const sum = r.gain(1.8);
    const res: [number, number, number][] = [[1, 14, 1], [2.37, 18, 0.7], [4.1, 20, 0.4]];
    for (const [m, q, lvl] of res) {
      const bp = r.filter('bandpass', rf * m, q);
      bp.frequency.setValueAtTime(rf * m, tt);
      bp.frequency.linearRampToValueAtTime(rf * m * rand(1.03, 1.1), tt + dur); // the tension creeping up
      const bg = r.gain(lvl);
      os.connect(bp); bp.connect(bg); bg.connect(sum);
    }
    sum.connect(env); env.connect(o);
    tt += dur + rand(0.05, 0.16);
  }
  const sf = rand(1750, 2500);
  r.tone(o, { f0: sf, f1: sf * rand(1.01, 1.03), glide: 0.5, t: t + 0.03, peak: 0.03 + 0.04 * s, a: 0.08, d: 0.7 });
  r.tone(o, { f0: sf * 1.498, f1: sf * 1.52, glide: 0.5, t: t + 0.05, peak: 0.016 + 0.02 * s, a: 0.1, d: 0.5 });
}

/** A wire snapping taut: crack and zing, a twang (stretched partials, sharp while the tension spikes), a low thud. */
export function wireSnap(A: Audio, strength?: number): void {
  const s = clamp(finite(strength, 0.5), 0, 1);
  if (s < 0.03) return;
  const r = A._rig('snap', 3); if (!r) return;
  const t = now(A);
  const o = A._dest(r, { rev: 0.1 + 0.08 * s, vol: 0.35 + 0.5 * s, pan: rand(-0.15, 0.15) });
  r.burst(o, { t, peak: 0.45, a: 0.0005, d: 0.014, type: 'highpass', f0: 2800 });
  r.burst(o, { t, peak: 0.4, a: 0.001, d: 0.07, type: 'bandpass', f0: 5200, f1: 2600, sweep: 0.06, q: 5 });
  const f = rand(175, 215) * (1 + 0.35 * s);
  [1, 2.01, 3.03, 4.06, 5.1, 6.16].forEach((m, i) => {
    r.tone(o, { type: i < 2 ? 'triangle' : 'sine', f0: f * m * 1.09, f1: f * m, glide: 0.07, t, peak: 0.5 / (1 + i * 0.5), a: 0.001, d: 0.32 / (1 + i * 0.4) });
  });
  const w = 0.4 + 0.6 * s; // the harness taking the load
  r.tone(o, { f0: 125, f1: 46, glide: 0.08, t: t + 0.006, peak: 0.55 * w, d: 0.12 + 0.08 * s });
  r.burst(o, { kind: 'pink', t: t + 0.006, peak: 0.6 * w, d: 0.07, type: 'lowpass', f0: 520, q: 0.7 });
}

/** A hand or boot catching: a palm thud coloured by the surface (slap and grit on stone, crackle on bark), a sleeve. */
export function climbGrab(A: Audio, surface?: string, strength?: number): void {
  const s = clamp(finite(strength, 0.5), 0, 1);
  const r = A._rig('climb', 4); if (!r) return;
  const t = now(A);
  const j = rand(0.85, 1.18);
  const o = A._dest(r, { vol: (0.3 + 0.4 * s) * rand(0.8, 1.1), pan: rand(-0.3, 0.3), rev: 0.05 });
  const hard = surface === 'stone' || surface === 'roof' || surface === 'metal';
  r.tone(o, { f0: (hard ? 165 : 135) * j, f1: 68, glide: 0.04, t, peak: 0.3, d: 0.05 });
  if (hard) {
    r.burst(o, { t, peak: 1.1, a: 0.001, d: 0.028, type: 'bandpass', f0: 1700 * j, q: 1 });
    for (let i = 0; i < 2; i++) r.burst(o, { t: t + rand(0.015, 0.07), peak: rand(0.08, 0.16), a: 0.0005, d: 0.016, type: 'bandpass', f0: rand(3000, 5200), q: 3 });
  } else {
    r.burst(o, { kind: 'pink', t, peak: 1.1, a: 0.002, d: 0.045, type: 'lowpass', f0: 950 * j, q: 0.7 });
    for (let i = 0; i < 3; i++) r.burst(o, { t: t + rand(0.004, 0.07), peak: rand(0.1, 0.22), a: 0.0005, d: rand(0.012, 0.025), type: 'bandpass', f0: rand(1800, 3200), q: 2 });
  }
  r.burst(o, { t: t + 0.01, peak: 0.16, a: 0.02, d: 0.07, type: 'bandpass', f0: 2600 * j, f1: 3600 * j, sweep: 0.07, q: 1.5 });
  if (R.fx() < 0.3) r.modes(o, { t: t + 0.02, f: [2900 * j, 4100 * j], decay: 0.02, peak: 0.04 });
}

/** Hauling up over a ledge: cloth and a strap creak, hands slapping down, a boot scuffing up the face, the plant on top. */
export function mantle(A: Audio): void {
  const r = A._rig('mantle', 2); if (!r) return;
  const t = now(A);
  const o = A._dest(r, { rev: 0.07, vol: 0.45 });
  r.burst(o, { kind: 'pink', t, peak: 0.7, a: 0.09, d: 0.22, type: 'bandpass', f0: 1100, f1: 2600, sweep: 0.26, q: 1.1 });
  r.burst(o, { t: t + 0.04, peak: 0.12, a: 0.07, d: 0.18, type: 'highpass', f0: 4200 });
  // hands
  r.tone(o, { f0: 150, f1: 80, glide: 0.04, t: t + 0.02, peak: 0.34, d: 0.05 });
  r.burst(o, { t: t + 0.02, peak: 0.36, a: 0.001, d: 0.03, type: 'lowpass', f0: 1200, q: 0.7 });
  // leather strap taking the weight
  const cs = r.osc('sawtooth', 66, t + 0.07, t + 0.3);
  cs.frequency.linearRampToValueAtTime(96, t + 0.2);
  const cb = r.filter('bandpass', 540, 9);
  const cg = r.gain(0);
  cg.gain.setValueAtTime(0, t + 0.07);
  cg.gain.linearRampToValueAtTime(1.6, t + 0.11);
  cg.gain.setTargetAtTime(0, t + 0.16, 0.025);
  cs.connect(cb); cb.connect(cg); cg.connect(o);
  // boot up the face
  r.burst(o, { t: t + 0.2, peak: 0.5, a: 0.012, d: 0.09, type: 'bandpass', f0: 2100, f1: 950, sweep: 0.09, q: 1.3 });
  // and planted on top
  const L = t + 0.38;
  r.tone(o, { f0: 105, f1: 50, glide: 0.07, t: L, peak: 0.6, d: 0.1 });
  r.burst(o, { t: L, peak: 0.45, d: 0.06, type: 'lowpass', f0: 520, q: 0.7 });
  r.burst(o, { t: L + 0.004, peak: 0.22, a: 0.003, d: 0.07, type: 'bandpass', f0: 1500, q: 0.8 });
  r.modes(o, { t: L + 0.02, f: [1500, 2400, 3300], decay: 0.03, peak: 0.06 });
}

/** Kicking off a wall or trunk: the crack of the sole and a hard thump, then a puff of gas. */
export function kickOff(A: Audio, strength?: number): void {
  const s = clamp(finite(strength, 0.6), 0, 1);
  if (s < 0.03) return;
  const r = A._rig('kick', 3); if (!r) return;
  const t = now(A);
  const o = A._dest(r, { rev: 0.08 + 0.08 * s, vol: 0.35 + 0.5 * s });
  r.burst(o, { t, peak: 0.8, a: 0.0006, d: 0.016, type: 'bandpass', f0: 2600, q: 0.9 });
  r.tone(o, { f0: 185, f1: 56, glide: 0.06, t, peak: 0.65, d: 0.11 + 0.05 * s });
  r.burst(o, { t, peak: 0.5, d: 0.05, type: 'lowpass', f0: 1100, q: 0.7 });
  r.burst(o, { kind: 'pink', t: t + 0.003, peak: 1.2, a: 0.002, d: 0.05, type: 'bandpass', f0: 700, q: 1.2 });
  r.burst(o, { t: t + 0.012, peak: 0.4 + 0.2 * s, a: 0.008, d: 0.15 + 0.08 * s, type: 'bandpass', f0: 3600, f1: 1500, sweep: 0.16, q: 1, type2: 'highpass', f2: 900 });
  r.burst(o, { t: t + 0.012, peak: 0.1, a: 0.01, d: 0.12, type: 'bandpass', f0: 6500, q: 7 });
}

/**
 * Crossing into very high speed: a band-limited crack (it never spits), a short push in the low end, and the air
 * tearing open to both sides: two fluttering noise bands that sweep up through the mids and drain away.
 */
export function speedBurst(A: Audio): void {
  const r = A._rig('burst', 1); if (!r) return;
  const t = now(A);
  const o = A._dest(r, { rev: 0.22, vol: 0.65 });
  r.burst(o, { t, peak: 0.5, a: 0.001, d: 0.035, type: 'bandpass', f0: 2100, q: 0.8, type2: 'lowpass', f2: 5200 });
  r.tone(o, { f0: 115, f1: 46, glide: 0.12, t, peak: 0.5, a: 0.003, d: 0.2 });
  r.burst(o, { t, peak: 0.36, a: 0.002, d: 0.06, type: 'bandpass', f0: 600, q: 1 });
  for (const side of [-1, 1]) {
    const w = A._dest(r, { pan: side * 0.75, vol: 0.9, rev: 0.2 });
    const k = rand(0.9, 1.12);
    const g = r.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, t + 0.09);
    g.gain.setTargetAtTime(0, t + 0.12, 0.11);
    const src = r.noise('pink', t, 0.8);
    const bp = r.filter('bandpass', 520 * k, 1.3);
    bp.frequency.setValueAtTime(520 * k, t);
    bp.frequency.exponentialRampToValueAtTime(2700 * k, t + 0.1);
    bp.frequency.exponentialRampToValueAtTime(700 * k, t + 0.55);
    const am = r.gain(0.7);
    const lfo = r.osc('sawtooth', rand(34, 46), t, t + 0.8);
    const lg = r.gain(0.3);
    lfo.connect(lg); lg.connect(am.gain);
    src.connect(bp); bp.connect(am); am.connect(g); g.connect(w);
  }
  r.burst(o, { t: t + 0.02, peak: 0.12, a: 0.06, d: 0.3, type: 'highpass', f0: 5000, type2: 'lowpass', f2: 9000 });
}
