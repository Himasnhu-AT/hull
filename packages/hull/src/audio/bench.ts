// The sound bench: render a recipe offline, measure it, listen to the buffer. The graph is the one the live engine
// builds (graph.ts), so what is measured is what plays. The bench leaves out the bus, the reverb return and the
// master limiter: it shows the sound itself, at its own `level`.
import { config } from '../config/index.ts';
import { validateAgainst } from '../config/validate.ts';
import { RandomStream } from '../core/random.ts';
import { soundSchema, type Sound } from '../schema/sound.ts';
import { makeImpulse } from './dsp.ts';
import { buildSound } from './generators.ts';
import { dbToLinear, planSynth } from './plan.ts';

export { measureSound } from './measure.ts';
export type { Measurement } from './measure.ts';

export interface RenderOptions {
  /** Seeds every range and the noise start. Same seed, same samples. Default 1. */
  seed?: number;
  /** Default 44100. */
  sampleRate?: number;
  /** Seconds to render for a `code` source, which does not say how long it is. Default 3. */
  length?: number;
}

const REVERB_SECONDS = 1.4;

/** Throws an Error whose message names `sound#/pointer` for the first thing wrong with a recipe. */
export function checkSound(recipe: unknown, where = 'sound'): Sound {
  const problems = validateAgainst(soundSchema, recipe);
  if (problems.length) throw new Error(problems.map((p) => `${where}#${p.pointer}: ${p.message}`).join('\n'));
  return recipe as Sound;
}

export async function renderSound(recipe: unknown, opts: RenderOptions = {}): Promise<AudioBuffer> {
  const sound = checkSound(recipe);
  const seed = opts.seed ?? 1;
  const sampleRate = opts.sampleRate ?? 44100;
  return renderChecked(sound, seed, sampleRate, opts.length ?? 3, 0);
}

async function renderChecked(sound: Sound, seed: number, sampleRate: number, codeLength: number, depth: number): Promise<AudioBuffer> {
  const src = sound.source;
  if (src.type === 'pick') {
    if (depth > 4) throw new Error('sound#/source/from: picks nest more than 4 deep');
    const id = new RandomStream(seed, 'pick').pick(src.from);
    const rel = id.replace(/^sound\//, '');
    let child: Sound;
    try { child = checkSound(config.lookup('sound', rel), id); } catch (e) { throw new Error(`sound#/source/from: ${(e as Error).message}`); }
    return renderChecked(child, seed, sampleRate, codeLength, depth + 1);
  }
  if (src.type === 'sample') throw new Error('sound#/source/type: sample sources are not built yet');
  const seconds = src.type === 'synth' ? planSynth(sound, seed).length + ((src.reverb ?? 0) > 0 ? REVERB_SECONDS * 0.6 : 0) + 0.02 : codeLength;
  const frames = Math.max(1, Math.ceil(seconds * sampleRate));
  const ctx = new OfflineAudioContext(2, frames, sampleRate);
  let reverbIn: AudioNode | null = null;
  if (src.type === 'synth' && (src.reverb ?? 0) > 0) {
    const [l, r] = makeImpulse(sampleRate, REVERB_SECONDS, 0x7265);
    const conv = ctx.createConvolver();
    const buf = ctx.createBuffer(2, l.length, sampleRate);
    buf.copyToChannel(l as Float32Array<ArrayBuffer>, 0);
    buf.copyToChannel(r as Float32Array<ArrayBuffer>, 1);
    conv.buffer = buf;
    conv.connect(ctx.destination);
    reverbIn = conv;
  }
  buildSound(ctx, sound, seed, 0, ctx.destination, 1, { gain: dbToLinear(sound.level ?? 0), reverbIn });
  return ctx.startRendering();
}

let previewCtx: AudioContext | null = null;

/** Bench preview: play a buffer once on a shared context. Returns a function that stops it. */
export function playBuffer(buf: AudioBuffer): () => void {
  try {
    previewCtx ??= new AudioContext();
    const ctx = previewCtx;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
    return () => { try { src.stop(); } catch { /* already ended */ } };
  } catch (e) {
    console.warn(`[hull audio] playBuffer: ${(e as Error).message}`);
    return () => {};
  }
}
