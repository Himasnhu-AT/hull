// The game's continuous sounds as live generators: the winch, the gas jet, the wind, the boot scrape, the heartbeat and
// the score. Each is built once when the game starts it, follows the numbers the game passes to `set`, and is stepped by
// the engine every frame (`tick`): the heartbeat and the score schedule their notes ahead of the audio clock.
import { registerLiveGenerator, noiseBufferFor } from 'hull/audio';
import type { GeneratorCall, LiveVoice } from 'hull/audio';
import { clamp, fx, lerp, mtof, rand, Rig, smoothstep, useStream } from './rig';
import type { Host, NoiseKind } from './rig';

/** Every source a voice starts, so `stop` can end them (a looping source has no end of its own). */
let sources: AudioScheduledSourceNode[] = [];

/**
 * Looping noise source. `rate` < 1 plays the buffer slowly: brown noise at 0.01..0.2 is a full-level random LFO
 * (its ~150 Hz corner drops to 1.5..30 Hz), which is what the gusts, the buffeting and the scrape chatter run on.
 */
function loopNoise(A: Host, kind: NoiseKind, rate = 1): AudioBufferSourceNode {
  const s = A.ctx.createBufferSource();
  const buf = noiseBufferFor(A.ctx, kind);
  s.buffer = buf;
  s.loop = true;
  s.playbackRate.value = rate;
  s.start(0, fx() * (buf.duration - 0.05));
  sources.push(s);
  return s;
}

function biquad(ctx: BaseAudioContext, type: BiquadFilterType, f: number, q = 0.7): BiquadFilterNode {
  const b = ctx.createBiquadFilter();
  b.type = type; b.frequency.value = f; b.Q.value = q;
  return b;
}

function gainNode(ctx: BaseAudioContext, v: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
}

function osc(ctx: BaseAudioContext, type: OscillatorType, f: number): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = f;
  o.start();
  sources.push(o);
  return o;
}

/** Sharp-edged pulse curve: sawtooth in (-1..1) -> spike right after the wrap, for ratchet clicks. */
function spikeCurve(width = 0.1, n = 1024): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const u = Math.max(0, 1 - (x + 1) / (width * 2));
    c[i] = u * u;
  }
  return c;
}


class ReelLoop {
  ctx: BaseAudioContext;
  level: number;
  out: GainNode;
  s1: OscillatorNode; s2: OscillatorNode; s3: OscillatorNode;
  lp: BiquadFilterNode;
  motorGain: GainNode;
  whine: OscillatorNode; whine2: OscillatorNode; wob: OscillatorNode; whineGain: GainNode;
  tickOsc: OscillatorNode; tickGain: GainNode; tickNoise: AudioBufferSourceNode; tickBp: BiquadFilterNode; tickTone: OscillatorNode; tickLevel: GainNode;

  constructor(A: Host) {
    const ctx = A.ctx as BaseAudioContext;
    this.ctx = ctx;
    this.level = 0;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(A.out);

    // motor whirr: two detuned saws + octave sine through a resonant lowpass
    this.s1 = osc(ctx, 'sawtooth', 80);
    this.s2 = osc(ctx, 'sawtooth', 81.4);
    this.s3 = osc(ctx, 'sine', 160);
    const mix = ctx.createGain();
    mix.gain.value = 0.5;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 600;
    this.lp.Q.value = 3.5;
    this.motorGain = ctx.createGain();
    this.motorGain.gain.value = 0;
    this.s1.connect(mix); this.s2.connect(mix); this.s3.connect(mix);
    mix.connect(this.lp); this.lp.connect(this.motorGain); this.motorGain.connect(this.out);

    // servo whine with a little wobble
    this.whine = osc(ctx, 'sine', 1000);
    this.wob = osc(ctx, 'sine', 6.5);
    const wobG = ctx.createGain();
    wobG.gain.value = 22;
    this.wob.connect(wobG); wobG.connect(this.whine.frequency);
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = 0;
    this.whine.connect(this.whineGain); this.whineGain.connect(this.out);
    // a fifth above, quieter: gives the whine an edge that survives under the wind
    this.whine2 = osc(ctx, 'triangle', 1500);
    const wobG2 = ctx.createGain();
    wobG2.gain.value = 33;
    this.wob.connect(wobG2); wobG2.connect(this.whine2.frequency);
    const w2 = ctx.createGain();
    w2.gain.value = 0.3;
    this.whine2.connect(w2); w2.connect(this.whineGain);

    // ratchet ticks: sawtooth -> spike shaper -> amplitude of (noise + tone)
    this.tickOsc = osc(ctx, 'sawtooth', 10);
    const spike = ctx.createWaveShaper();
    spike.curve = spikeCurve(0.07);
    this.tickOsc.connect(spike);
    this.tickGain = ctx.createGain();
    this.tickGain.gain.value = 0;
    spike.connect(this.tickGain.gain);
    this.tickNoise = loopNoise(A, 'white');
    this.tickBp = ctx.createBiquadFilter();
    this.tickBp.type = 'bandpass';
    this.tickBp.frequency.value = 3200;
    this.tickBp.Q.value = 1.6;
    this.tickTone = osc(ctx, 'sine', 1900);
    const tt = ctx.createGain();
    tt.gain.value = 0.5;
    this.tickNoise.connect(this.tickBp); this.tickBp.connect(this.tickGain);
    this.tickTone.connect(tt); tt.connect(this.tickGain);
    this.tickLevel = ctx.createGain();
    this.tickLevel.gain.value = 0;
    this.tickGain.connect(this.tickLevel); this.tickLevel.connect(this.out);
  }

  set(levelIn: number): void {
    const level = clamp(Number.isFinite(levelIn) ? levelIn : 0, 0, 1);
    if (Math.abs(level - this.level) < 0.004 && (level > 0) === (this.level > 0)) return;
    this.level = level;
    const t = this.ctx.currentTime;
    const on = level > 0.02;
    const lv = on ? level : 0;
    const tc = on ? 0.05 : 0.07;
    const base = 62 + 250 * Math.pow(lv, 0.9);
    this.out.gain.setTargetAtTime(on ? 0.065 + 0.02 * lv : 0, t, tc);
    this.s1.frequency.setTargetAtTime(base, t, 0.09);
    this.s2.frequency.setTargetAtTime(base * 1.017, t, 0.09);
    this.s3.frequency.setTargetAtTime(base * 2, t, 0.09);
    this.lp.frequency.setTargetAtTime(380 + 2600 * lv, t, 0.09);
    this.motorGain.gain.setTargetAtTime(on ? 0.22 + 0.5 * lv : 0, t, tc);
    // the servo whine is the reel's speed cue: two octaves of travel, and loud enough to follow
    const wf = 700 * Math.pow(4, lv);
    this.whine.frequency.setTargetAtTime(wf, t, 0.08);
    this.whine2.frequency.setTargetAtTime(wf * 1.5, t, 0.08);
    this.whineGain.gain.setTargetAtTime(on ? 0.035 + 0.11 * lv : 0, t, tc);
    this.tickOsc.frequency.setTargetAtTime(8 + 36 * lv, t, 0.07);
    this.tickBp.frequency.setTargetAtTime(2600 + 2400 * lv, t, 0.08);
    this.tickTone.frequency.setTargetAtTime(1700 + 1500 * lv, t, 0.08);
    this.tickLevel.gain.setTargetAtTime(on ? 0.45 + 0.35 * lv : 0, t, tc);
  }
}

// ─────────────────────────────────────────────────────────────────────────────


class GasLoop {
  A: Host;
  ctx: BaseAudioContext;
  level: number;
  out: GainNode;
  flut: GainNode;
  lfo: OscillatorNode;
  bp: BiquadFilterNode;
  edge: BiquadFilterNode;

  constructor(A: Host) {
    const ctx = A.ctx as BaseAudioContext;
    this.A = A;
    this.ctx = ctx;
    this.level = 0;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(A.out);
    // flutter on the jet (pressure fluctuation)
    this.flut = ctx.createGain();
    this.flut.gain.value = 0.92;
    this.flut.connect(this.out);
    this.lfo = osc(ctx, 'sine', 19);
    const lg = ctx.createGain();
    lg.gain.value = 0.07;
    this.lfo.connect(lg); lg.connect(this.flut.gain);

    const n = loopNoise(A, 'white');
    this.bp = ctx.createBiquadFilter(); // main hiss body
    this.bp.type = 'bandpass'; this.bp.frequency.value = 3200; this.bp.Q.value = 1.0;
    const g1 = ctx.createGain(); g1.gain.value = 1.0;
    this.edge = ctx.createBiquadFilter(); // resonant edge: the whistle of the nozzle
    this.edge.type = 'bandpass'; this.edge.frequency.value = 6800; this.edge.Q.value = 9;
    const g2 = ctx.createGain(); g2.gain.value = 0.16;
    const body = ctx.createBiquadFilter(); // low body
    body.type = 'lowpass'; body.frequency.value = 900; body.Q.value = 0.7;
    const g3 = ctx.createGain(); g3.gain.value = 0.28;
    const hp = ctx.createBiquadFilter(); // keep rumble out of the main hiss
    hp.type = 'highpass'; hp.frequency.value = 1100;
    n.connect(this.bp); this.bp.connect(g1); g1.connect(hp); hp.connect(this.flut);
    n.connect(this.edge); this.edge.connect(g2); g2.connect(this.flut);
    n.connect(body); body.connect(g3); g3.connect(this.flut);
  }

  set(levelIn: number): void {
    const level = clamp(Number.isFinite(levelIn) ? levelIn : 0, 0, 1);
    if (Math.abs(level - this.level) < 0.004 && (level > 0) === (this.level > 0)) return;
    const prev = this.level;
    this.level = level;
    const t = this.ctx.currentTime;
    const on = level > 0.01;
    const g = on ? 0.24 * Math.pow(level, 0.8) : 0;
    this.out.gain.cancelScheduledValues(t);
    if (on && prev < 0.15 && level > 0.5) {
      // start of a burst: pressure spike that settles, on top of the valve's thump
      this.out.gain.setTargetAtTime(g * 2.6, t, 0.008);
      this.out.gain.setTargetAtTime(g, t + 0.05, 0.06);
    } else {
      this.out.gain.setTargetAtTime(g, t, on ? 0.01 : 0.04); // attack ~30 ms, release ~120 ms
    }
    this.bp.frequency.setTargetAtTime(2500 + 2400 * level, t, 0.05);
    this.edge.frequency.setTargetAtTime(6200 + 1600 * level, t, 0.05);
  }
}


class WindLoop {
  ctx: BaseAudioContext;
  speed: number;
  out: GainNode;
  rumbleLp: BiquadFilterNode; rumble: GainNode;
  whooshBp: BiquadFilterNode; whoosh: GainNode;
  buffet: GainNode; buffetSrc: AudioBufferSourceNode;
  sideBp: BiquadFilterNode[]; side: GainNode[];
  whistleBp: BiquadFilterNode; whistleBp2: BiquadFilterNode; whistle: GainNode; whistle2: GainNode;
  wanderLfo: OscillatorNode; wanderLfo2: OscillatorNode;
  airHp: BiquadFilterNode; air: GainNode;

  constructor(A: Host) {
    const ctx = A.ctx as BaseAudioContext;
    this.ctx = ctx;
    this.speed = 0;
    this.out = ctx.createGain();
    this.out.gain.value = 0.3;
    this.out.connect(A.out);
    const pan = (v: number): AudioNode => {
      if (!ctx.createStereoPanner) return this.out;
      const p = ctx.createStereoPanner();
      p.pan.value = v;
      p.connect(this.out);
      return p;
    };

    // low rumble (high-passed: below ~40 Hz it is inaudible and only eats the compressor's headroom)
    this.rumbleLp = biquad(ctx, 'lowpass', 140);
    this.rumble = gainNode(ctx, 0);
    const rumbleHp = biquad(ctx, 'highpass', 42);
    loopNoise(A, 'brown').connect(rumbleHp); rumbleHp.connect(this.rumbleLp); this.rumbleLp.connect(this.rumble); this.rumble.connect(this.out);

    // centre whoosh: the body of the wind. Its level rides a slow random gust plus, as speed builds, the fast
    // irregular buffeting of air tearing past the ears: the flutter is what sells speed.
    this.whooshBp = biquad(ctx, 'bandpass', 500, 0.6);
    this.whoosh = gainNode(ctx, 0);
    const gust = gainNode(ctx, 1);
    loopNoise(A, 'pink').connect(this.whooshBp); this.whooshBp.connect(this.whoosh); this.whoosh.connect(gust); gust.connect(this.out);
    const slow = gainNode(ctx, 0.9);
    loopNoise(A, 'brown', 0.012).connect(slow); slow.connect(gust.gain);
    this.buffetSrc = loopNoise(A, 'brown', 0.08);
    this.buffet = gainNode(ctx, 0);
    this.buffetSrc.connect(this.buffet); this.buffet.connect(gust.gain);

    // side streams: two decorrelated bands hard left and right, each with its own gusting, that open up with speed
    // (still air is mono; at 60 m/s the wind is wide and moving).
    this.sideBp = []; this.side = [];
    for (const sgn of [-1, 1]) {
      const bp = biquad(ctx, 'bandpass', 800, 0.8);
      const g = gainNode(ctx, 0);
      const sg = gainNode(ctx, 1);
      loopNoise(A, 'pink').connect(bp); bp.connect(g); g.connect(sg); sg.connect(pan(sgn * 0.9));
      const lfo = gainNode(ctx, 1.1);
      loopNoise(A, 'brown', sgn < 0 ? 0.017 : 0.023).connect(lfo); lfo.connect(sg.gain);
      this.buffet.connect(sg.gain);
      this.sideBp.push(bp); this.side.push(g);
    }

    // high whistle (narrow resonances whose pitch wanders), one a little to each side
    const white = loopNoise(A, 'white');
    this.whistleBp = biquad(ctx, 'bandpass', 2600, 14);
    this.whistleBp2 = biquad(ctx, 'bandpass', 4100, 10);
    this.whistle = gainNode(ctx, 0);
    this.whistle2 = gainNode(ctx, 0);
    white.connect(this.whistleBp); white.connect(this.whistleBp2);
    this.whistleBp.connect(this.whistle); this.whistle.connect(pan(-0.45));
    this.whistleBp2.connect(this.whistle2); this.whistle2.connect(pan(0.45));
    this.wanderLfo = osc(ctx, 'sine', 0.43);
    const wg = gainNode(ctx, 180);
    this.wanderLfo.connect(wg); wg.connect(this.whistleBp.frequency);
    this.wanderLfo2 = osc(ctx, 'sine', 0.71);
    const wg2 = gainNode(ctx, 260);
    this.wanderLfo2.connect(wg2); wg2.connect(this.whistleBp2.frequency);

    // hiss of fast air
    this.airHp = biquad(ctx, 'highpass', 5500);
    this.air = gainNode(ctx, 0);
    white.connect(this.airHp); this.airHp.connect(this.air); this.air.connect(this.out);
  }

  set(speedIn: number): void {
    const speed = Number.isFinite(speedIn) ? Math.max(0, speedIn) : 0;
    if (Math.abs(speed - this.speed) < 0.15) return;
    this.speed = speed;
    const t = this.ctx.currentTime;
    // 0 at a walk, ~0.36 at 30 m/s, ~0.92 at 70 m/s
    const s = clamp((speed - 4) / 72, 0, 1);
    const tc = 0.18;
    this.rumble.gain.setTargetAtTime(0.42 * Math.pow(s, 0.85), t, tc);
    this.rumbleLp.frequency.setTargetAtTime(120 + 240 * s, t, tc);
    this.whoosh.gain.setTargetAtTime(0.26 * Math.pow(s, 0.6) * smoothstep(0, 0.25, s), t, tc);
    this.whooshBp.frequency.setTargetAtTime(400 + 1500 * s, t, tc);
    this.whooshBp.Q.setTargetAtTime(0.5 + 0.5 * s, t, tc);
    const side = 0.62 * Math.pow(s, 1.4);
    for (let i = 0; i < 2; i++) {
      this.side[i].gain.setTargetAtTime(side, t, tc);
      this.sideBp[i].frequency.setTargetAtTime((650 + 2100 * s) * (i ? 1.12 : 0.9), t, tc);
    }
    this.buffet.gain.setTargetAtTime(smoothstep(0.15, 0.9, s), t, tc);
    this.buffetSrc.playbackRate.setTargetAtTime(0.05 + 0.11 * s, t, tc);
    const wh = 0.15 * smoothstep(0.22, 1, s);
    this.whistle.gain.setTargetAtTime(wh, t, tc);
    this.whistle2.gain.setTargetAtTime(wh, t, tc);
    this.whistleBp.frequency.setTargetAtTime(2200 + 1500 * s, t, tc);
    this.whistleBp2.frequency.setTargetAtTime(3600 + 2200 * s, t, tc);
    this.air.gain.setTargetAtTime(0.1 * smoothstep(0.3, 1, s), t, tc);
    this.airHp.frequency.setTargetAtTime(6500 - 1800 * s, t, tc);
  }
}

// ─────────────────────────────────────────────────────────────────────────────


/** Boots and gear dragging along stone or bark: gritty noise bands whose level chatters irregularly (stick-slip). */
class ScrapeLoop {
  ctx: BaseAudioContext;
  level: number;
  out: GainNode;
  bp: BiquadFilterNode;
  gritBp: BiquadFilterNode;
  chatter: AudioBufferSourceNode;

  constructor(A: Host) {
    const ctx = A.ctx as BaseAudioContext;
    this.ctx = ctx;
    this.level = 0;
    this.out = gainNode(ctx, 0);
    this.out.connect(A.out);
    const am = gainNode(ctx, 0.6);
    am.connect(this.out);
    this.chatter = loopNoise(A, 'brown', 0.09);
    const depth = gainNode(ctx, 1.1);
    this.chatter.connect(depth); depth.connect(am.gain);
    // the drag itself
    this.bp = biquad(ctx, 'bandpass', 1300, 0.9);
    loopNoise(A, 'pink').connect(this.bp); this.bp.connect(am);
    // grit catching under the sole
    this.gritBp = biquad(ctx, 'bandpass', 4200, 2.2);
    const grit = gainNode(ctx, 0.4);
    loopNoise(A, 'white').connect(this.gritBp); this.gritBp.connect(grit); grit.connect(am);
    // low rub of the body against the surface
    const rub = biquad(ctx, 'lowpass', 260);
    const rubG = gainNode(ctx, 0.3);
    loopNoise(A, 'brown').connect(rub); rub.connect(rubG); rubG.connect(am);
  }

  set(levelIn: number): void {
    const level = clamp(Number.isFinite(levelIn) ? levelIn : 0, 0, 1);
    if (Math.abs(level - this.level) < 0.004 && (level > 0) === (this.level > 0)) return;
    this.level = level;
    const t = this.ctx.currentTime;
    const on = level > 0.02;
    this.out.gain.setTargetAtTime(on ? 0.3 * Math.pow(level, 0.9) : 0, t, on ? 0.03 : 0.06);
    this.bp.frequency.setTargetAtTime(900 + 1500 * level, t, 0.06);
    this.gritBp.frequency.setTargetAtTime(3400 + 2200 * level, t, 0.06);
    this.chatter.playbackRate.setTargetAtTime(0.05 + 0.13 * level, t, 0.06);
  }
}

// ─────────────────────────────────────────────────────────────────────────────


/**
 * Stereo reverb impulse response: decaying noise whose highs die faster than its lows, a handful of
 * sparse early reflections and (optionally) two wall slap-backs for an outdoor "between city walls" feel.
 */
interface IROptions { rt60?: number; pre?: number; bright?: number; dark?: number; slap?: boolean; early?: boolean; hp?: number }

function impulseResponse(ctx: BaseAudioContext, seconds: number, { rt60 = 2.2, pre = 0.012, bright = 0.85, dark = 0.2, slap = true, early = true, hp = 0.985 }: IROptions = {}): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(seconds * sr);
  const buf = ctx.createBuffer(2, len, sr);
  const k = 6.908 / rt60;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let y = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr - pre;
      if (t < 0) continue;
      const env = Math.exp(-t * k) * Math.min(1, t / 0.02);
      const a = lerp(bright, dark, Math.min(1, t / (rt60 * 0.8)));
      y += a * ((fx() * 2 - 1) - y);
      d[i] = y * env * 2.2;
    }
    // high-pass the tail (one-pole) so the reverb never adds boomy low end under every sound
    let px = 0, py = 0;
    for (let i = 0; i < len; i++) {
      const x = d[i];
      py = hp * (py + x - px);
      px = x;
      d[i] = py;
    }
    const tap = (time: number, amp: number): void => {
      const i = Math.floor((time + (ch ? 0.0011 : 0)) * sr);
      for (let j = 0; j < 12 && i + j < len; j++) d[i + j] += amp * (fx() * 2 - 1) * (1 - j / 12);
    };
    if (early) {
      [0.017, 0.031, 0.047, 0.071, 0.098].forEach((tm, n) => tap(tm + ch * 0.0023, 0.5 / (1 + n * 0.5)));
    }
    if (slap) {
      tap(0.142 + ch * 0.011, 0.34);
      tap(0.27 + ch * 0.017, 0.22);
    }
  }
  return buf;
}


interface Chord { pc: number; third: number; root: number; voice: number[] }
type LayerName = 'ambStr' | 'ambChoir' | 'str' | 'hi' | 'bass' | 'drum' | 'brass' | 'warChoir' | 'theme';
type Levels = Record<LayerName, number>;

const BPM = 150;
const BEAT = 60 / BPM; // 0.4 s
const BAR = BEAT * 4; // 1.6 s
const LOOKAHEAD = 0.16; // seconds scheduled ahead of the audio clock (timer runs every 25 ms)

// Dm | Bb | F | C | Dm | Gm | A | A   (8-bar cycle = 12.8 s)
const PROG: Chord[] = [
  [2, 3], [10, 4], [5, 4], [0, 4], [2, 3], [7, 3], [9, 4], [9, 4],
].map(([pc, third]): Chord => {
  let root = 36 + pc;
  if (root > 41) root -= 12; // bass root range G1..F2
  const voice = [pc, (pc + third) % 12, (pc + 7) % 12].map((p) => 57 + ((((p - 57) % 12) + 12) % 12)).sort((a, b) => a - b);
  return { pc, third, root, voice };
});

// The heroic theme, one entry per bar: [startBeat, durationBeats, midi]
const THEME: [number, number, number][][] = [
  [[0, 2, 69], [2, 1, 74], [3, 1, 77]],
  [[0, 3, 77], [3, 1, 74]],
  [[0, 2, 72], [2, 1, 77], [3, 1, 81]],
  [[0, 1.5, 79], [1.5, 1.5, 76], [3, 1, 72]],
  [[0, 2, 74], [2, 1, 77], [3, 1, 81]],
  [[0, 2, 79], [2, 1, 77], [3, 1, 74]],
  [[0, 1.5, 73], [1.5, 0.5, 76], [2, 2, 81]],
  [[0, 1, 76], [1, 1, 74], [2, 2, 73]],
];

// 16th-step ostinato: [semitone offset above the chord root (two octaves over the bass root), accent]
const OST: [number | '3', number][] = [
  [0, 1.0], [0, 0.45], [12, 0.55], [0, 0.85],
  [0, 0.45], [7, 0.55], [0, 0.95], [0, 0.45],
  [12, 0.6], [0, 0.85], [0, 0.45], ['3', 0.7],
  [7, 0.95], [0, 0.45], [12, 0.75], [7, 0.6],
];
const OST_ACCENTS = new Set([0, 3, 6, 9, 12, 14]);

// Per-layer: base gain and reverb send
const LAYERS: Record<LayerName, [number, number]> = {
  ambStr: [1.5, 0.65],
  ambChoir: [1.7, 0.8],
  str: [2.3, 0.2],
  hi: [0.65, 0.3],
  bass: [1.0, 0.05],
  drum: [1.25, 0.22],
  brass: [0.8, 0.3],
  warChoir: [0.7, 0.5],
  theme: [0.8, 0.55],
};

const LAYER_NAMES = Object.keys(LAYERS) as LayerName[];
/** The action level at which the score plays exactly as its intensity alone dictates (and the default). */
const ACT_NEUTRAL = 0.3;

export function layerLevels(i: number): Levels {
  return {
    ambStr: 1 - smoothstep(0.12, 0.42, i),
    ambChoir: 1 - smoothstep(0.15, 0.45, i),
    str: smoothstep(0.2, 0.38, i),
    drum: smoothstep(0.25, 0.42, i),
    bass: smoothstep(0.38, 0.55, i),
    brass: smoothstep(0.58, 0.78, i),
    warChoir: smoothstep(0.62, 0.8, i),
    hi: smoothstep(0.8, 0.95, i),
    theme: smoothstep(0.85, 0.97, i),
  };
}

class Music {
  A: Host;
  ctx: BaseAudioContext;
  /** The mode's intensity, as given to setIntensity. */
  intensity: number;
  /** Intensity after the action bias: what the arrangement actually plays at. */
  eff: number;
  /** Smoothed action level and its bookkeeping. */
  act: number; actApplied: number; actT: number;
  /** Beat length of the bar being scheduled (shrinks a little as the action rises). */
  beat: number;
  /** Double-time percussion amount of the bar being scheduled, 0..1. */
  drive: number;
  lv: Levels;
  step: number;
  next: number | null;
  cycle: number;
  rev: ConvolverNode;
  revIn: GainNode;
  revOut: GainNode;
  /** Layer buses and their base gains. */
  L: Record<LayerName, GainNode>;
  vol: Record<LayerName, number>;
  net: GainNode;
  netOut: GainNode;
  netBuses: LayerName[];
  vib: OscillatorNode;
  vibAmt: GainNode;

  constructor(A: Host) {
    this.A = A;
    const ctx = (this.ctx = A.ctx as BaseAudioContext);
    this.intensity = 0;
    this.eff = 0;
    this.act = ACT_NEUTRAL; this.actApplied = ACT_NEUTRAL; this.actT = -1;
    this.beat = BEAT;
    this.drive = 0;
    this.lv = layerLevels(0);
    this.step = 0;
    this.next = null;
    this.cycle = 0;

    // hall reverb for the whole score
    this.rev = ctx.createConvolver();
    this.rev.buffer = impulseResponse(ctx, 3.4, { rt60: 3.1, pre: 0.02, bright: 0.6, dark: 0.12, slap: false, early: false, hp: 0.98 });
    this.revIn = ctx.createGain();
    this.revIn.gain.value = 1;
    this.revOut = ctx.createGain();
    this.revOut.gain.value = 0.75;
    this.revIn.connect(this.rev); this.rev.connect(this.revOut); this.revOut.connect(A.out);

    // layer buses
    this.L = {} as Record<LayerName, GainNode>;
    this.vol = {} as Record<LayerName, number>;
    for (const name of LAYER_NAMES) {
      const [vol, send] = LAYERS[name];
      const g = ctx.createGain();
      g.gain.value = 0;
      const s = ctx.createGain();
      s.gain.value = send;
      g.connect(A.out); g.connect(s); s.connect(this.revIn);
      this.L[name] = g;
      this.vol[name] = vol;
    }
    // shared choir formant network ("aah"): ambient, war and theme voices all pass through it
    this.net = ctx.createGain();
    const sum = ctx.createGain();
    sum.gain.value = 1;
    for (const [f, q, gn] of [[700, 3.5, 1.1], [1200, 5, 0.8], [2600, 7, 0.4]]) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
      const g = ctx.createGain(); g.gain.value = gn;
      this.net.connect(bp); bp.connect(g); g.connect(sum);
    }
    const body = ctx.createBiquadFilter();
    body.type = 'lowpass'; body.frequency.value = 1400; body.Q.value = 0.5;
    const bg = ctx.createGain(); bg.gain.value = 0.35;
    this.net.connect(body); body.connect(bg); bg.connect(sum);
    this.netOut = ctx.createGain();
    this.netOut.gain.value = 1.4;
    sum.connect(this.netOut);
    this.netBuses = ['ambChoir', 'warChoir', 'theme'];
    for (const n of this.netBuses) {
      // these layer buses feed the network instead of the music bus directly
      this.L[n].disconnect();
      this.L[n].connect(this.net);
    }
    this.netOut.connect(A.out);
    const netSend = ctx.createGain(); netSend.gain.value = 0.55;
    this.netOut.connect(netSend); netSend.connect(this.revIn);

    // shared choir vibrato
    this.vib = ctx.createOscillator();
    this.vib.type = 'sine';
    this.vib.frequency.value = 5.3;
    this.vibAmt = ctx.createGain();
    this.vibAmt.gain.value = 13; // cents
    this.vib.connect(this.vibAmt);
    this.vib.start();

    this.setIntensity(0, true);
  }

  // ──────────────────────────────────────────────────────────── control

  setIntensity(iIn: number, immediate = false): void {
    this.intensity = clamp(Number.isFinite(iIn) ? iIn : 0, 0, 1);
    this.refresh(immediate);
  }

  /**
   * How intense the moment is, 0..1, fed raw every frame. Smoothed here (quick to rise, slow to settle) and applied
   * in steps of 2.5 %, so the layer gains glide and never pump. At ACT_NEUTRAL the score is untouched.
   */
  setAction(aIn: number): void {
    const a = clamp(Number.isFinite(aIn) ? aIn : 0, 0, 1);
    const t = this.ctx.currentTime;
    const dt = this.actT < 0 ? 0 : clamp(t - this.actT, 0, 0.25);
    this.actT = t;
    this.act += (a - this.act) * (1 - Math.exp(-dt / (a > this.act ? 0.7 : 2.2)));
    if (Math.abs(this.act - this.actApplied) > 0.025) this.refresh(false);
  }

  /** How far the action may move the score: nothing in menus and ambient states, fully once the battle layers are in. */
  live(): number {
    return smoothstep(0.18, 0.36, this.intensity);
  }

  /** The chord sounding now (the scheduler runs a couple of steps ahead of the clock). */
  chord(): { pc: number; third: number } {
    return PROG[Math.floor(Math.max(0, this.step - 2) / 16) % 8];
  }

  refresh(immediate: boolean): void {
    const prev = this.lv;
    const bias = (this.act - ACT_NEUTRAL) * this.live(); // -0.3 .. +0.7
    this.actApplied = this.act;
    this.eff = clamp(this.intensity + 0.2 * bias, 0, 1);
    const lv = layerLevels(this.eff);
    lv.drum *= 1 + 0.2 * bias;
    lv.str *= 1 + 0.2 * bias;
    // the high strings answer a hot moment even before the mode itself reaches its climax
    lv.hi = Math.max(lv.hi, 0.7 * lv.str * smoothstep(0.35, 0.7, bias));
    this.lv = lv;
    const t = this.ctx.currentTime;
    for (const name of LAYER_NAMES) {
      const target = this.lv[name] * this.vol[name];
      const g = this.L[name].gain;
      g.cancelScheduledValues(t);
      if (immediate) g.setValueAtTime(target, t);
      else g.setTargetAtTime(target, t, this.lv[name] > prev[name] ? 0.3 : 0.8); // layers enter quickly, leave slowly
    }
  }

  /**
   * Lookahead scheduler, run from the engine's per-frame tick: queue every 16th-note step that falls before
   * now + LOOKAHEAD. If the clock got far ahead (a stalled or throttled tab) it starts again from now.
   */
  tick(now: number): void {
    if (this.next === null || this.next < now - LOOKAHEAD * 2.5) this.next = now + 0.06;
    const until = now + LOOKAHEAD;
    let guard = 0;
    while (this.next < until && guard++ < 64) {
      this.scheduleStep(this.step, this.next);
      this.next += this.beat / 4;
      this.step++;
    }
  }

  // ──────────────────────────────────────────────────────────── sequencing

  scheduleStep(step: number, t: number): void {
    const bar = Math.floor(step / 16);
    const s = step % 16;
    const bi = bar % 8;
    const ch = PROG[bi];
    const lv = this.lv;
    if (s === 0) {
      // latch the bar's tempo and drive: at most 1.2 % of tempo change from one bar to the next
      const hot = clamp((this.act - ACT_NEUTRAL) / (1 - ACT_NEUTRAL), 0, 1) * this.live();
      const mul = clamp(1 + 0.04 * hot, (BEAT / this.beat) - 0.012, (BEAT / this.beat) + 0.012);
      this.beat = BEAT / mul;
      this.drive = smoothstep(0.3, 0.9, hot);
      this.scheduleBar(bar, bi, ch, t);
    }

    // string ostinato
    if (lv.str > 0.03) {
      const [o0, acc] = OST[s];
      let off = o0 === '3' ? 12 + ch.third : o0;
      if (bi === 7 && s >= 12) off = [7, 12, 15, 19][s - 12]; // rising run into the next cycle
      const note = ch.root + 24 + off;
      const accent = OST_ACCENTS.has(s);
      this.pluck(t, note, 0.08 + (accent ? 0.045 : 0), 0.4 + 0.6 * acc, this.L.str, false);
      if (accent) this.pluck(t, note - 12, 0.11, 0.35 + 0.35 * acc, this.L.str, false); // cellos double the accents
      if (lv.hi > 0.03 && accent) this.pluck(t, note + 12, 0.1, 0.55 + 0.4 * acc, this.L.hi, true);
    }
    // bass: eighth-note pulse
    if (lv.bass > 0.03 && s % 2 === 0) this.bass(t, ch.root, 0.16, s === 0 ? 1 : s % 4 === 0 ? 0.75 : 0.55);

    // drums
    if (lv.drum > 0.03) this.drums(bi, s, t);
  }

  scheduleBar(bar: number, bi: number, ch: Chord, t: number): void {
    const lv = this.lv;
    const BEAT = this.beat, BAR = BEAT * 4; // this bar's own beat
    // ambient pads change every second bar
    if (bar % 2 === 0) {
      const ac = PROG[(bar >> 1) % 8];
      if (lv.ambStr > 0.03) {
        const dur = BAR * 2 + 0.9;
        for (const m of ac.voice) this.padNote(t, dur, m, this.L.ambStr, 0.07);
        this.padNote(t, dur, ac.root + 12, this.L.ambStr, 0.09);
        this.padNote(t, dur, ac.voice[2] + 12, this.L.ambStr, 0.035, true);
      }
      if (lv.ambChoir > 0.03) {
        const dur = BAR * 2 + 1.2;
        ac.voice.forEach((m, i) => this.choirNote(t, dur, m, this.L.ambChoir, 0.16, 1.3, 1.8, i));
        this.choirNote(t, dur, ac.voice[0] + 12, this.L.ambChoir, 0.1, 1.5, 1.8, 3);
      }
    }
    // brass: swelling stab on the downbeat, shorter stabs later in the bar
    if (lv.brass > 0.03) {
      const big = bi === 0 || bi === 4;
      this.brass(t, ch, big ? 1.1 : 0.62, 1);
      this.brass(t + BEAT * 2, ch, 0.34, 0.75);
      if (bi % 2 === 1 || bi === 7) this.brass(t + BEAT * 3.5, ch, 0.24, 0.7);
    }
    // war choir: one sustained chord per bar
    if (lv.warChoir > 0.03) {
      const dur = BAR + 0.15;
      ch.voice.forEach((m, i) => this.choirNote(t, dur, m, this.L.warChoir, 0.2, 0.18, 0.5, i));
      this.choirNote(t, dur, ch.voice[2] + 12, this.L.warChoir, 0.11, 0.2, 0.5, 4);
      this.choirNote(t, dur, ch.root + 12, this.L.warChoir, 0.14, 0.18, 0.5, 5);
    }
    // theme
    if (lv.theme > 0.05) {
      for (const [b, d, m] of THEME[bi]) {
        this.choirNote(t + b * BEAT, d * BEAT + 0.08, m, this.L.theme, 0.34, 0.07, 0.22, 6);
        this.choirNote(t + b * BEAT, d * BEAT + 0.08, m - 12, this.L.theme, 0.18, 0.09, 0.22, 7);
      }
    }
    // cymbal crash on the first bar of the cycle (and half-way through at full intensity)
    if (lv.drum > 0.5 && this.eff > 0.55 && (bi === 0 || (bi === 4 && this.eff > 0.85))) this.crash(t, bi === 0 ? 1 : 0.7);
  }

  drums(bi: number, s: number, t: number): void {
    const I = this.eff + 0.2 * this.drive; // a hot moment thickens the pattern too
    const v = this.lv.drum;
    const lastBar = bi === 7;
    // big taiko: downbeat, beat 3, plus syncopation as intensity grows
    if (s === 0) this.taiko(t, 1.0 * v, 66);
    if (s === 8 && !lastBar) this.taiko(t, 0.9 * v, 66);
    if (I > 0.5 && (s === 6 || s === 11 || s === 14)) this.taiko(t, 0.7 * v, 78);
    if (I > 0.8 && (s === 3 || s === 10)) this.taiko(t, 0.65 * v, 78);
    // shime / rim backbeat
    if (s === 4 || s === 12) this.rim(t, 0.9 * v, 1);
    if (I > 0.6 && (s === 2 || s === 7 || s === 15)) this.rim(t, 0.35 * v, 1.25);
    // turnaround fill: rolling 16ths on the last bar of the cycle
    if (lastBar && s >= 8) {
      const k = (s - 8) / 8;
      this.taiko(t, (0.45 + 0.5 * k) * v, 66 + (s % 2 ? 22 : 8) + 8 * (1 - k));
      if (s >= 12) this.rim(t, (0.4 + 0.5 * k) * v, 1.3);
    } else if (s === 12 || s === 14) { // light pickup into the next bar
      if (I > 0.7 && bi % 2 === 1) this.taiko(t, 0.5 * v, 90);
    }
    // action drive: shime ghost notes on the off-16ths, a double-time pulse under the pattern
    if (this.drive > 0.05 && s % 2 === 1) this.rim(t, (s % 4 === 3 ? 0.3 : 0.2) * this.drive * v, 1.7);
  }

  // ──────────────────────────────────────────────────────────── voices

  /** Plucked string-section note: two detuned saws through a quickly closing lowpass. */
  pluck(t: number, midi: number, len: number, vel: number, dest: AudioNode, bright: boolean): void {
    const f = mtof(midi);
    const r = new Rig(this.A);
    const end = t + len + 0.12;
    const g = r.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime((bright ? 0.1 : 0.14) * vel, t + 0.006);
    g.gain.setValueAtTime((bright ? 0.1 : 0.14) * vel, t + len * 0.4);
    g.gain.setTargetAtTime(0, t + len * 0.5, len * 0.22);
    const lp = r.filter('lowpass', f * (bright ? 9 : 7), 1.4);
    lp.frequency.setValueAtTime(f * (bright ? 9 : 7), t);
    lp.frequency.exponentialRampToValueAtTime(f * 2.4, t + len);
    const o1 = r.osc('sawtooth', f, t, end, -9);
    const o2 = r.osc('sawtooth', f, t, end, 9);
    o1.connect(lp); o2.connect(lp); lp.connect(g); g.connect(dest);
    r.seal();
  }

  /** Slow string-pad note. */
  padNote(t: number, dur: number, midi: number, dest: AudioNode, vol: number, air?: boolean): void {
    const f = mtof(midi);
    const r = new Rig(this.A);
    const end = t + dur + 1.9;
    const g = r.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 1.2);
    g.gain.setValueAtTime(vol, t + dur);
    g.gain.setTargetAtTime(0, t + dur, 0.5);
    const lp = r.filter('lowpass', air ? 3500 : 1000, 0.6);
    lp.frequency.setValueAtTime(500, t);
    lp.frequency.linearRampToValueAtTime(air ? 3500 : 1300, t + dur * 0.6);
    for (const dt of [-11, 0, 10]) {
      const o = r.osc('sawtooth', f, t, end, dt + rand(-2, 2));
      o.connect(lp);
    }
    lp.connect(g); g.connect(dest);
    r.seal();
  }

  /** Choir "aah" voice: detuned saws with shared vibrato, into the formant network via `dest`. */
  choirNote(t: number, dur: number, midi: number, dest: AudioNode, vol: number, att: number, rel: number, seed = 0): void {
    const f = mtof(midi);
    const r = new Rig(this.A);
    const end = t + dur + rel * 1.4 + 0.1;
    const g = r.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + att);
    g.gain.setValueAtTime(vol, t + Math.max(att, dur));
    g.gain.setTargetAtTime(0, t + Math.max(att, dur), rel / 4);
    const oscs: OscillatorNode[] = [];
    for (const dt of [-8, 7]) {
      const o = r.osc('sawtooth', f, t, end, dt + ((seed * 3.7) % 5) - 2);
      this.vibAmt.connect(o.detune);
      oscs.push(o);
      o.connect(g);
    }
    r.onDispose(() => { for (const o of oscs) { try { this.vibAmt.disconnect(o.detune); } catch (e) { /* ok */ } } });
    // a touch of breath
    const nz = r.noise('pink', t, dur + rel);
    const ng = r.gain(vol * 0.18);
    nz.connect(ng); ng.connect(g);
    g.connect(dest);
    r.seal();
  }

  /** Low brass stab: stacked detuned saws, filter swell. */
  brass(t: number, ch: Chord, len: number, vel: number): void {
    const r = new Rig(this.A);
    const end = t + len + 0.35;
    const g = r.gain(0);
    const pk = 0.2 * vel;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(pk, t + 0.045);
    g.gain.setValueAtTime(pk * 0.85, t + Math.max(0.06, len - 0.1));
    g.gain.setTargetAtTime(0, t + Math.max(0.06, len - 0.04), 0.07);
    const lp = r.filter('lowpass', 300, 2.6);
    lp.frequency.setValueAtTime(260, t);
    lp.frequency.exponentialRampToValueAtTime(2600, t + 0.11 + len * 0.1);
    lp.frequency.exponentialRampToValueAtTime(1000, t + Math.max(len, 0.3) + 0.1);
    const root = ch.root + 12;
    const notes = [root - 12, root, root + 7, root + 12, root + ch.third + 12];
    notes.forEach((m, i) => {
      const lvl = i === 0 ? 0.7 : i === 4 ? 0.35 : 1;
      const og = r.gain(lvl);
      for (const dt of [-13, 12]) r.osc('sawtooth', mtof(m), t, end, dt).connect(og);
      og.connect(lp);
    });
    lp.connect(g); g.connect(this.L.brass);
    // blat of air at the attack
    r.burst(this.L.brass, { t, peak: 0.05 * vel, a: 0.01, d: 0.12, type: 'bandpass', f0: 1800, q: 1 });
    r.seal();
  }

  bass(t: number, rootMidi: number, len: number, vel: number): void {
    const f = mtof(rootMidi);
    const r = new Rig(this.A);
    const end = t + len + 0.1;
    const g = r.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.22 * vel, t + 0.008);
    g.gain.setTargetAtTime(0, t + len * 0.45, len * 0.25);
    const lp = r.filter('lowpass', 420, 1.2);
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(220, t + len);
    const o1 = r.osc('sawtooth', f, t, end, -6);
    const o2 = r.osc('sine', f, t, end);
    const og = r.gain(0.9);
    o1.connect(lp); lp.connect(g); o2.connect(og); og.connect(g);
    g.connect(this.L.bass);
    r.seal();
  }

  /** Taiko: pitched-down sine thump + skin slap + low body noise. p = fundamental in Hz. */
  taiko(t: number, vel: number, p: number): void {
    if (vel < 0.02) return;
    const r = new Rig(this.A);
    const out = this.L.drum;
    r.tone(out, { f0: p * 2.3, f1: p, glide: 0.05, t, peak: 0.9 * vel, a: 0.002, d: 0.42 });
    r.tone(out, { f0: p * 1.52, f1: p * 1.2, glide: 0.08, t, peak: 0.25 * vel, a: 0.002, d: 0.16 });
    r.burst(out, { t, peak: 0.34 * vel, a: 0.001, d: 0.045, type: 'bandpass', f0: 1100, q: 0.8 });
    r.burst(out, { kind: 'brown', t, peak: 0.55 * vel, a: 0.003, d: 0.28, type: 'lowpass', f0: 220, q: 0.7 });
    r.seal();
  }

  /** Shime / rim hit. */
  rim(t: number, vel: number, pitch = 1): void {
    if (vel < 0.02) return;
    const r = new Rig(this.A);
    const out = this.L.drum;
    r.burst(out, { t, peak: 0.34 * vel, a: 0.0008, d: 0.06, type: 'bandpass', f0: 2400 * pitch, q: 1.4 });
    r.tone(out, { f0: 430 * pitch, f1: 300 * pitch, glide: 0.04, t, peak: 0.28 * vel, a: 0.001, d: 0.07 });
    r.burst(out, { t, peak: 0.12 * vel, a: 0.0008, d: 0.025, type: 'highpass', f0: 5000 });
    r.seal();
  }

  crash(t: number, vel: number): void {
    const r = new Rig(this.A);
    const out = this.L.drum;
    r.burst(out, { t, peak: 0.28 * vel, a: 0.006, d: 2.4, type: 'highpass', f0: 5200, q: 0.6 });
    r.burst(out, { t, peak: 0.14 * vel, a: 0.006, d: 1.5, type: 'bandpass', f0: 7600, q: 3 });
    r.seal();
  }
}


// ─────────────────────────────────────────────────────────────────────────────

/** One lub-dub at `when`: sub thumps with a harmonic on top so the pulse still reads on small speakers. */
function heartThump(A: Host, when: number, level: number): void {
  const r = new Rig(A);
  const o = r.dest({ vol: 0.15 + 0.25 * level });
  const dub = when + lerp(0.2, 0.14, level);
  r.tone(o, { f0: 68, f1: 40, glide: 0.07, t: when, peak: 0.6, a: 0.008, d: 0.13 });
  r.tone(o, { type: 'triangle', f0: 136, f1: 82, glide: 0.06, t: when, peak: 0.4, a: 0.006, d: 0.07 });
  r.burst(o, { kind: 'pink', t: when, peak: 1.5, a: 0.005, d: 0.05, type: 'bandpass', f0: 280, q: 1 });
  r.burst(o, { kind: 'brown', t: when, peak: 0.5, a: 0.006, d: 0.08, type: 'lowpass', f0: 180, q: 0.7 });
  r.tone(o, { f0: 84, f1: 50, glide: 0.06, t: dub, peak: 0.4, a: 0.006, d: 0.1 });
  r.tone(o, { type: 'triangle', f0: 168, f1: 100, glide: 0.05, t: dub, peak: 0.28, a: 0.005, d: 0.055 });
  r.burst(o, { kind: 'pink', t: dub, peak: 1.0, a: 0.004, d: 0.04, type: 'bandpass', f0: 340, q: 1 });
  r.seal();
}

/**
 * Low-HP / danger state, fed 0..1: a lub-dub pulse scheduled just ahead of the audio clock (70 bpm at the threshold,
 * 140 at level 1). The low-pass over the world's bus is the game adapter's (hull/audio setBusLowpass). If the game
 * stops feeding it while the level is up, the pulse stops by itself.
 */
class Heartbeat {
  level = 0;
  next = 0;
  lastSet = 0;
  constructor(readonly A: Host) { this.lastSet = A.ctx.currentTime; }
  set(levelIn: number): void {
    this.level = clamp(Number.isFinite(levelIn) ? levelIn : 0, 0, 1);
    this.lastSet = this.A.ctx.currentTime;
  }
  tick(t: number): void {
    const offline = 'startRendering' in this.A.ctx;
    const level = !offline && t - this.lastSet > 0.3 ? 0 : this.level;
    if (level <= 0.02) { this.next = 0; return; }
    const period = 60 / lerp(70, 140, level);
    if (this.next < t - 0.05) this.next = t + 0.03; // first beat, or the caller stalled
    while (this.next < t + 0.12) {
      heartThump(this.A, this.next, level);
      this.next += period;
    }
  }
}

// ───────────────────────────────────────────────────────────────────────── registration

function host(c: GeneratorCall): Host {
  useStream({ next: () => c.rng.next() });
  return { ctx: c.ctx, t0: c.t0, out: c.out, revIn: c.reverbIn, params: c.params, satHard: new Float32Array(2) as Float32Array<ArrayBuffer>, chord: { pc: 2, third: 3 } };
}

/** Wrap a built graph as a live voice: `stop` fades the output and ends every source it started. */
function voiceOf(A: Host, started: AudioScheduledSourceNode[], out: AudioNode | null, rest: Partial<LiveVoice>): LiveVoice {
  return {
    ...rest,
    stop() {
      const t = A.ctx.currentTime;
      if (out && 'gain' in out) { const g = (out as GainNode).gain; g.cancelScheduledValues(t); g.setTargetAtTime(0, t, 0.02); }
      for (const s of started) { try { s.stop(t + 0.15); } catch { /* not started */ } }
      rest.stop?.();
    },
  };
}

type Live = { set(v: number): void; out?: GainNode };
function loopVoice(name: string, make: (A: Host) => Live, demo: number, key: string): void {
  registerLiveGenerator(name, (c) => {
    const A = host(c);
    sources = [];
    const l = make(A);
    const started = sources;
    return voiceOf(A, started, l.out ?? null, { set: (p) => l.set(p[key] ?? demo) });
  });
}

export function registerAottLive(): void {
  loopVoice('aott/reel', (A) => new ReelLoop(A), 0.7, 'level');
  loopVoice('aott/gas', (A) => new GasLoop(A), 0.8, 'level');
  loopVoice('aott/wind', (A) => new WindLoop(A), 40, 'speed');
  loopVoice('aott/scrape', (A) => new ScrapeLoop(A), 0.6, 'level');
  registerLiveGenerator('aott/heartbeat', (c) => {
    const A = host(c);
    const h = new Heartbeat(A);
    return voiceOf(A, [], null, { set: (p) => h.set(p['level'] ?? 0.6), tick: (t) => h.tick(t) });
  });
  registerLiveGenerator('aott/score', (c) => {
    const A = host(c);
    sources = [];
    const m = new Music(A);
    const started = sources;
    return voiceOf(A, [...started, m.vib], null, {
      set: (p) => { m.setIntensity(p['intensity'] ?? 0.7); m.setAction(p['action'] ?? 0.3); },
      tick: (t) => m.tick(t),
      chord: () => m.chord(),
    });
  });
}
