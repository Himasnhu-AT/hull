import { describe, expect, it } from 'vitest';
import { postFor, resolveLook, resolvePost, snapShadowTarget, sunDirection, TIERS } from './look.ts';

describe('post settings', () => {
  it('is null when nothing changes the picture, and fills defaults otherwise', () => {
    expect(resolvePost(undefined)).toBeNull();
    expect(resolvePost({})).toBeNull();
    expect(resolvePost({ contrast: 1, saturation: 1, bloom: 0 })).toBeNull();
    const p = resolvePost({ bloom: 0.6, vignette: 0.2, aa: 'fxaa' })!;
    expect(p.bloom).toBe(0.6);
    expect(p.bloomThreshold).toBe(1);
    expect(p.gain).toEqual([1, 1, 1]);
    expect(p.fxaa).toBe(true);
    expect(resolvePost({ lift: [0.02, 0, 0] })).not.toBeNull();
  });

  it('resolves through the look, and speedBlur alone turns the chain on', () => {
    expect(resolveLook({ kind: 'look', post: { speedBlur: 0.1 } }).post!.speedBlur).toBe(0.1);
    expect(resolveLook({ kind: 'look', post: { speedBlur: 0 } }).post).toBeNull();
    expect(resolveLook({ kind: 'look', post: { bloom: 0.5 } }).post!.bloom).toBe(0.5);
  });

  it('quality tiers cut post and shadows', () => {
    const p = resolvePost({ bloom: 0.5, grain: 0.03, aa: 'fxaa' });
    expect(postFor(p, TIERS.low)).toBeNull();
    expect(postFor(p, TIERS.medium)).toMatchObject({ bloom: 0.5, grain: 0, fxaa: false });
    expect(postFor(p, TIERS.high)).toMatchObject({ bloom: 0.5, grain: 0.03, fxaa: true });
    expect(TIERS.low.shadows).toBe(false);
    expect(TIERS.medium.shadowMap).toBeLessThan(TIERS.high.shadowMap);
  });
});

describe('environment and hemisphere defaults', () => {
  it('gives a gradient sky sky light and a flat sky none, unless told', () => {
    expect(resolveLook(undefined).environment.intensity).toBe(0);
    expect(resolveLook({ kind: 'look', sky: { zenith: '#000000' } }).environment.intensity).toBe(0.4);
    expect(resolveLook({ kind: 'look', environment: { intensity: 1 } }).environment.intensity).toBe(1);
    const h = resolveLook({ kind: 'look', ambient: { color: '#ffffff', ground: '#222222' } }).ambient;
    expect(h).toMatchObject({ hemisphere: true, ground: '#222222' });
    expect(resolveLook(undefined).ambient.hemisphere).toBe(false);
  });
});

describe('shadow stabilisation', () => {
  const dir = sunDirection(35, 200);
  const range = 24;
  const map = 2048;
  const texel = (2 * range) / map;
  const out: [number, number, number] = [0, 0, 0];

  // The shadow map's own right and up axes, as the function builds them.
  const basis = () => {
    const [dx, dy, dz] = dir;
    const r = [dz, 0, -dx];
    const rl = Math.hypot(...r);
    const rx = r[0]! / rl, ry = 0, rz = r[2]! / rl;
    return { r: [rx, ry, rz], u: [dy * rz - dz * ry, dz * rx - dx * rz, dx * ry - dy * rx] };
  };

  it('lands on whole texels along the light right and up axes', () => {
    const { r, u } = basis();
    snapShadowTarget(13.3719, 2.5, -41.918, dir, range, map, out);
    const a = out[0] * r[0]! + out[1] * r[1]! + out[2] * r[2]!;
    const b = out[0] * u[0]! + out[1] * u[1]! + out[2] * u[2]!;
    expect(Math.abs(a / texel - Math.round(a / texel))).toBeLessThan(1e-3);
    expect(Math.abs(b / texel - Math.round(b / texel))).toBeLessThan(1e-3);
  });

  it('holds still for a camera move smaller than a texel, and keeps the depth along the light', () => {
    const base = [10.2, 3, 7.7] as const;
    snapShadowTarget(base[0], base[1], base[2], dir, range, map, out);
    const first = [...out];
    // Move a sixth of a texel along the right axis: the snapped target should usually not change.
    const { r } = basis();
    let same = 0;
    for (let k = 0; k < 20; k++) {
      const s = (k / 20) * texel * 0.1;
      snapShadowTarget(base[0] + r[0]! * s, base[1], base[2] + r[2]! * s, dir, range, map, out);
      if (Math.abs(out[0] - first[0]!) < 1e-9 && Math.abs(out[2] - first[2]!) < 1e-9) same++;
    }
    expect(same).toBeGreaterThanOrEqual(18);
    // The move never exceeds half a texel from the real position.
    snapShadowTarget(base[0], base[1], base[2], dir, range, map, out);
    expect(Math.hypot(out[0] - base[0], out[1] - base[1], out[2] - base[2])).toBeLessThan(texel * 0.75);
    // Depth along the light direction is untouched.
    const depthIn = base[0] * dir[0] + base[1] * dir[1] + base[2] * dir[2];
    const depthOut = out[0] * dir[0] + out[1] * dir[1] + out[2] * dir[2];
    expect(depthOut).toBeCloseTo(depthIn, 6);
  });

  it('copes with a sun straight overhead', () => {
    snapShadowTarget(1.234, 0, 5.678, sunDirection(90, 0), range, map, out);
    expect(out.every(Number.isFinite)).toBe(true);
  });
});
