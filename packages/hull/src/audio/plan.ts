// Recipe to plan: a pure function from a `sound` value to a flat description of the node graph, with every range
// already drawn from a seeded stream. Nothing here touches Web Audio, so it runs in Node and the tests can read
// the plan. graph.ts turns a plan into real nodes. The same plan feeds the live engine and the offline bench,
// so what is measured is what plays.
import { RandomStream } from '../core/random.ts';
import type { Sound } from '../schema/sound.ts';

export type NumOrRange = number | readonly [number, number];
export type SynthSource = Extract<Sound['source'], { type: 'synth' }>;

export type PlanSource =
  | { kind: 'osc'; wave: 'sine' | 'triangle' | 'square' | 'sawtooth'; freq: number; glideTo: number | null; glideTime: number; detune: number }
  | { kind: 'noise'; noise: 'white' | 'pink' | 'brown'; /** Where in the shared noise buffer this layer starts, 0 to 1. */ offset: number }
  | { kind: 'modes'; freqs: number[]; decays: number[] };

export type PlanStage =
  | { kind: 'filter'; type: 'lowpass' | 'highpass' | 'bandpass' | 'notch' | 'peaking'; freq: number; q: number; glideTo: number | null; glideTime: number; gainDb: number }
  | { kind: 'envelope'; attack: number; hold: number; decay: number; curve: 'exp' | 'linear' }
  | { kind: 'gain'; linear: number }
  | { kind: 'drive'; amount: number }
  | { kind: 'delay'; time: number; feedback: number; mix: number }
  | { kind: 'pan'; pan: number };

export interface PlanVoice {
  layer: string;
  /** 0 for the first play of a layer, 1.. for repeats. */
  repeat: number;
  /** Seconds after the start of the sound. */
  at: number;
  /** Seconds the voice sounds for, counted from `at`. */
  duration: number;
  /** Linear gain from the repeat falloff (1 for the first). */
  falloff: number;
  source: PlanSource;
  stages: PlanStage[];
}

export interface SoundPlan {
  /** Seconds from the start to the end of the last voice, never less than the recipe's `length`. */
  length: number;
  /** Send level into the shared reverb, 0 to 1. */
  reverb: number;
  /** Speed multiplier for this play, from the recipe's pitch range. */
  pitch: number;
  voices: PlanVoice[];
}

export const dbToLinear = (db: number): number => Math.pow(10, db / 20);
export const linearToDb = (x: number): number => (x > 1e-9 ? 20 * Math.log10(x) : -180);

/** Fixed or [min, max]: a range is drawn from the stream, a number is returned as it is (and draws nothing). */
export function draw(v: NumOrRange, rng: RandomStream): number {
  return typeof v === 'number' ? v : rng.range(v[0], v[1]);
}

/** Pitch of one play: the recipe's pitch (a number or a range) times the caller's multiplier. */
export function drawPitch(sound: Sound, rng: RandomStream, extra = 1): number {
  return draw((sound.pitch ?? 1) as NumOrRange, rng) * extra;
}

const MIN_VOICE = 0.005;

function stagesOf(layer: SynthSource['layers'][string], rng: RandomStream): PlanStage[] {
  const out: PlanStage[] = [];
  for (const s of layer.then ?? []) {
    if ('filter' in s) {
      out.push({ kind: 'filter', type: s.filter, freq: draw(s.freq as NumOrRange, rng), q: draw((s.q ?? 0.7) as NumOrRange, rng), glideTo: s.glideTo ?? null, glideTime: s.glideTime ?? 0, gainDb: s.gain ?? 0 });
    } else if ('envelope' in s) {
      const e = s.envelope;
      out.push({ kind: 'envelope', attack: draw(e.attack as NumOrRange, rng), hold: draw((e.hold ?? 0) as NumOrRange, rng), decay: draw(e.decay as NumOrRange, rng), curve: e.curve ?? 'exp' });
    } else if ('gain' in s) {
      out.push({ kind: 'gain', linear: dbToLinear(draw(s.gain as NumOrRange, rng)) });
    } else if ('drive' in s) {
      out.push({ kind: 'drive', amount: draw(s.drive as NumOrRange, rng) });
    } else if ('delay' in s) {
      const d = s.delay;
      out.push({ kind: 'delay', time: draw(d.time as NumOrRange, rng), feedback: d.feedback ?? 0.3, mix: d.mix ?? 0.5 });
    } else {
      out.push({ kind: 'pan', pan: draw(s.pan as NumOrRange, rng) });
    }
  }
  return out;
}

/** How long a voice rings: to the end of its last envelope, or to the end of the sound if it has none. */
function durationOf(stages: readonly PlanStage[], source: PlanSource, room: number): number {
  let env = -1;
  for (const s of stages) if (s.kind === 'envelope') env = s.attack + s.hold + s.decay;
  let d = env >= 0 ? env : room;
  // A delay keeps sounding after its input ends.
  for (const s of stages) {
    if (s.kind === 'delay') d += s.time * (s.feedback < 0.05 ? 1 : Math.min(8, Math.ceil(Math.log(0.01) / Math.log(s.feedback))));
  }
  // The longest ring of a mode bank.
  if (source.kind === 'modes' && env < 0) d = Math.min(d, Math.max(...source.decays) * 4);
  return Math.max(MIN_VOICE, d);
}

/** Draw every range and lay the layers out in time. `seed` and the recipe fully decide the result. */
export function planSynth(sound: Sound, seed: number, extraPitch = 1): SoundPlan {
  if (sound.source.type !== 'synth') throw new Error(`planSynth: the source is a ${sound.source.type}, not a synth`);
  const src = sound.source;
  const rng = new RandomStream(seed, 'sound');
  const pitch = drawPitch(sound, rng, extraPitch);
  const voices: PlanVoice[] = [];
  let length = src.length;
  for (const name of Object.keys(src.layers)) {
    const layer = src.layers[name]!;
    const at0 = draw((layer.at ?? 0) as NumOrRange, rng);
    const reps = layer.repeat?.count ?? 1;
    let at = at0;
    for (let r = 0; r < reps; r++) {
      if (r > 0) at += draw(layer.repeat!.every as NumOrRange, rng);
      const from = layer.from;
      let source: PlanSource;
      if ('osc' in from) {
        source = { kind: 'osc', wave: from.osc, freq: draw(from.freq as NumOrRange, rng), glideTo: from.glideTo ?? null, glideTime: from.glideTime ?? 0, detune: draw((from.detune ?? 0) as NumOrRange, rng) };
      } else if ('noise' in from) {
        source = { kind: 'noise', noise: from.noise, offset: rng.next() };
      } else {
        const freqs = from.modes.map((m) => draw(m as NumOrRange, rng));
        const base = draw(from.decay as NumOrRange, rng);
        const tilt = from.tilt ?? 0;
        source = { kind: 'modes', freqs, decays: freqs.map((_, i) => base / (1 + tilt * i)) };
      }
      const stages = stagesOf(layer, rng);
      const room = Math.max(MIN_VOICE, src.length - at);
      const duration = durationOf(stages, source, room);
      const fall = layer.repeat?.falloff ?? 0;
      voices.push({ layer: name, repeat: r, at, duration, falloff: dbToLinear(-fall * r), source, stages });
      length = Math.max(length, at + duration);
    }
  }
  return { length, reverb: src.reverb ?? 0, pitch, voices };
}
