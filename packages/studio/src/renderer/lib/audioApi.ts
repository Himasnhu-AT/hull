// The sound bench's window onto hull/audio (renderSound, measureSound, playBuffer: team brief signatures).
// hull/audio is built by another worker. Until its module exists this file falls back to a small preview
// renderer so the bench still draws and plays something; `source` says which one is in use and the bench says so.

export interface Measure {
  duration: number;
  peakDb: number;
  loudnessDb: number;
  /** 512 min/max pairs. */
  waveform: Float32Array;
  /** 64 log bands, dB. */
  spectrum: Float32Array;
}

export interface AudioApi {
  /** 'project': the engine bundled with the game's own code generators (hull.json "generators"). */
  source: 'hull' | 'preview' | 'project';
  /** The project bundle's own config registry, which a `pick` source looks sounds up in. */
  config?: { load(sources: { path: string; text: string }[]): unknown; update(src: { path: string; text: string }): unknown; remove(path: string): unknown };
  renderSound(recipe: unknown, opts?: { seed?: number; sampleRate?: number }): Promise<AudioBuffer>;
  measureSound(buf: AudioBuffer): Measure;
  playBuffer(buf: AudioBuffer): void;
}

// A glob, not an import: it finds the module when it exists and is empty when it does not, in dev and in builds.
const found = import.meta.glob('../../../../hull/src/audio/index.ts');

let cached: Promise<AudioApi> | null = null;

export function loadAudio(): Promise<AudioApi> {
  cached ??= (async () => {
    const load = Object.values(found)[0];
    if (load) {
      const m = (await load()) as Partial<AudioApi>;
      if (m.renderSound && m.measureSound && m.playBuffer) return { source: 'hull', renderSound: m.renderSound, measureSound: m.measureSound, playBuffer: m.playBuffer };
    }
    return preview;
  })();
  return cached;
}

/**
 * The engine as the project's own code sees it: the project server bundles hull/audio together with the module named by
 * hull.json "generators", so a sound with a `code` source renders here as it does in the game. Resolves to null when the
 * project has no such module (the Studio's own hull/audio then does), and throws the server's message when it does not bundle.
 */
export async function loadProjectAudio(gameUrl: string): Promise<AudioApi | null> {
  const r = await fetch(new URL('__hull/bench/audio.js', gameUrl));
  if (r.status === 404) return null;
  const text = await r.text();
  if (!r.ok) throw new Error(text);
  // A blob, not an import of the server's URL: the bundle is self-contained, and this works from any page origin.
  const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
  try {
    const m = (await import(/* @vite-ignore */ url)) as Partial<AudioApi>;
    if (!m.renderSound || !m.measureSound || !m.playBuffer) throw new Error('the project bundle has no renderSound, measureSound and playBuffer');
    return { source: 'project', renderSound: m.renderSound, measureSound: m.measureSound, playBuffer: m.playBuffer, ...(m.config ? { config: m.config } : {}) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ---------- preview renderer (only until hull/audio lands) ---------- */

type R = Record<string, unknown>;
const isR = (v: unknown): v is R => typeof v === 'object' && v !== null && !Array.isArray(v);
const mid = (v: unknown, d: number): number => (typeof v === 'number' ? v : Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'number' ? (v[0] + v[1]) / 2 : d);
const dbToGain = (db: number): number => 10 ** (db / 20);

async function previewRender(recipe: unknown, opts: { seed?: number; sampleRate?: number } = {}): Promise<AudioBuffer> {
  const sr = opts.sampleRate ?? 44100;
  const r = isR(recipe) ? recipe : {};
  const src = isR(r['source']) ? r['source'] : {};
  const length = Math.min(8, Math.max(0.05, mid(src['length'], 0.5)));
  const ctx = new OfflineAudioContext(1, Math.ceil(sr * length), sr);
  const master = ctx.createGain();
  master.gain.value = dbToGain(mid(r['level'], 0));
  master.connect(ctx.destination);
  const layers = isR(src['layers']) ? Object.values(src['layers']) : [];
  for (const layer of layers) {
    if (!isR(layer)) continue;
    const from = isR(layer['from']) ? layer['from'] : {};
    let node: AudioNode;
    if (typeof from['osc'] === 'string') {
      const o = ctx.createOscillator();
      o.type = (['sine', 'square', 'sawtooth', 'triangle'] as const).find((t) => t === from['osc']) ?? 'sine';
      const f = mid(from['freq'], 440);
      o.frequency.setValueAtTime(f, 0);
      if (typeof from['glideTo'] === 'number') o.frequency.exponentialRampToValueAtTime(Math.max(20, f * from['glideTo']), Math.max(0.01, mid(from['glideTime'], 0.1)));
      o.start(0);
      node = o;
    } else {
      const b = ctx.createBuffer(1, ctx.length, sr);
      const d = b.getChannelData(0);
      let s = 0x9e3779b9 ^ (opts.seed ?? 1);
      for (let i = 0; i < d.length; i++) { s = (Math.imul(s, 1664525) + 1013904223) | 0; d[i] = (s / 2147483648) * 0.8; }
      const n = ctx.createBufferSource();
      n.buffer = b;
      n.start(0);
      node = n;
    }
    const steps = Array.isArray(layer['then']) ? layer['then'] : [];
    for (const step of steps) {
      if (!isR(step)) continue;
      if (typeof step['filter'] === 'string') {
        const bq = ctx.createBiquadFilter();
        bq.type = (['lowpass', 'highpass', 'bandpass', 'notch'] as const).find((t) => t === step['filter']) ?? 'lowpass';
        bq.frequency.value = mid(step['freq'], 1000);
        bq.Q.value = mid(step['q'], 1);
        node.connect(bq);
        node = bq;
      } else if (isR(step['envelope'])) {
        const e = step['envelope'];
        const g = ctx.createGain();
        const a = Math.max(0.0005, mid(e['attack'], 0.005));
        const dcy = Math.max(0.005, mid(e['decay'], 0.2));
        g.gain.setValueAtTime(0, 0);
        g.gain.linearRampToValueAtTime(1, a);
        g.gain.exponentialRampToValueAtTime(0.0005, a + dcy);
        node.connect(g);
        node = g;
      } else if (typeof step['gain'] === 'number') {
        const g = ctx.createGain();
        g.gain.value = dbToGain(step['gain']);
        node.connect(g);
        node = g;
      }
    }
    node.connect(master);
  }
  return ctx.startRendering();
}

/** In-place radix-2 FFT magnitude of a real signal. */
function fftMagnitudes(input: Float32Array, n: number): Float32Array {
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let i = 0; i < n; i++) re[i] = (input[i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const t = re[i]!; re[i] = re[j]!; re[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const c = Math.cos(ang * k), s = Math.sin(ang * k);
        const a = i + k, b = i + k + len / 2;
        const tr = re[b]! * c - im[b]! * s, ti = re[b]! * s + im[b]! * c;
        re[b] = re[a]! - tr; im[b] = im[a]! - ti; re[a] = re[a]! + tr; im[a] = im[a]! + ti;
      }
    }
  }
  const out = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) out[i] = Math.hypot(re[i]!, im[i]!) / (n / 4);
  return out;
}

function previewMeasure(buf: AudioBuffer): Measure {
  const d = buf.getChannelData(0);
  let peak = 0, sum = 0;
  for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]!); if (a > peak) peak = a; sum += d[i]! * d[i]!; }
  const waveform = new Float32Array(1024);
  const per = Math.max(1, Math.floor(d.length / 512));
  for (let i = 0; i < 512; i++) {
    let lo = 0, hi = 0;
    for (let j = i * per; j < Math.min(d.length, (i + 1) * per); j++) { const v = d[j]!; if (v < lo) lo = v; if (v > hi) hi = v; }
    waveform[i * 2] = lo; waveform[i * 2 + 1] = hi;
  }
  const N = 4096;
  const mags = fftMagnitudes(d.subarray(0, Math.min(N, d.length)), N);
  const spectrum = new Float32Array(64);
  const binHz = buf.sampleRate / N;
  for (let b = 0; b < 64; b++) {
    const f0 = 60 * (16000 / 60) ** (b / 64), f1 = 60 * (16000 / 60) ** ((b + 1) / 64);
    let m = 0;
    for (let k = Math.max(1, Math.floor(f0 / binHz)); k <= Math.min(N / 2 - 1, Math.max(Math.floor(f0 / binHz), Math.floor(f1 / binHz))); k++) m = Math.max(m, mags[k]!);
    spectrum[b] = 20 * Math.log10(m + 1e-6);
  }
  return { duration: buf.duration, peakDb: 20 * Math.log10(peak + 1e-9), loudnessDb: 10 * Math.log10(sum / Math.max(1, d.length) + 1e-12), waveform, spectrum };
}

let playCtx: AudioContext | null = null;
function previewPlay(buf: AudioBuffer): void {
  playCtx ??= new AudioContext();
  void playCtx.resume();
  const s = playCtx.createBufferSource();
  s.buffer = buf;
  s.connect(playCtx.destination);
  s.start();
}

const preview: AudioApi = { source: 'preview', renderSound: previewRender, measureSound: previewMeasure, playBuffer: previewPlay };

/** Centre of the spectrum in Hz (the bench's "brightness"), from the 64 log bands between 60 Hz and 16 kHz. */
export function spectralCentroid(spectrum: Float32Array): number {
  let num = 0, den = 0;
  for (let b = 0; b < spectrum.length; b++) {
    const w = 10 ** ((spectrum[b] ?? -120) / 20);
    num += w * 60 * (16000 / 60) ** ((b + 0.5) / spectrum.length);
    den += w;
  }
  return den > 0 ? num / den : 0;
}
