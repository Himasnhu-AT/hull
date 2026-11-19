// Plan to Web Audio nodes. The only place that builds nodes for a recipe, shared by the live engine (AudioContext)
// and the bench (OfflineAudioContext), so a measured sound is the one that plays.
import { driveCurve, makeNoise, type NoiseKind } from './dsp.ts';
import type { PlanSource, PlanStage, SoundPlan } from './plan.ts';

/** Seconds of a shared noise buffer: long enough that its loop is not heard inside one short sound. */
const NOISE_SECONDS = 2;
// Fixed seed: the noise itself is the same every run, so a bench render is repeatable. Variation between plays comes
// from the plan's `offset` into the buffer.
const NOISE_SEED = 0x6e6f6973;
const SILENT = 0.0001;

const noiseCache = new WeakMap<BaseAudioContext, Map<NoiseKind, AudioBuffer>>();

export function noiseBufferFor(ctx: BaseAudioContext, kind: NoiseKind): AudioBuffer {
  let m = noiseCache.get(ctx);
  if (!m) { m = new Map(); noiseCache.set(ctx, m); }
  let buf = m.get(kind);
  if (!buf) {
    const data = makeNoise(kind, Math.floor(ctx.sampleRate * NOISE_SECONDS), NOISE_SEED);
    buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
    buf.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
    m.set(kind, buf);
  }
  return buf;
}

export interface BuiltSound {
  /** Context time at which the last voice ends. */
  end: number;
  /** Fade out quickly and release every node. */
  stop(): void;
}

export interface BuildOptions {
  /** Linear gain over the whole sound. */
  gain?: number;
  /** Where the reverb send goes, if the engine has a reverb. */
  reverbIn?: AudioNode | null;
  /** Per-play numbers handed to a `code` generator. */
  params?: Readonly<Record<string, number>>;
}

/** Build every voice of a plan, starting at context time `t0`, into `out`. */
export function buildPlan(ctx: BaseAudioContext, plan: SoundPlan, out: AudioNode, t0: number, opts: BuildOptions = {}): BuiltSound {
  const all: AudioNode[] = [];
  const sources: AudioScheduledSourceNode[] = [];
  let live = 0;
  const track = <T extends AudioNode>(n: T): T => { all.push(n); return n; };
  const release = (): void => { for (const n of all) { try { n.disconnect(); } catch { /* already gone */ } } };

  const mix = track(ctx.createGain());
  mix.gain.value = opts.gain ?? 1;
  mix.connect(out);
  if (plan.reverb > 0 && opts.reverbIn) {
    const send = track(ctx.createGain());
    send.gain.value = plan.reverb;
    mix.connect(send);
    send.connect(opts.reverbIn);
  }

  const start = (s: AudioScheduledSourceNode, at: number, stopAt: number, offset?: number): void => {
    live++;
    s.onended = () => { if (--live === 0) release(); };
    if (offset === undefined) s.start(at); else (s as AudioBufferSourceNode).start(at, offset);
    s.stop(stopAt);
    sources.push(s);
  };

  for (const v of plan.voices) {
    const t = t0 + v.at;
    const end = t + v.duration;
    const head = track(ctx.createGain());
    head.gain.value = v.falloff;
    let tail: AudioNode = head;
    const src = makeSource(ctx, v.source, plan.pitch, t, end, track, start);
    src.connect(head);
    for (const stage of v.stages) tail = addStage(ctx, stage, tail, t, end, track);
    tail.connect(mix);
  }

  return {
    end: t0 + plan.length,
    stop() {
      const now = ctx.currentTime;
      mix.gain.cancelScheduledValues(now);
      mix.gain.setTargetAtTime(0, now, 0.008);
      for (const s of sources) { try { s.stop(now + 0.06); } catch { /* not started */ } }
    },
  };
}

function makeSource(
  ctx: BaseAudioContext,
  s: PlanSource,
  pitch: number,
  t: number,
  end: number,
  track: <T extends AudioNode>(n: T) => T,
  start: (s: AudioScheduledSourceNode, at: number, stopAt: number, offset?: number) => void,
): AudioNode {
  const stopAt = end + 0.02;
  if (s.kind === 'osc') {
    const o = track(ctx.createOscillator());
    o.type = s.wave;
    const f0 = Math.min(ctx.sampleRate * 0.45, s.freq * pitch);
    o.frequency.setValueAtTime(f0, t);
    if (s.glideTo !== null) o.frequency.exponentialRampToValueAtTime(Math.max(1, f0 * s.glideTo), t + (s.glideTime > 0 ? s.glideTime : end - t));
    o.detune.value = s.detune;
    start(o, t, stopAt);
    return o;
  }
  if (s.kind === 'noise') {
    const b = track(ctx.createBufferSource());
    b.buffer = noiseBufferFor(ctx, s.noise);
    b.loop = true;
    b.playbackRate.value = pitch;
    start(b, t, stopAt, s.offset * (b.buffer.duration - 0.01));
    return b;
  }
  const sum = track(ctx.createGain());
  const amp = 1 / Math.sqrt(s.freqs.length);
  for (let i = 0; i < s.freqs.length; i++) {
    const o = track(ctx.createOscillator());
    o.frequency.value = Math.min(ctx.sampleRate * 0.45, s.freqs[i]! * pitch);
    const g = track(ctx.createGain());
    // The decay is the time to fall 60 dB, so every partial has the same shape and a different length.
    g.gain.setValueAtTime(amp, t);
    g.gain.exponentialRampToValueAtTime(0.001 * amp, t + s.decays[i]!);
    g.gain.setValueAtTime(0, t + s.decays[i]!);
    o.connect(g);
    g.connect(sum);
    start(o, t, Math.min(stopAt, t + s.decays[i]! + 0.02));
  }
  return sum;
}

function addStage(ctx: BaseAudioContext, st: PlanStage, input: AudioNode, t: number, end: number, track: <T extends AudioNode>(n: T) => T): AudioNode {
  switch (st.kind) {
    case 'filter': {
      const f = track(ctx.createBiquadFilter());
      f.type = st.type;
      const f0 = Math.min(ctx.sampleRate * 0.45, st.freq);
      f.frequency.setValueAtTime(f0, t);
      if (st.glideTo !== null) f.frequency.exponentialRampToValueAtTime(Math.max(10, Math.min(ctx.sampleRate * 0.45, f0 * st.glideTo)), t + (st.glideTime > 0 ? st.glideTime : end - t));
      f.Q.value = st.q;
      f.gain.value = st.gainDb;
      input.connect(f);
      return f;
    }
    case 'envelope': {
      const g = track(ctx.createGain());
      const p = g.gain;
      const top = t + st.attack + st.hold;
      p.setValueAtTime(st.attack > 0 ? 0 : 1, t);
      if (st.attack > 0) p.linearRampToValueAtTime(1, t + st.attack);
      if (st.hold > 0) p.setValueAtTime(1, top);
      if (st.curve === 'exp') p.exponentialRampToValueAtTime(SILENT, top + st.decay);
      else p.linearRampToValueAtTime(0, top + st.decay);
      p.setValueAtTime(0, top + st.decay);
      input.connect(g);
      return g;
    }
    case 'gain': {
      const g = track(ctx.createGain());
      g.gain.value = st.linear;
      input.connect(g);
      return g;
    }
    case 'drive': {
      const w = track(ctx.createWaveShaper());
      w.curve = driveCurve(st.amount) as Float32Array<ArrayBuffer>;
      w.oversample = '2x';
      input.connect(w);
      return w;
    }
    case 'delay': {
      const sum = track(ctx.createGain());
      const dry = track(ctx.createGain());
      dry.gain.value = 1 - st.mix;
      input.connect(dry);
      dry.connect(sum);
      const d = track(ctx.createDelay(Math.max(1, st.time)));
      d.delayTime.value = st.time;
      const fb = track(ctx.createGain());
      fb.gain.value = st.feedback;
      const wet = track(ctx.createGain());
      wet.gain.value = st.mix;
      input.connect(d);
      d.connect(fb);
      fb.connect(d);
      d.connect(wet);
      wet.connect(sum);
      return sum;
    }
    case 'pan': {
      if (typeof ctx.createStereoPanner !== 'function') return input;
      const p = track(ctx.createStereoPanner());
      p.pan.value = Math.max(-1, Math.min(1, st.pan));
      input.connect(p);
      return p;
    }
  }
}
