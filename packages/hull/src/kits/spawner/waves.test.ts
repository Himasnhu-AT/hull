import { describe, expect, it } from 'vitest';
import { beginWave, newWaveState, resetWaves, stepWaves, waveCap, waveClock, waveScale, WAVE_CLEARED, WAVE_NEXT, WAVE_NONE, WAVE_TRICKLE, type WaveRules } from './waves.ts';

const R: WaveRules = { clearPause: 4, clockBase: 90, clockPerWave: 4, clockMin: 45, capBase: 6, capPerWave: 2, capMax: 22, trickleBase: 12, trickleDrop: 0.8, trickleMin: 4, firstTrickle: 6 };

describe('wave clock', () => {
  it('computes the cap, the clock and the growth past the table', () => {
    expect(waveCap(1, R)).toBe(8);
    expect(waveCap(50, R)).toBe(22);
    expect(waveClock(1, R)).toBe(86);
    expect(waveClock(40, R)).toBe(45);
    expect(waveScale(0, 4, 0.35)).toBe(1);
    expect(waveScale(3, 4, 0.35)).toBe(1);
    expect(waveScale(4, 4, 0.35)).toBeCloseTo(1.35);
    expect(waveScale(5, 4, 0.35)).toBeCloseTo(1.35 + 0.35);
  });

  it('announces a clear field once, counts the pause, then asks for the next wave', () => {
    const s = newWaveState();
    s.wave = 1;
    expect(stepWaves(s, 0.1, 0, 0, false, R)).toBe(WAVE_CLEARED);
    expect(s.waveClear).toBe(4);
    let next = 0;
    let steps = 0;
    while (next !== WAVE_NEXT && steps++ < 1000) next = stepWaves(s, 0.1, 0, 0, false, R);
    expect(steps).toBeGreaterThan(39);
    expect(steps).toBeLessThan(42);
    expect(beginWave(s, R)).toBe(1);
    expect(s.wave).toBe(2);
    expect(s.trickleT).toBe(6);
  });

  it('does not count the field clear before the first wave, or while something is held or queued', () => {
    const s = newWaveState();
    expect(stepWaves(s, 0.1, 0, 0, false, R)).toBe(WAVE_NONE);
    s.waveClear = 0; s.wave = 1; s.trickleT = 100;
    expect(stepWaves(s, 0.1, 0, 2, false, R)).toBe(WAVE_NONE);
    expect(stepWaves(s, 0.1, 0, 0, true, R)).toBe(WAVE_NONE);
    expect(s.waveClear).toBe(0);
  });

  it('sends stragglers while enemies stand, and the next wave on the clock', () => {
    const s = newWaveState();
    beginWave(s, R);
    let trickles = 0;
    let t = 0;
    let code = 0;
    while (code !== WAVE_NEXT && t < 200) { code = stepWaves(s, 0.05, 3, 0, false, R); if (code === WAVE_TRICKLE) trickles++; t += 0.05; }
    expect(code).toBe(WAVE_NEXT);
    expect(t).toBeGreaterThan(85.9);
    expect(t).toBeLessThan(86.2);
    expect(trickles).toBeGreaterThan(5);
    // too many standing: the clock waits
    const full = newWaveState();
    beginWave(full, R);
    for (let i = 0; i < 4000; i++) expect(stepWaves(full, 0.05, 30, 0, false, R)).not.toBe(WAVE_NEXT);
    resetWaves(full);
    expect(full.wave).toBe(0);
  });
});
