// Measurements for the sound bench. Pure maths over sample arrays (the Web Audio wrapper is at the bottom), so
// Node tests can check them on synthetic buffers.
import { fft } from './fft.ts';
import { linearToDb } from './plan.ts';

export const WAVEFORM_PAIRS = 512;
export const SPECTRUM_BANDS = 64;
const FFT_SIZE = 4096;
const FIRST_HZ = 20;
const LAST_HZ = 20000;
const FLOOR_DB = -120;

export interface Measurement {
  /** Seconds. */
  duration: number;
  /** Highest absolute sample over all channels, dBFS. */
  peakDb: number;
  /** Loudness in the manner of LUFS: K-weighted mean square over the whole buffer, no gating (these sounds are
   *  short), so values are comparable between sounds but not to a broadcast meter. */
  loudnessDb: number;
  /** Plain RMS over the whole buffer, dBFS. */
  rmsDb: number;
  /** min, max, min, max... : 512 pairs of the mono mix, evenly over the buffer. */
  waveform: Float32Array;
  /** 64 bands from 20 Hz to 20 kHz (or just below Nyquist), evenly spaced in log frequency; dB of the average
   *  power in each band, where a full-scale sine reads -3 dB. */
  spectrum: Float32Array;
}

/** Edges of the log bands, `SPECTRUM_BANDS + 1` values in Hz. */
export function bandEdges(sampleRate: number): Float64Array {
  const top = Math.min(LAST_HZ, sampleRate * 0.49);
  const edges = new Float64Array(SPECTRUM_BANDS + 1);
  for (let i = 0; i <= SPECTRUM_BANDS; i++) edges[i] = FIRST_HZ * Math.pow(top / FIRST_HZ, i / SPECTRUM_BANDS);
  return edges;
}

interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }

/** The two K-weighting filters of ITU-R BS.1770 (a high shelf, then a high-pass), designed for any sample rate. */
export function kWeighting(sampleRate: number): [Biquad, Biquad] {
  const shelfF = 1681.974450955533;
  const shelfG = 3.999843853973347;
  const shelfQ = 0.7071752369554196;
  let k = Math.tan((Math.PI * shelfF) / sampleRate);
  const vh = Math.pow(10, shelfG / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  let a0 = 1 + k / shelfQ + k * k;
  const shelf: Biquad = {
    b0: (vh + (vb * k) / shelfQ + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / shelfQ + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / shelfQ + k * k) / a0,
  };
  const hpF = 38.13547087602444;
  const hpQ = 0.5003270373238773;
  k = Math.tan((Math.PI * hpF) / sampleRate);
  a0 = 1 + k / hpQ + k * k;
  const hp: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (k * k - 1)) / a0, a2: (1 - k / hpQ + k * k) / a0 };
  return [shelf, hp];
}

function meanSquareK(x: Float32Array, sampleRate: number): number {
  const [s1, s2] = kWeighting(sampleRate);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0; // stage 1 state
  let u1 = 0, u2 = 0, v1 = 0, v2 = 0; // stage 2 state
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i]!;
    const y = s1.b0 * v + s1.b1 * x1 + s1.b2 * x2 - s1.a1 * y1 - s1.a2 * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = y;
    const z = s2.b0 * y + s2.b1 * u1 + s2.b2 * u2 - s2.a1 * v1 - s2.a2 * v2;
    u2 = u1; u1 = y; v2 = v1; v1 = z;
    sum += z * z;
  }
  return x.length ? sum / x.length : 0;
}

/** Waveform summary: `pairs` buckets of (min, max) over the mono mix. */
export function waveformOf(mono: Float32Array, pairs = WAVEFORM_PAIRS): Float32Array {
  const out = new Float32Array(pairs * 2);
  const n = mono.length;
  if (n === 0) return out;
  for (let p = 0; p < pairs; p++) {
    let a = Math.floor((p * n) / pairs);
    let b = Math.floor(((p + 1) * n) / pairs);
    if (b <= a) { a = Math.min(a, n - 1); b = a + 1; }
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = a; i < b; i++) {
      const v = mono[i]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    out[p * 2] = lo;
    out[p * 2 + 1] = hi;
  }
  return out;
}

/** Long-term spectrum: Hann-windowed frames of 4096 samples at half overlap, averaged in power, summed into log bands. */
export function spectrumOf(mono: Float32Array, sampleRate: number): Float32Array {
  const N = FFT_SIZE;
  const win = new Float64Array(N);
  let sw = 0;
  let sw2 = 0;
  for (let i = 0; i < N; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    sw += win[i]!;
    sw2 += win[i]! * win[i]!;
  }
  // Equivalent noise bandwidth in bins: dividing by it makes the summed bins of a sine add up to its true power.
  const enbw = (N * sw2) / (sw * sw);
  const frames = Math.max(1, Math.ceil(Math.max(0, mono.length - N / 2) / (N / 2)));
  const power = new Float64Array(N / 2 + 1);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let f = 0; f < frames; f++) {
    const start = f * (N / 2);
    for (let i = 0; i < N; i++) {
      const j = start + i;
      re[i] = j < mono.length ? mono[j]! * win[i]! : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k <= N / 2; k++) {
      const amp = (2 * Math.hypot(re[k]!, im[k]!)) / sw;
      power[k] = power[k]! + (amp * amp) / 2;
    }
  }
  const edges = bandEdges(sampleRate);
  const bands = new Float64Array(SPECTRUM_BANDS);
  const binHz = sampleRate / N;
  for (let k = 1; k <= N / 2; k++) {
    const hz = k * binHz;
    if (hz < edges[0]! || hz >= edges[SPECTRUM_BANDS]!) continue;
    // Binary search would be overkill for 2048 bins and 64 bands.
    let b = 0;
    while (b < SPECTRUM_BANDS - 1 && hz >= edges[b + 1]!) b++;
    bands[b] = bands[b]! + power[k]! / frames / enbw;
  }
  const out = new Float32Array(SPECTRUM_BANDS);
  for (let b = 0; b < SPECTRUM_BANDS; b++) out[b] = Math.max(FLOOR_DB, bands[b]! > 0 ? 10 * Math.log10(bands[b]!) : FLOOR_DB);
  return out;
}

/** Everything the bench shows, from raw channels. */
export function measureChannels(channels: readonly Float32Array[], sampleRate: number): Measurement {
  const n = channels[0]?.length ?? 0;
  const mono = new Float32Array(n);
  let peak = 0;
  let sq = 0;
  let k = 0;
  for (const ch of channels) {
    for (let i = 0; i < n; i++) {
      const v = ch[i]!;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sq += v * v;
      mono[i] = mono[i]! + v / channels.length;
    }
    k += meanSquareK(ch, sampleRate);
  }
  const rms = n && channels.length ? Math.sqrt(sq / (n * channels.length)) : 0;
  return {
    duration: sampleRate ? n / sampleRate : 0,
    peakDb: linearToDb(peak),
    loudnessDb: k > 0 ? -0.691 + 10 * Math.log10(k) : -180,
    rmsDb: linearToDb(rms),
    waveform: waveformOf(mono),
    spectrum: spectrumOf(mono, sampleRate),
  };
}

/** The bench call: measure a rendered AudioBuffer. */
export function measureSound(buf: AudioBuffer): Measurement {
  const chans: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  return measureChannels(chans, buf.sampleRate);
}
