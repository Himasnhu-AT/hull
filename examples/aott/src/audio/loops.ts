// Continuous sound loops, created once in Audio.init(): winch (reel), gas jet, wind, boot scrape and the heartbeat.
// All parameter changes are smoothed with setTargetAtTime so per-frame updates never click.
import { clamp, lerp, smoothstep } from './dsp';
import type { NoiseKind } from './dsp';
import type { Audio } from './audio';
import { R } from '../sim';

/**
 * Looping noise source. `rate` < 1 plays the buffer slowly: brown noise at 0.01..0.2 is a full-level random LFO
 * (its ~150 Hz corner drops to 1.5..30 Hz), which is what the gusts, the buffeting and the scrape chatter run on.
 */
function loopNoise(A: Audio, kind: NoiseKind, rate = 1): AudioBufferSourceNode {
  const s = (A.ctx as BaseAudioContext).createBufferSource();
  const buf = A.noise[kind];
  s.buffer = buf;
  s.loop = true;
  s.playbackRate.value = rate;
  s.start(0, R.fx() * (buf.duration - 0.05));
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

// ─────────────────────────────────────────────────────────────────────────────

export class ReelLoop {
  ctx: BaseAudioContext;
  level: number;
  out: GainNode;
  s1: OscillatorNode; s2: OscillatorNode; s3: OscillatorNode;
  lp: BiquadFilterNode;
  motorGain: GainNode;
  whine: OscillatorNode; whine2: OscillatorNode; wob: OscillatorNode; whineGain: GainNode;
  tickOsc: OscillatorNode; tickGain: GainNode; tickNoise: AudioBufferSourceNode; tickBp: BiquadFilterNode; tickTone: OscillatorNode; tickLevel: GainNode;

  constructor(A: Audio) {
    const ctx = A.ctx as BaseAudioContext;
    this.ctx = ctx;
    this.level = 0;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(A.sfx);

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

/** The valve opening: a thump and a chuff under the first instant of a gas burst (the loop alone is all hiss). */
function gasKick(A: Audio, level: number): void {
  const r = A._rig('gasKick', 2); if (!r) return;
  const t = (A.ctx as BaseAudioContext).currentTime + 0.002;
  const o = A._dest(r, { vol: 0.45 + 0.4 * level, rev: 0.08 });
  // kept in the mids: a sub thump here would only make the compressor swallow the hiss it is meant to launch
  r.tone(o, { f0: 190, f1: 70, glide: 0.05, t, peak: 0.32, a: 0.002, d: 0.07 });
  r.burst(o, { kind: 'pink', t, peak: 1.2, a: 0.002, d: 0.06, type: 'bandpass', f0: 700, q: 0.8 });
  r.burst(o, { t, peak: 1.3, a: 0.001, d: 0.05, type: 'bandpass', f0: 2400, f1: 5200, sweep: 0.04, q: 1.2 });
}

export class GasLoop {
  A: Audio;
  ctx: BaseAudioContext;
  level: number;
  out: GainNode;
  flut: GainNode;
  lfo: OscillatorNode;
  bp: BiquadFilterNode;
  edge: BiquadFilterNode;

  constructor(A: Audio) {
    const ctx = A.ctx as BaseAudioContext;
    this.A = A;
    this.ctx = ctx;
    this.level = 0;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(A.sfx);
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
      this.A._run(gasKick, level);
    } else {
      this.out.gain.setTargetAtTime(g, t, on ? 0.01 : 0.04); // attack ~30 ms, release ~120 ms
    }
    this.bp.frequency.setTargetAtTime(2500 + 2400 * level, t, 0.05);
    this.edge.frequency.setTargetAtTime(6200 + 1600 * level, t, 0.05);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export class WindLoop {
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

  constructor(A: Audio) {
    const ctx = A.ctx as BaseAudioContext;
    this.ctx = ctx;
    this.speed = 0;
    this.out = ctx.createGain();
    this.out.gain.value = 0.3;
    this.out.connect(A.sfx);
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
export class ScrapeLoop {
  ctx: BaseAudioContext;
  level: number;
  out: GainNode;
  bp: BiquadFilterNode;
  gritBp: BiquadFilterNode;
  chatter: AudioBufferSourceNode;

  constructor(A: Audio) {
    const ctx = A.ctx as BaseAudioContext;
    this.ctx = ctx;
    this.level = 0;
    this.out = gainNode(ctx, 0);
    this.out.connect(A.sfx);
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

/** One lub-dub at `when`: sub thumps with a harmonic on top so the pulse still reads on small speakers. */
function heartThump(A: Audio, when: number, level: number): void {
  const r = A._rig('heart', 4); if (!r) return;
  const o = A._dest(r, { vol: 0.15 + 0.25 * level, to: A.sfxTop });
  const dub = when + lerp(0.2, 0.14, level);
  r.tone(o, { f0: 68, f1: 40, glide: 0.07, t: when, peak: 0.6, a: 0.008, d: 0.13 });
  r.tone(o, { type: 'triangle', f0: 136, f1: 82, glide: 0.06, t: when, peak: 0.4, a: 0.006, d: 0.07 });
  r.burst(o, { kind: 'pink', t: when, peak: 1.5, a: 0.005, d: 0.05, type: 'bandpass', f0: 280, q: 1 });
  r.burst(o, { kind: 'brown', t: when, peak: 0.5, a: 0.006, d: 0.08, type: 'lowpass', f0: 180, q: 0.7 });
  r.tone(o, { f0: 84, f1: 50, glide: 0.06, t: dub, peak: 0.4, a: 0.006, d: 0.1 });
  r.tone(o, { type: 'triangle', f0: 168, f1: 100, glide: 0.05, t: dub, peak: 0.28, a: 0.005, d: 0.055 });
  r.burst(o, { kind: 'pink', t: dub, peak: 1.0, a: 0.004, d: 0.04, type: 'bandpass', f0: 340, q: 1 });
}

/**
 * Low-HP / danger state, fed 0..1 every frame: a lub-dub pulse scheduled just ahead of the audio clock (70 bpm at
 * the threshold, 140 at level 1) and a low-pass closing over the world's SFX bus (wide open at 0, ~3 kHz at 1).
 * If the caller stops calling while the level is up, the pulse stops and the filter reopens by itself.
 */
export class Heartbeat {
  A: Audio;
  ctx: BaseAudioContext;
  level: number;
  next: number;
  applied: number;
  lastSched: number;

  constructor(A: Audio) {
    this.A = A;
    this.ctx = A.ctx as BaseAudioContext;
    this.level = 0;
    this.next = 0;
    this.applied = 0;
    this.lastSched = -9;
  }

  set(levelIn: number): void {
    const level = clamp(Number.isFinite(levelIn) ? levelIn : 0, 0, 1);
    const t = this.ctx.currentTime;
    const on = level > 0.02;
    if (on ? Math.abs(level - this.applied) > 0.01 || t - this.lastSched > 0.25 : this.applied > 0) {
      const nyq = this.ctx.sampleRate / 2;
      const f = this.A.sfxLp.frequency;
      f.cancelScheduledValues(t);
      f.setTargetAtTime(on ? nyq * Math.pow(3000 / nyq, Math.pow(level, 0.8)) : nyq, t, on ? 0.25 : 0.15);
      if (on) f.setTargetAtTime(nyq, t + 1.5, 0.4); // failsafe, pushed back by every call
      this.applied = on ? level : 0;
      this.lastSched = t;
    }
    this.level = level;
    if (!on) { this.next = 0; return; }
    const period = 60 / lerp(70, 140, level);
    if (this.next < t - 0.05) this.next = t + 0.03; // first beat, or the caller stalled
    while (this.next < t + 0.12) {
      this.A._run(heartThump, this.next, level);
      this.next += period;
    }
  }
}
