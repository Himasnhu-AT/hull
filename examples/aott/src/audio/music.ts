// Procedural battle score composed for AOTT: D minor, 150 BPM, driven by a lookahead scheduler.
// Layers fade in with intensity:
//   0.0  ambient   sustained choir pad + soft strings, long reverb
//   0.4  battle    16th-note string ostinato, taiko drums, sub bass
//   0.8+ climax    low brass stabs, choir pad ("aah" formants) singing a heroic theme, high strings, crash cymbals
// On top of the mode's intensity, `setAction` (0..1, the moment-to-moment heat of play) makes the score breathe: it
// leans the arrangement up or down a notch, rides the drums and the ostinato, adds a double-time shime pulse and
// lifts the tempo by up to 4 % (latched per bar, so every note of a bar shares one beat length).
import { Rig, clamp, smoothstep, mtof, impulseResponse, rand } from './dsp';
import type { Audio } from './audio';
import { every, stopEvery } from '../realtime';

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

export class Music {
  A: Audio;
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
  timer: number | null;
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

  constructor(A: Audio) {
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
    this.timer = null;
    this.cycle = 0;

    // hall reverb for the whole score
    this.rev = ctx.createConvolver();
    this.rev.buffer = impulseResponse(ctx, 3.4, { rt60: 3.1, pre: 0.02, bright: 0.6, dark: 0.12, slap: false, early: false, hp: 0.98 });
    this.revIn = ctx.createGain();
    this.revIn.gain.value = 1;
    this.revOut = ctx.createGain();
    this.revOut.gain.value = 0.75;
    this.revIn.connect(this.rev); this.rev.connect(this.revOut); this.revOut.connect(A.musicBus);

    // layer buses
    this.L = {} as Record<LayerName, GainNode>;
    this.vol = {} as Record<LayerName, number>;
    for (const name of LAYER_NAMES) {
      const [vol, send] = LAYERS[name];
      const g = ctx.createGain();
      g.gain.value = 0;
      const s = ctx.createGain();
      s.gain.value = send;
      g.connect(A.musicBus); g.connect(s); s.connect(this.revIn);
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
    this.netOut.connect(A.musicBus);
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

    this.setIntensity(A._pendingMusic || 0, true);
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

  start(): void {
    if (this.timer) return;
    this.timer = every(() => this.pump(), 25);
  }

  stop(): void {
    if (this.timer) stopEvery(this.timer);
    this.timer = null;
  }

  /** Lookahead scheduler: queue every 16th-note step that falls before `until` (default: now + 0.12 s). */
  pump(untilIn?: number): void {
    let until = untilIn;
    const ctx = this.ctx;
    const explicit = until !== undefined;
    if (until === undefined) {
      if (!this.A._running()) return;
      const now = ctx.currentTime;
      if (this.next === null || this.next < now - LOOKAHEAD * 2.5) this.next = now + 0.06; // first run, or fell far behind (stalled / throttled tab)
      until = now + LOOKAHEAD;
    } else if (this.next === null) this.next = 0.05;
    let guard = 0;
    while ((this.next as number) < (until as number) && (guard++ < 64 || explicit)) {
      this.scheduleStep(this.step, this.next as number);
      this.next = (this.next as number) + this.beat / 4;
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
