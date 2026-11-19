import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateAgainst } from '../config/validate.ts';
import { mixerSchema, soundSchema, type Sound } from '../schema/index.ts';
import { config } from '../config/index.ts';
import { makeImpulse, makeNoise } from './dsp.ts';
import { mountAudio } from './engine.ts';
import { defineGame, startGame } from '../core/index.ts';
import { fft } from './fft.ts';
import { bandEdges, measureChannels, SPECTRUM_BANDS, WAVEFORM_PAIRS } from './measure.ts';
import { defaultMixer, planMixer } from './mixer-plan.ts';
import { planSynth } from './plan.ts';
import { airCutoff, distanceGain, panFor } from './spatial.ts';

const dir = join(import.meta.dirname, 'examples');
const examples = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
const load = (name: string): Sound => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Sound;

describe('example recipes', () => {
  it('has the six the templates will copy', () => {
    expect(examples).toEqual(['explosion.json', 'footstep.json', 'hit.json', 'thud.json', 'ui-click.json', 'whoosh.json']);
  });
  for (const f of examples) {
    it(`${f} is a valid sound`, () => {
      expect(validateAgainst(soundSchema, load(f))).toEqual([]);
    });
  }
});

describe('sound schema', () => {
  const base = { kind: 'sound', source: { type: 'synth', length: 0.2, layers: { a: { from: { noise: 'white' } } } } };
  it('accepts a minimal sound', () => {
    expect(validateAgainst(soundSchema, base)).toEqual([]);
  });
  it('names the place of a bad value', () => {
    const bad = structuredClone(base) as Record<string, unknown>;
    (bad['source'] as { layers: { a: { from: unknown } } }).layers.a.from = { osc: 'sine', freq: [100, 5] };
    (bad as { level?: number }).level = 40;
    const problems = validateAgainst(soundSchema, bad);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.pointer === '/level')).toBe(true);
  });
  it('rejects an unknown field and an unknown source type', () => {
    expect(validateAgainst(soundSchema, { ...base, volume: 1 }).length).toBeGreaterThan(0);
    expect(validateAgainst(soundSchema, { kind: 'sound', source: { type: 'magic' } }).length).toBeGreaterThan(0);
  });
  it('carries x-ui hints the Inspector uses', () => {
    const p = (soundSchema as unknown as { properties: Record<string, { 'x-ui'?: Record<string, unknown> }> }).properties;
    expect(p['level']!['x-ui']).toMatchObject({ widget: 'slider', unit: 'dB', group: 'Mix' });
    expect(p['pitch']!['x-ui']).toMatchObject({ widget: 'range', min: 0.25, max: 4 });
  });
});

describe('mixer schema and plan', () => {
  it('accepts the default mixer and plans it feeders first', () => {
    expect(validateAgainst(mixerSchema, defaultMixer)).toEqual([]);
    const plan = planMixer(undefined);
    expect(plan.problems).toEqual([]);
    expect(plan.buses[plan.buses.length - 1]!.name).toBe('master');
    expect(plan.buses.find((b) => b.name === 'ui')).toEqual({ name: 'ui', to: 'master', levelDb: -4 });
  });
  it('orders nested buses and reports a loop and an unknown target', () => {
    const plan = planMixer({ kind: 'mixer', buses: { a: { to: 'b' }, b: { to: 'a' }, c: { to: 'nowhere' }, d: { to: 'e', level: -3 }, e: {} } }, 'mixer/main');
    expect(plan.problems.some((p) => p.includes('loop'))).toBe(true);
    expect(plan.problems.some((p) => p.includes('mixer/main#/buses/c/to'))).toBe(true);
    const names = plan.buses.map((b) => b.name);
    expect(names.indexOf('d')).toBeLessThan(names.indexOf('e'));
    expect(names[names.length - 1]).toBe('master');
    for (const b of plan.buses) if (b.name !== 'master') expect(b.to).not.toBeNull();
  });
});

describe('planSynth', () => {
  it('is the same for the same seed and differs for another', () => {
    const s = load('hit.json');
    expect(planSynth(s, 5)).toEqual(planSynth(s, 5));
    expect(planSynth(s, 5)).not.toEqual(planSynth(s, 6));
  });
  it('draws ranges inside their bounds, over many seeds', () => {
    const s = load('hit.json');
    for (let seed = 0; seed < 200; seed++) {
      const p = planSynth(s, seed);
      expect(p.pitch).toBeGreaterThanOrEqual(0.95);
      expect(p.pitch).toBeLessThanOrEqual(1.05);
      const ring = p.voices.find((v) => v.layer === 'ring')!;
      expect(ring.source.kind === 'osc' && ring.source.freq).toBeGreaterThanOrEqual(1800);
      expect(ring.source.kind === 'osc' && ring.source.freq).toBeLessThanOrEqual(2300);
    }
  });
  it('spreads draws across the range', () => {
    const s = load('footstep.json');
    const pitches = Array.from({ length: 300 }, (_, i) => planSynth(s, i).pitch);
    expect(Math.min(...pitches)).toBeLessThan(0.92);
    expect(Math.max(...pitches)).toBeGreaterThan(1.08);
  });
  it('turns the hit recipe into three voices with resolved stages', () => {
    const p = planSynth(load('hit.json'), 1);
    expect(p.voices.map((v) => v.layer)).toEqual(['ring', 'clack', 'body']);
    expect(p.reverb).toBe(0.15);
    const ring = p.voices[0]!;
    expect(ring.source).toMatchObject({ kind: 'osc', wave: 'triangle', glideTo: 0.7, glideTime: 0.12 });
    expect(ring.stages.map((s) => s.kind)).toEqual(['filter', 'envelope', 'gain']);
    expect(ring.duration).toBeCloseTo(0.002 + 0.28, 6);
    const gain = ring.stages[2]!;
    expect(gain.kind === 'gain' && gain.linear).toBeCloseTo(Math.pow(10, -2 / 20), 6);
    expect(p.length).toBeGreaterThanOrEqual(0.5);
  });
  it('lays out repeats in time with a falloff, and extends the length', () => {
    const p = planSynth(load('explosion.json'), 3);
    const debris = p.voices.filter((v) => v.layer === 'debris');
    expect(debris).toHaveLength(10);
    expect(debris[0]!.at).toBeCloseTo(0.2, 6);
    for (let i = 1; i < debris.length; i++) {
      expect(debris[i]!.at).toBeGreaterThan(debris[i - 1]!.at);
      expect(debris[i]!.falloff).toBeLessThan(debris[i - 1]!.falloff);
    }
    expect(debris[9]!.falloff).toBeCloseTo(Math.pow(10, -13.5 / 20), 6);
    expect(p.length).toBeGreaterThanOrEqual(1.8);
  });
  it('plans a mode bank with a decay per partial', () => {
    const p = planSynth(load('ui-click.json'), 1);
    const tick = p.voices[0]!.source;
    expect(tick.kind).toBe('modes');
    if (tick.kind === 'modes') {
      expect(tick.freqs).toEqual([2400, 3600, 5200]);
      expect(tick.decays[2]!).toBeLessThan(tick.decays[0]!);
    }
  });
  it('refuses a source that is not a synth', () => {
    expect(() => planSynth({ kind: 'sound', source: { type: 'pick', from: ['sound/a'] } }, 1)).toThrow(/not a synth/);
  });
});

describe('noise and impulse', () => {
  it('is seeded, loopable and about 0.3 RMS', () => {
    for (const kind of ['white', 'pink', 'brown'] as const) {
      const a = makeNoise(kind, 20000, 7);
      expect(Array.from(makeNoise(kind, 20000, 7).slice(0, 50))).toEqual(Array.from(a.slice(0, 50)));
      expect(Array.from(makeNoise(kind, 20000, 8).slice(0, 5))).not.toEqual(Array.from(a.slice(0, 5)));
      let sq = 0;
      for (const v of a) sq += v * v;
      expect(Math.sqrt(sq / a.length)).toBeGreaterThan(0.25);
      expect(Math.sqrt(sq / a.length)).toBeLessThan(0.35);
      // No jump at the seam: last to first step is of the order of a normal step.
      expect(Math.abs(a[0]! - a[a.length - 1]!)).toBeLessThan(1.5);
    }
  });
  it('makes brown noise darker than white', () => {
    const energy = (x: Float32Array): number => { let d = 0; for (let i = 1; i < x.length; i++) d += (x[i]! - x[i - 1]!) ** 2; return d; };
    expect(energy(makeNoise('brown', 20000, 1))).toBeLessThan(energy(makeNoise('white', 20000, 1)) / 20);
  });
  it('makes an impulse that dies away', () => {
    const [l] = makeImpulse(8000, 1, 1);
    const rms = (a: number, b: number): number => { let s = 0; for (let i = a; i < b; i++) s += l[i]! ** 2; return Math.sqrt(s / (b - a)); };
    expect(rms(0, 1000)).toBeGreaterThan(rms(6000, 7000) * 5);
  });
});

describe('fft', () => {
  it('finds a sine in the right bin', () => {
    const n = 1024;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 37 * i) / n);
    fft(re, im);
    let best = 0;
    for (let k = 1; k < n / 2; k++) if (Math.hypot(re[k]!, im[k]!) > Math.hypot(re[best]!, im[best]!)) best = k;
    expect(best).toBe(37);
    expect(Math.hypot(re[37]!, im[37]!)).toBeCloseTo(n / 2, 4);
  });
  it('matches Parseval and a direct transform', () => {
    const n = 64;
    const x = Array.from({ length: n }, (_, i) => Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.9) + (i % 5) * 0.1);
    const re = Float64Array.from(x);
    const im = new Float64Array(n);
    fft(re, im);
    let time = 0;
    let freq = 0;
    for (let i = 0; i < n; i++) { time += x[i]! ** 2; freq += re[i]! ** 2 + im[i]! ** 2; }
    expect(freq / n).toBeCloseTo(time, 8);
    // Bin 3 by definition.
    let dr = 0;
    let di = 0;
    for (let i = 0; i < n; i++) { dr += x[i]! * Math.cos((2 * Math.PI * 3 * i) / n); di -= x[i]! * Math.sin((2 * Math.PI * 3 * i) / n); }
    expect(re[3]!).toBeCloseTo(dr, 8);
    expect(im[3]!).toBeCloseTo(di, 8);
  });
  it('refuses a length that is not a power of two', () => {
    expect(() => fft(new Float64Array(12), new Float64Array(12))).toThrow(/power of two/);
  });
});

describe('measurement', () => {
  const sr = 48000;
  const sine = (hz: number, amp: number, seconds: number): Float32Array => Float32Array.from({ length: Math.floor(sr * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / sr));

  it('measures duration, peak and RMS of a sine', () => {
    const m = measureChannels([sine(1000, 0.5, 0.5)], sr);
    expect(m.duration).toBeCloseTo(0.5, 6);
    expect(m.peakDb).toBeCloseTo(-6.02, 1);
    expect(m.rmsDb).toBeCloseTo(-9.03, 1);
  });
  it('reads a full-scale 997 Hz sine as about -3 LUFS, as BS.1770 says', () => {
    const m = measureChannels([sine(997, 1, 2)], sr);
    expect(m.loudnessDb).toBeGreaterThan(-3.3);
    expect(m.loudnessDb).toBeLessThan(-2.7);
  });
  it('is quieter in LUFS for a low tone than a mid tone of the same level', () => {
    expect(measureChannels([sine(20, 0.5, 1)], sr).loudnessDb).toBeLessThan(measureChannels([sine(1000, 0.5, 1)], sr).loudnessDb - 3);
  });
  it('has 512 min/max pairs that bound the signal', () => {
    const m = measureChannels([sine(100, 0.8, 1)], sr);
    expect(m.waveform).toHaveLength(WAVEFORM_PAIRS * 2);
    for (let i = 0; i < WAVEFORM_PAIRS; i++) expect(m.waveform[i * 2]!).toBeLessThanOrEqual(m.waveform[i * 2 + 1]!);
    expect(Math.max(...m.waveform)).toBeCloseTo(0.8, 2);
    expect(Math.min(...m.waveform)).toBeCloseTo(-0.8, 2);
  });
  it('has a waveform even for a buffer shorter than 512 samples', () => {
    const m = measureChannels([Float32Array.from([0.5, -0.5, 0.25])], sr);
    expect(m.waveform).toHaveLength(WAVEFORM_PAIRS * 2);
    expect(Math.max(...m.waveform)).toBeCloseTo(0.5, 6);
  });
  it('puts a 1 kHz sine in the 1 kHz band at about -3 dB and the rest far below', () => {
    const m = measureChannels([sine(1000, 1, 1)], sr);
    expect(m.spectrum).toHaveLength(SPECTRUM_BANDS);
    const edges = bandEdges(sr);
    let top = 0;
    for (let b = 1; b < SPECTRUM_BANDS; b++) if (m.spectrum[b]! > m.spectrum[top]!) top = b;
    expect(edges[top]!).toBeLessThanOrEqual(1000);
    expect(edges[top + 1]!).toBeGreaterThan(1000);
    expect(m.spectrum[top]!).toBeGreaterThan(-4.5);
    expect(m.spectrum[top]!).toBeLessThan(-2);
    expect(m.spectrum[(top + 20) % SPECTRUM_BANDS]!).toBeLessThan(-60);
  });
  it('shows white noise roughly flat per octave of bands and silence as the floor', () => {
    const m = measureChannels([makeNoise('white', sr, 2)], sr);
    // Each band holds power in proportion to its width, so the log bands rise 3 dB per octave: the top band is
    // far above the bottom one. A flat-per-band reading would be a bug in the band sums.
    expect(m.spectrum[SPECTRUM_BANDS - 1]!).toBeGreaterThan(m.spectrum[4]! + 15);
    const quiet = measureChannels([new Float32Array(4096)], sr);
    expect(quiet.peakDb).toBeLessThan(-100);
    expect(Math.max(...quiet.spectrum)).toBe(-120);
  });
});

describe('spatial', () => {
  it('is full inside ref, 1/d beyond it, and silent at max', () => {
    expect(distanceGain(2, 5, 80)).toBe(1);
    expect(distanceGain(10, 5, 80)).toBeCloseTo(0.5, 6);
    expect(distanceGain(20, 5, 80)).toBeCloseTo(0.25, 6);
    expect(distanceGain(80, 5, 80)).toBe(0);
    expect(distanceGain(200, 5, 80)).toBe(0);
  });
  it('never rises with distance', () => {
    let last = 2;
    for (let d = 0; d <= 100; d += 0.5) {
      const g = distanceGain(d, 5, 80);
      expect(g).toBeLessThanOrEqual(last + 1e-12);
      last = g;
    }
  });
  it('closes the air low-pass with distance', () => {
    expect(airCutoff(5, 5, 80)).toBeCloseTo(20000, 3);
    expect(airCutoff(80, 5, 80)).toBeCloseTo(1200, 3);
    expect(airCutoff(40, 5, 80)).toBeLessThan(airCutoff(20, 5, 80));
  });
  it('pans toward the side the source is on', () => {
    const at: [number, number, number] = [0, 0, 0];
    const fwd: [number, number, number] = [0, 0, -1];
    expect(panFor(at, fwd, [10, 0, 0])).toBeGreaterThan(0.8);
    expect(panFor(at, fwd, [-10, 0, 0])).toBeLessThan(-0.8);
    expect(panFor(at, fwd, [0, 0, -10])).toBeCloseTo(0, 6);
    expect(panFor(at, [1, 0, 0], [0, 0, 10])).toBeGreaterThan(0.8);
    expect(panFor(at, fwd, at)).toBe(0);
  });
});

// The audio engine reads state and runs outside the fixed step; the sim rules still apply to its plans: nothing may
// draw from Math.random or the wall clock, or a bench render would not repeat.
describe('house rules', () => {
  it('the pure audio files use no real time and no Math.random', () => {
    for (const f of ['plan.ts', 'dsp.ts', 'measure.ts', 'fft.ts', 'spatial.ts', 'mixer-plan.ts', 'graph.ts', 'generators.ts']) {
      const text = readFileSync(join(import.meta.dirname, f), 'utf8');
      for (const line of text.split('\n')) {
        if (/^\s*(\/\/|\*)/.test(line)) continue;
        expect(line, f).not.toMatch(/Math\.random\(|Date\.now\(|performance\.now\(|setTimeout\(/);
      }
    }
  });
});

// A context that accepts any call, so the engine's graph can be built in Node.
function fakeNode(): unknown {
  return new Proxy(function () {}, {
    get: (_t, k) => (k === 'then' ? undefined : fakeNode()),
    set: () => true,
    apply: () => fakeNode(),
  });
}
function fakeContext(): AudioContext {
  const base: Record<string, unknown> = { sampleRate: 44100, state: 'running', currentTime: 0, resume: () => Promise.resolve(), close: () => Promise.resolve() };
  return new Proxy(base, { get: (t, k) => (k in t ? t[k as string] : fakeNode()) }) as unknown as AudioContext;
}

describe('mountAudio hands its context and buses to a game that makes its own sound', () => {
  it('exposes the context and the mixer buses', async () => {
    config.load([{ path: 'hull.json', text: JSON.stringify({ kind: 'game', id: 'a', title: 'A', entry: 'src/main.ts' }) }]);
    const g = await startGame(defineGame({ ready() {} }));
    const ctx = fakeContext();
    const view = mountAudio(g, { createContext: () => ctx });
    expect(view.context).toBe(ctx);
    expect(view.bus()).toBeDefined();
    expect(view.bus('sfx')).toBeDefined();
    expect(view.bus('no-such-bus')).toBeUndefined();
    view.dispose();
    expect(view.context).toBeNull();
    g.dispose();
  });

  it('reads null and no buses when Web Audio is missing', async () => {
    const g = await startGame(defineGame({ ready() {} }));
    const view = mountAudio(g, { onError: () => {}, createContext: () => { throw new Error('no audio'); } });
    expect(view.context).toBeNull();
    expect(view.bus()).toBeUndefined();
    g.dispose();
  });
});
