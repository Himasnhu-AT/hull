// Helpers for the game's code-made sounds (generators): maths, and `Rig`, a tiny builder that creates one sound's node
// graph and disconnects every node once the last source ends. A `Host` is what a generator sees of the engine.
import { noiseBufferFor } from 'hull/audio';

export type NoiseKind = 'white' | 'pink' | 'brown';

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
// The stream of the play being built: every random choice in a sound comes from the engine's seeded stream, so a bench
// render repeats and a recorded run draws the same numbers.
let stream: { next(): number } = { next: () => 0.5 };
export const useStream = (s: { next(): number }): void => { stream = s; };
export const fx = (): number => stream.next();
export const rand = (a = 0, b = 1): number => a + fx() * (b - a);
export const pick = <T>(arr: readonly T[]): T => arr[(fx() * arr.length) | 0];
export const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Soft-clip curve (tanh) for waveshapers. `drive` > 1 for harder saturation. */
export function satCurve(drive = 1, n = 2048): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * drive) / norm;
  }
  return c;
}

/** Percussive amplitude envelope on an AudioParam: linear attack `a`, exponential-ish decay over `d` seconds. */
export function perc(param: AudioParam, t: number, peak: number, a: number, d: number): void {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + Math.max(a, 0.0005));
  param.setTargetAtTime(0, t + Math.max(a, 0.0005), Math.max(d, 0.004) / 5);
}

/**
 * One-shot node-graph builder. Every node created through a Rig is tracked; when the last scheduled
 * source has ended the whole graph is disconnected (so nothing leaks) and bookkeeping is released.
 */
/** Options of `Rig.tone`. */
export interface ToneOpts { type?: OscillatorType; f0: number; f1?: number; glide?: number; t: number; peak?: number; a?: number; d?: number; detune?: number }
/** Options of `Rig.burst`. */
export interface BurstOpts {
  kind?: NoiseKind; t: number; peak?: number; a?: number; d?: number; type?: BiquadFilterType; f0?: number; f1?: number; sweep?: number; q?: number;
  type2?: BiquadFilterType; f2?: number; q2?: number;
}
/** Options of `Rig.modes`. */
export interface ModesOpts { t: number; f: number[]; decay?: number | number[]; amp?: number[] | null; peak?: number; type?: OscillatorType; a?: number }

type Source = OscillatorNode | AudioBufferSourceNode;

/** What one play of a generator sees: the context, where its output goes, and the numbers the game passed. */
export interface Host {
  ctx: BaseAudioContext;
  /** Context time the sound starts at. */
  t0: number;
  /** Where the sound goes: the recipe's bus (through the engine's gain, pan and air filter when placed). */
  out: AudioNode;
  /** The shared reverb's input, or null (the bench has none). */
  revIn: AudioNode | null;
  params: Readonly<Record<string, number>>;
  satHard: Float32Array<ArrayBuffer>;
  /** The chord of the score (pitch class of the root and the third's distance), as the game last read it. */
  chord: { pc: number; third: number };
}

export class Rig {
  A: Host;
  ctx: BaseAudioContext;
  nodes: AudioNode[];
  srcs: Source[];
  live: number;
  sealed: boolean;
  dead: boolean;
  cleanups: (() => void)[];

  constructor(A: Host) {
    this.A = A;
    this.ctx = A.ctx;
    this.nodes = [];
    this.srcs = [];
    this.live = 0;
    this.sealed = false;
    this.dead = false;
    this.cleanups = [];
  }

  _t<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }
  gain(v = 1): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = v;
    return this._t(g);
  }
  filter(type: BiquadFilterType, f: number, q = 1, gainDb = 0): BiquadFilterNode {
    const b = this.ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    if (gainDb) b.gain.value = gainDb;
    return this._t(b);
  }
  shaper(curve: Float32Array<ArrayBuffer>, oversample: OverSampleType = '2x'): WaveShaperNode {
    const s = this.ctx.createWaveShaper();
    s.curve = curve;
    s.oversample = oversample;
    return this._t(s);
  }

  _start<T extends Source>(s: T, t0: number, t1: number, offset?: number): T {
    this.nodes.push(s);
    this.srcs.push(s);
    this.live++;
    s.onended = () => {
      if (--this.live <= 0) this.dispose();
    };
    if (offset !== undefined) (s as AudioBufferSourceNode).start(t0, offset);
    else s.start(t0);
    s.stop(Math.max(t1, t0 + 0.002));
    return s;
  }

  /** Oscillator running t0..t1. */
  osc(type: OscillatorType, f0: number, t0: number, t1: number, detune = 0): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    if (detune) o.detune.value = detune;
    return this._start(o, t0, t1);
  }

  /** Looped noise source ('white' | 'pink' | 'brown') running t0..t0+dur from a random offset. */
  noise(kind: NoiseKind, t0: number, dur: number): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    const buf = noiseBufferFor(this.ctx, kind);
    s.buffer = buf;
    s.loop = true;
    return this._start(s, t0, t0 + dur, rand(0, buf.duration - 0.01));
  }

  /** Oscillator with a pitch glide f0 -> f1 and a percussive amp envelope, connected to `out`. */
  tone(out: AudioNode, o: ToneOpts): GainNode {
    const { type = 'sine', f0, f1 = f0, glide = 0.05, t, peak = 0.5, a = 0.002, d = 0.2, detune = 0 } = o;
    const g = this.gain(0);
    perc(g.gain, t, peak, a, d);
    const os = this.osc(type, f0, t, t + a + d * 1.3, detune);
    if (f1 !== f0) os.frequency.exponentialRampToValueAtTime(f1, t + glide);
    os.connect(g);
    g.connect(out);
    return g;
  }

  /** Noise through one or two (optionally swept) filters with a percussive envelope, connected to `out`. */
  burst(out: AudioNode, o: BurstOpts): GainNode {
    const { kind = 'white', t, peak = 0.5, a = 0.002, d = 0.1, type = 'bandpass', f0 = 1000, f1 = f0, sweep = d, q = 1, type2, f2 = 1000, q2 = 0.7 } = o;
    const g = this.gain(0);
    perc(g.gain, t, peak, a, d);
    const n = this.noise(kind, t, a + d * 1.3);
    const f = this.filter(type, f0, q);
    if (f1 !== f0) {
      f.frequency.setValueAtTime(f0, t);
      f.frequency.exponentialRampToValueAtTime(f1, t + sweep);
    }
    n.connect(f);
    let last = f;
    if (type2) {
      const ff = this.filter(type2, f2, q2);
      f.connect(ff);
      last = ff;
    }
    last.connect(g);
    g.connect(out);
    return g;
  }

  /** Inharmonic modal partials (metal / wood / glass), each with its own decay; connected to `out`. */
  modes(out: AudioNode, o: ModesOpts): void {
    const { t, f, decay = 0.1, amp = null, peak = 0.3, type = 'sine', a = 0.0005 } = o;
    for (let i = 0; i < f.length; i++) {
      const am = Array.isArray(amp) ? amp[i] : 1 / (1 + i * 0.6);
      const dc = Array.isArray(decay) ? decay[i] : decay / (1 + i * 0.35);
      this.tone(out, { type, f0: f[i], t, peak: peak * am, a, d: dc });
    }
  }

  /** Register a function to run when this rig is disposed. */
  onDispose(fn: () => void): void {
    this.cleanups.push(fn);
  }

  /** Output stage for the sound: gain -> (stereo pan) -> the recipe's bus, plus a reverb send. */
  dest(o: { vol?: number; pan?: number; rev?: number; to?: unknown; revScale?: number } = {}): GainNode {
    const g = this.gain(o.vol == null ? 1 : o.vol);
    let n: AudioNode = g;
    if (o.pan && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = clamp(o.pan, -1, 1);
      this.nodes.push(p);
      g.connect(p);
      n = p;
    }
    n.connect(this.A.out);
    if (o.rev && o.rev > 0 && this.A.revIn) {
      const s = this.gain(o.rev);
      n.connect(s);
      s.connect(this.A.revIn);
    }
    return g;
  }

  /** Called by the owner after building: if nothing was scheduled there is nothing to wait for. */
  seal(): void {
    this.sealed = true;
    if (this.live <= 0) this.dispose();
  }

  /** Stop everything right now (used when synthesis threw half-way). */
  abort(): void {
    for (const s of this.srcs) {
      try { s.onended = null; s.stop(); } catch (e) { /* not started */ }
    }
    this.live = 0;
    this.dispose();
  }

  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    for (const fn of this.cleanups) {
      try { fn(); } catch (e) { /* ignore */ }
    }
    for (const n of this.nodes) {
      try { n.disconnect(); } catch (e) { /* ignore */ }
    }
    this.nodes.length = 0;
    this.srcs.length = 0;
    this.cleanups.length = 0;
  }
}
