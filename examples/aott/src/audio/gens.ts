// The game's sounds that a recipe cannot say: ones that follow a number the game passes (a titan's size, the urgency of
// a cry, the chord the score is on) or that need nodes a recipe has no word for (formant voices, an amplitude-modulated
// creak). Each is registered as a generator and named by a `sound` recipe in config/sound/, which carries its bus,
// level and voice limit; the bench lists them with the rest. Randomness comes from the play's seeded stream (rig.ts).
import { registerGenerator } from 'hull/audio';
import type { GeneratorCall } from 'hull/audio';
import { clamp, fx, lerp, mtof, pick, perc, rand, Rig, satCurve, useStream } from './rig';
import type { Host } from './rig';

type Vec3Like = { x: number; y: number; z: number };
type Pos = Vec3Like | null | undefined;
interface Harmony { pc: number; third: number }
const finite = (v: number | undefined, d: number): number => (v !== undefined && Number.isFinite(v) ? v : d);
/** A sound at a world position: the engine already placed the whole sound (distance, pan, air), so this only hands the input back. */
const placed = (A: Host, _pos?: Pos, _size?: number, _o?: object): { in: AudioNode; g: number; d: number; rev: number } => ({ in: A.out, g: 1, d: 0, rev: 1 });
const harmony = (A: Host): Harmony => A.chord;

/** The chord's root as the first MIDI note at or above `from`. */
const rootFrom = (h: Harmony, from: number): number => from + ((((h.pc - from) % 12) + 12) % 12);

type Vowel = [number, number, number];
const EH: Vowel = [600, 1750, 2550]; // "h-e-y", "h-e-lp"
const AY: Vowel = [420, 2050, 2700]; // the glide closing "hey"
const AH: Vowel = [800, 1250, 2600]; // "aah"
const EL: Vowel = [470, 1100, 2500]; // the dark "l" of "help"

interface ShoutOpts { t: number; dur: number; f0: number; u: number; from: Vowel; to: Vowel; k: number; peak?: number; rise?: number; fall?: number; stop?: boolean }


/** Formant growl: sawtooth source -> parallel formant filters, with a rough amplitude modulation. */
interface GrowlOpts { t: number; dur: number; f0: number; peak?: number; vowel?: number; rough?: number; breath?: number; glideTo?: number }

function growlVoice(A: Host, r: Rig, out: AudioNode, { t, dur, f0, peak = 1, vowel = 0, rough = 0.4, breath = 0.25, glideTo = 0.78 }: GrowlOpts): GainNode {
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

function sizeOf(size: number | undefined, d = 10): number { return clamp(finite(size, d), 1.5, 120); }

function titanStep(A: Host, pos?: Pos, sizeIn?: number): void {
  const size = sizeOf(sizeIn);
  const r = new Rig(A);
  const pl = placed(A, pos, size, { ref: clamp(size * 1.5, 4, 70), air: 6000 });
  if (!pl) { r.abort(); return; }
  const k = clamp(size / 15, 0.2, 3);
  const f0 = clamp(120 / Math.sqrt(size / 3), 27, 105) * rand(0.95, 1.05);
  const t = A.t0;
  const o = r.dest({ rev: 0.12 + 0.18 * clamp(k, 0, 1), vol: clamp(0.5 + size / 26, 0.5, 2.2) });
  // sub-bass thump (+ an audible 2nd harmonic for small speakers)
  r.tone(o, { f0: f0 * 1.9, f1: f0, glide: 0.06, t, peak: 0.9, a: 0.004, d: 0.22 + 0.025 * size });
  r.tone(o, { type: 'triangle', f0: f0 * 2.6, f1: f0 * 1.6, glide: 0.08, t, peak: 0.28, d: 0.12 + 0.01 * size });
  // ground rumble + gravel crunch
  r.burst(o, { kind: 'brown', t, peak: 1.2, a: 0.006, d: 0.35 + 0.03 * size, type: 'lowpass', f0: 170 + 40 * k, f1: 70, sweep: 0.4 + 0.02 * size, q: 0.7 });
  r.burst(o, { t, peak: 0.22, a: 0.004, d: 0.12 + 0.01 * size, type: 'bandpass', f0: 750, f1: 320, sweep: 0.2, q: 0.8 });
}

function titanGroan(A: Host, pos?: Pos, sizeIn?: number): void {
  const size = sizeOf(sizeIn);
  const r = new Rig(A);
  const pl = placed(A, pos, size, { ref: clamp(size * 1.8, 5, 90), air: 5500 });
  if (!pl) { r.abort(); return; }
  const t = A.t0;
  const dur = clamp(1.3 + size * 0.05, 1.4, 3.6) * rand(0.9, 1.15);
  const f0 = clamp(115 * Math.pow(3 / size, 0.45), 32, 125) * rand(0.9, 1.1);
  const o = r.dest({ rev: 0.3, vol: clamp(0.75 + size / 40, 0.75, 1.6) });
  growlVoice(A, r, o, { t, dur, f0, peak: 1, vowel: fx() < 0.5 ? 0 : 1, rough: rand(0.3, 0.55) });
}

function grabbed(A: Host): void {
  const r = new Rig(A);
  const t = A.t0;
  const o = r.dest({ rev: 0.2, vol: 0.95 });
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

function hurt(A: Host): void {
  const r = new Rig(A);
  const t = A.t0;
  const o = r.dest({ rev: 0.1, vol: 0.9 });
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

/** The Behemoth appears at the wall. */
function behemothAppear(A: Host): void {
  const r = new Rig(A);
  const t = A.t0;
  const o = r.dest({ rev: 0.55, vol: 0.85 });
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
}

/**
 * A fast fly-by. Noise through a band that rises into the pass and falls away after it, sliding out to the side it
 * passed on; `strength` scales the level and how low the band (and a brown-noise body) reaches.
 */
function whoosh(A: Host, strength?: number, pan?: number): void {
  const s = clamp(finite(strength, 0.5), 0, 1);
  if (s < 0.03) return;
  const r = new Rig(A);
  const t = A.t0;
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
  n.connect(A.out);
  if (A.revIn) { const send = r.gain(0.08); n.connect(send); send.connect(A.revIn); }

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

/**
 * Steel wire under load. Stick-slip: a slow pulse train whose rate bends as a strand gives, ringing the wire's narrow
 * resonances ("crreeak"), under a thin high partial of the wire singing.
 */
function wireCreak(A: Host, strength?: number): void {
  const s = clamp(finite(strength, 0.5), 0, 1);
  const r = new Rig(A);
  const t = A.t0;
  const o = r.dest({ rev: 0.14, vol: 0.4 + 0.5 * s, pan: rand(-0.3, 0.3) });
  const count = fx() < 0.4 ? 2 : 1;
  let tt = t;
  for (let i = 0; i < count; i++) {
    const dur = rand(0.22, 0.48) * (0.8 + 0.5 * s);
    const f0 = rand(34, 52);
    const f1 = f0 * (fx() < 0.5 ? rand(1.35, 1.9) : rand(0.55, 0.75));
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

/** Hauling up over a ledge: cloth and a strap creak, hands slapping down, a boot scuffing up the face, the plant on top. */
function mantle(A: Host): void {
  const r = new Rig(A);
  const t = A.t0;
  const o = r.dest({ rev: 0.07, vol: 0.45 });
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

/**
 * Crossing into very high speed: a band-limited crack (it never spits), a short push in the low end, and the air
 * tearing open to both sides: two fluttering noise bands that sweep up through the mids and drain away.
 */
function speedBurst(A: Host): void {
  const r = new Rig(A);
  const t = A.t0;
  const o = r.dest({ rev: 0.22, vol: 0.65 });
  r.burst(o, { t, peak: 0.5, a: 0.001, d: 0.035, type: 'bandpass', f0: 2100, q: 0.8, type2: 'lowpass', f2: 5200 });
  r.tone(o, { f0: 115, f1: 46, glide: 0.12, t, peak: 0.5, a: 0.003, d: 0.2 });
  r.burst(o, { t, peak: 0.36, a: 0.002, d: 0.06, type: 'bandpass', f0: 600, q: 1 });
  for (const side of [-1, 1]) {
    const w = r.dest({ pan: side * 0.75, vol: 0.9, rev: 0.2 });
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

/** `count` ascending chord tones (root, third, fifth), starting with the first one at or above MIDI note `from`. */
function ladder(h: Harmony, from: number, count: number): number[] {
  const out: number[] = [];
  for (let m = from; out.length < count; m++) {
    const d = (((m - h.pc) % 12) + 12) % 12;
    if (d === 0 || d === h.third || d === 7) out.push(m);
  }
  return out;
}

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

/**
 * Kill-chain stinger: a struck-steel chime running up the current chord. Each level starts one chord tone higher,
 * opens up brighter partials and (from 4 and 8) gains a note; the top levels add a shimmer.
 */
function combo(A: Host, nIn?: number): void {
  const n = clamp(Math.round(finite(nIn, 2)), 2, 9);
  const r = new Rig(A);
  const t = A.t0;
  const k = (n - 2) / 7;
  const o = r.dest({ rev: 0.22 + 0.1 * k, vol: 0.55 + 0.1 * k });
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

/** You grabbed a civilian: an armful of coat, the weight taken, and two warm notes rising a fourth to the root. */
function rescuePickup(A: Host): void {
  const r = new Rig(A);
  const t = A.t0;
  const o = r.dest({ rev: 0.25, vol: 0.5 });
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
function rescueDeliver(A: Host): void {
  const r = new Rig(A);
  const t = A.t0;
  const o = r.dest({ rev: 0.4, vol: 0.65 });
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
function civilianLost(A: Host): void {
  const r = new Rig(A);
  const t = A.t0;
  const o = r.dest({ rev: 0.5, vol: 0.32 });
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
function civilianCry(A: Host, pos?: Vec3Like | null, urgencyIn?: number): void {
  const u = clamp(finite(urgencyIn, 0.5), 0, 1);
  const r = new Rig(A);
  const pl = placed(A, pos, 2, { ref: 18, air: 9000, cut: 0.03 });
  if (!pl) { r.abort(); return; }
  const t = A.t0;
  const o = r.dest({ rev: 0.3, vol: 0.85 + 0.3 * u });
  const woman = fx() < 0.5;
  const k = woman ? rand(1.14, 1.22) : rand(0.96, 1.06);
  const f0 = (woman ? rand(300, 370) : rand(175, 225)) * (1 + 0.4 * u);
  const pickKind = fx();
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

/** The valve opening: a thump and a chuff under the first instant of a gas burst (the loop alone is all hiss). */
function gasKick(A: Host, level: number): void {
  const r = new Rig(A);
  const t = A.t0;
  const o = r.dest({ vol: 0.45 + 0.4 * level, rev: 0.08 });
  // kept in the mids: a sub thump here would only make the compressor swallow the hiss it is meant to launch
  r.tone(o, { f0: 190, f1: 70, glide: 0.05, t, peak: 0.32, a: 0.002, d: 0.07 });
  r.burst(o, { kind: 'pink', t, peak: 1.2, a: 0.002, d: 0.06, type: 'bandpass', f0: 700, q: 0.8 });
  r.burst(o, { t, peak: 1.3, a: 0.001, d: 0.05, type: 'bandpass', f0: 2400, f1: 5200, sweep: 0.04, q: 1.2 });
}


// ───────────────────────────────────────────────────────────────────────── registration

const SAT = satCurve(3.5);

function host(c: GeneratorCall): Host {
  useStream({ next: () => c.rng.next() });
  const p = c.params;
  return { ctx: c.ctx, t0: c.t0, out: c.out, revIn: c.reverbIn, params: p, satHard: SAT, chord: { pc: p['pc'] ?? 2, third: p['third'] ?? 3 } };
}

/** Register a one-shot: `body` builds it from the play's numbers; `length` is how long it can ring, in seconds. */
function oneShot(name: string, length: number, body: (A: Host, p: Readonly<Record<string, number>>) => void): void {
  registerGenerator(name, (c) => { body(host(c), c.params); return length; });
}

export function registerAottGenerators(): void {
  oneShot('aott/grabbed', 1.6, (A) => grabbed(A));
  oneShot('aott/hurt', 0.5, (A) => hurt(A));
  oneShot('aott/titan-groan', 6, (A, p) => titanGroan(A, undefined, p['size']));
  oneShot('aott/behemoth', 12, (A) => behemothAppear(A));
  oneShot('aott/whoosh', 0.7, (A, p) => whoosh(A, p['strength'], p['pan']));
  oneShot('aott/wire-creak', 1.6, (A, p) => wireCreak(A, p['strength']));
  oneShot('aott/mantle', 0.7, (A) => mantle(A));
  oneShot('aott/speed-burst', 1, (A) => speedBurst(A));
  oneShot('aott/combo', 1.2, (A, p) => combo(A, p['n']));
  oneShot('aott/rescue-pickup', 0.9, (A) => rescuePickup(A));
  oneShot('aott/rescue-deliver', 2.6, (A) => rescueDeliver(A));
  oneShot('aott/civilian-lost', 2.6, (A) => civilianLost(A));
  oneShot('aott/civilian-cry', 1.8, (A, p) => civilianCry(A, undefined, p['urgency']));
  oneShot('aott/gas-kick', 0.3, (A, p) => gasKick(A, p['level'] ?? 1));
}
