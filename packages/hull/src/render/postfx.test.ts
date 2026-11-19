import { describe, expect, it } from 'vitest';
import { impactEnvelope, IMPACT_SECONDS, PostFxState } from './postfx.ts';
import { placeSun } from './rig.ts';
import { resolveLook } from './look.ts';
import { DirectionalLight } from 'three';

describe('speed cue', () => {
  it('eases towards the target and back, never jumping', () => {
    const fx = new PostFxState();
    fx.setSpeed(1);
    fx.update(1 / 60);
    const first = fx.value.speed;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(0.2);
    for (let i = 0; i < 120; i++) fx.update(1 / 60);
    expect(fx.value.speed).toBeGreaterThan(0.99);
    fx.setSpeed(0);
    for (let i = 0; i < 240; i++) fx.update(1 / 60);
    expect(fx.value.speed).toBeLessThan(0.01);
  });
  it('clamps what the game reports', () => {
    const fx = new PostFxState();
    fx.setSpeed(9);
    for (let i = 0; i < 600; i++) fx.update(1 / 60);
    expect(fx.value.speed).toBeLessThanOrEqual(1);
  });
});

describe('impact pulse', () => {
  it('has full strength on the hit, then eases to nothing', () => {
    expect(impactEnvelope(0)).toBe(1);
    expect(impactEnvelope(0.1)).toBe(1);
    expect(impactEnvelope(0.5)).toBeLessThan(1);
    expect(impactEnvelope(0.5)).toBeGreaterThan(0);
    expect(impactEnvelope(1)).toBe(0);
  });
  it('runs in real time, ends, and shows at least two frames on a slow machine', () => {
    const fx = new PostFxState();
    fx.impact([1, 2, 3], 0.8);
    fx.update(1 / 60);
    expect(fx.value.impact).toBeCloseTo(0.8, 5);
    expect(fx.value.impactAt).toEqual([1, 2, 3]);
    let frames = 1;
    while (fx.value.impact > 0 && frames < 100) { fx.update(1 / 60); frames++; }
    expect(frames).toBeGreaterThan(Math.floor(IMPACT_SECONDS * 60));
    expect(frames).toBeLessThan(25);
    // a 2 fps machine still gets two drawn frames
    const slow = new PostFxState();
    slow.impact(null, 1);
    slow.update(0.5);
    expect(slow.value.impact).toBe(1);
    slow.update(0.5);
    expect(slow.value.impact).toBeGreaterThan(0);
    let n = 0;
    while (slow.value.impact > 0 && n++ < 20) slow.update(0.5);
    expect(slow.value.impact).toBe(0);
  });
  it('can be cancelled and held', () => {
    const fx = new PostFxState();
    fx.impact(null, 1);
    fx.update(0.01);
    fx.cancel();
    fx.update(0.01);
    expect(fx.value.impact).toBe(0);
    fx.hold(0.6, [0, 1, 0]);
    fx.update(1);
    expect(fx.value.impact).toBe(0.6);
    expect(fx.active).toBe(true);
    fx.hold(null);
    fx.update(0.01);
    expect(fx.value.impact).toBe(0);
  });
});

describe('sun shadow lead', () => {
  it('moves the shadowed area ahead along the view and stays put with no lead', () => {
    const look = resolveLook({ kind: 'look', sun: { shadows: true, shadowRange: 75, shadowLead: 0.5 } });
    const none = resolveLook({ kind: 'look', sun: { shadows: true, shadowRange: 75 } });
    const sun = new DirectionalLight();
    const a: [number, number, number] = [0, 0, 0], b: [number, number, number] = [0, 0, 0];
    placeSun(sun, none, 0, 0, 0, 2048, a, 0, -1);
    placeSun(sun, look, 0, 0, 0, 2048, b, 0, -1);
    // 37.5 m ahead along -z, then snapped to the sun's own light-space axes: the target moved by about that much
    const moved = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    expect(moved).toBeGreaterThan(30);
    expect(moved).toBeLessThan(45);
    const c: [number, number, number] = [0, 0, 0];
    placeSun(sun, look, 0, 0, 0, 2048, c, 0, 0);
    expect(c).toEqual(a);
  });
  it('fills the shadow settings from defaults', () => {
    const s = resolveLook(undefined).sun;
    expect(s).toMatchObject({ shadowLead: 0, shadowSoftness: 1, shadowNormalBias: 0.02 });
  });
});
