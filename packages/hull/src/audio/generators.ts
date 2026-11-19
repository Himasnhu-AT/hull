// `code` sources: a sound whose graph is made by a function a game registers (for things a recipe cannot say, such
// as an engine tone that follows game state). The recipe only names the generator and carries its knobs.
import { RandomStream } from '../core/random.ts';
import type { Random } from '../core/types.ts';
import { buildPlan, type BuildOptions, type BuiltSound } from './graph.ts';
import { drawPitch, planSynth } from './plan.ts';
import type { Sound } from '../schema/sound.ts';

export interface GeneratorCall {
  ctx: BaseAudioContext;
  out: AudioNode;
  /** Context time to start at. */
  t0: number;
  /** Seeded: use this, never Math.random, so a bench render is repeatable. */
  rng: Random;
  knobs: Readonly<Record<string, unknown>>;
  pitch: number;
  /** Per-play numbers the caller gave to `play(id, { params })` (a strength, a size). Empty on the bench. */
  params: Readonly<Record<string, number>>;
  /** The shared reverb's input, or null (the bench has none): send a copy of the sound here for room. */
  reverbIn: AudioNode | null;
}
/** Build nodes into `out` and return how long the sound lasts, in seconds. */
export type Generator = (call: GeneratorCall) => number;

const generators = new Map<string, Generator>();

/**
 * A sound that never ends on its own and follows game state: an engine tone, a wind bed, a score. The engine builds it
 * once, calls `tick(now)` every frame with the context time, hands `set` the caller's numbers, and calls `stop` at the end.
 * On the bench, `tick` is stepped over the render length so a scheduler-driven voice fills the buffer.
 */
export interface LiveVoice {
  set?(params: Readonly<Record<string, number>>): void;
  tick?(now: number): void;
  stop(): void;
  /** Anything else the game reads back (the score's current chord). */
  [k: string]: unknown;
}
export type LiveGenerator = (call: GeneratorCall) => LiveVoice;
const liveGenerators = new Map<string, LiveGenerator>();
export function registerLiveGenerator(name: string, fn: LiveGenerator): void {
  liveGenerators.set(name, fn);
}
export const hasLiveGenerator = (name: string): boolean => liveGenerators.has(name);
export const getLiveGenerator = (name: string): LiveGenerator | undefined => liveGenerators.get(name);

export function registerGenerator(name: string, fn: Generator): void {
  generators.set(name, fn);
}
export const hasGenerator = (name: string): boolean => generators.has(name) || liveGenerators.has(name);

export interface Built extends BuiltSound {
  /** Seconds the sound lasts. */
  length: number;
}

/** Build one play of a synth or code sound. Throws, naming the place, if it cannot. */
export function buildSound(ctx: BaseAudioContext, sound: Sound, seed: number, t0: number, out: AudioNode, pitch = 1, opts: BuildOptions = {}): Built {
  const src = sound.source;
  if (src.type === 'synth') {
    const plan = planSynth(sound, seed, pitch);
    const b = buildPlan(ctx, plan, out, t0, opts);
    return { ...b, length: plan.length };
  }
  if (src.type === 'code') {
    const gen = generators.get(src.generator);
    if (!gen && liveGenerators.has(src.generator)) throw new Error(`sound#/source/generator: "${src.generator}" is a live generator; it plays as a continuous voice, not a one-shot`);
    if (!gen) throw new Error(`sound#/source/generator: no generator named "${src.generator}" is registered (registerGenerator)`);
    const gain = ctx.createGain();
    gain.gain.value = opts.gain ?? 1;
    gain.connect(out);
    const rng = new RandomStream(seed, 'sound');
    const length = gen({ ctx, out: gain, t0, rng, knobs: src.knobs ?? {}, pitch: drawPitch(sound, rng, pitch), params: opts.params ?? {}, reverbIn: opts.reverbIn ?? null });
    return {
      end: t0 + length,
      length,
      stop() {
        const now = ctx.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setTargetAtTime(0, now, 0.008);
      },
    };
  }
  throw new Error(`sound#/source/type: a ${src.type} source cannot be built directly`);
}
