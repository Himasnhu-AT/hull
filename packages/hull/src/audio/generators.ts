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
}
/** Build nodes into `out` and return how long the sound lasts, in seconds. */
export type Generator = (call: GeneratorCall) => number;

const generators = new Map<string, Generator>();

export function registerGenerator(name: string, fn: Generator): void {
  generators.set(name, fn);
}
export const hasGenerator = (name: string): boolean => generators.has(name);

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
    if (!gen) throw new Error(`sound#/source/generator: no generator named "${src.generator}" is registered (registerGenerator)`);
    const gain = ctx.createGain();
    gain.gain.value = opts.gain ?? 1;
    gain.connect(out);
    const rng = new RandomStream(seed, 'sound');
    const length = gen({ ctx, out: gain, t0, rng, knobs: src.knobs ?? {}, pitch: drawPitch(sound, rng, pitch) });
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
