// Pure signal helpers: seeded noise, impulse responses, the soft-clip curve. No Web Audio here, so Node tests can
// check them and the bench can reuse them.
import { RandomStream } from '../core/random.ts';

export type NoiseKind = 'white' | 'pink' | 'brown';

/**
 * Mono noise of `length` samples, scaled to an RMS of about 0.3 so a noise layer and an oscillator layer at the
 * same gain sit at a similar loudness. Seeded, so the bench renders the same noise every time. The end is
 * crossfaded into the start so the buffer can loop without a click.
 */
export function makeNoise(kind: NoiseKind, length: number, seed: number): Float32Array {
  const fade = Math.min(2048, length >> 2);
  const rng = new RandomStream(seed, `noise:${kind}`);
  const tmp = new Float32Array(length + fade);
  if (kind === 'pink') {
    // Paul Kellet's filter: cheap and flat enough to within about a dB from 10 Hz up.
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < tmp.length; i++) {
      const w = rng.next() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      tmp[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    }
  } else if (kind === 'brown') {
    let l = 0;
    for (let i = 0; i < tmp.length; i++) {
      l = (l + 0.02 * (rng.next() * 2 - 1)) / 1.02;
      tmp[i] = l;
    }
  } else {
    for (let i = 0; i < tmp.length; i++) tmp[i] = rng.next() * 2 - 1;
  }
  let sum = 0;
  for (let i = 0; i < tmp.length; i++) sum += tmp[i]! * tmp[i]!;
  const g = 0.3 / Math.sqrt(sum / tmp.length || 1);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = tmp[i]! * g;
  // The stream continues past the end into the start: blend the first `fade` samples from that continuation.
  for (let i = 0; i < fade; i++) {
    const w = i / fade;
    out[i] = (tmp[length + i]! * Math.cos(w * Math.PI * 0.5) + tmp[i]! * Math.sin(w * Math.PI * 0.5)) * g;
  }
  return out;
}

/** Stereo reverb impulse: noise that fades with a slowly closing low-pass, so highs die before lows. */
export function makeImpulse(sampleRate: number, seconds: number, seed: number): [Float32Array, Float32Array] {
  const n = Math.floor(sampleRate * seconds);
  const k = 6.908 / seconds; // 60 dB down at the end
  const out: [Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n)];
  for (let ch = 0; ch < 2; ch++) {
    const rng = new RandomStream(seed, `ir:${ch}`);
    const d = out[ch]!;
    let y = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      const bright = 0.85 - 0.65 * Math.min(1, t / (seconds * 0.8));
      y += bright * ((rng.next() * 2 - 1) - y);
      d[i] = y * Math.exp(-t * k) * Math.min(1, t / 0.01);
    }
  }
  return out;
}

/** Soft-clip curve for the drive shaper. amount 0 is nearly clean, 1 is heavy. */
export function driveCurve(amount: number, size = 1024): Float32Array {
  const k = 1 + amount * 24;
  const curve = new Float32Array(size);
  const norm = Math.tanh(k);
  for (let i = 0; i < size; i++) curve[i] = Math.tanh(k * ((i / (size - 1)) * 2 - 1)) / norm;
  return curve;
}
