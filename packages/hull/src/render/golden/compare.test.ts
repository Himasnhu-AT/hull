/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareImages, diffImage, regionMean, withinTolerance, type Rgba } from './compare.ts';
import { decodePng, encodePng } from './png.ts';

function solid(w: number, h: number, rgb: [number, number, number]): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; data[i * 4 + 3] = 255; }
  return { width: w, height: h, data };
}

describe('golden image comparison', () => {
  it('identical images differ by nothing', () => {
    const d = compareImages(solid(8, 8, [10, 20, 30]), solid(8, 8, [10, 20, 30]), 2);
    expect(d.different).toBe(0);
    expect(d.mean).toBe(0);
    expect(d.psnr).toBe(Infinity);
  });

  it('counts only pixels past the tolerance, and reports mean, rmse and max', () => {
    const a = solid(10, 10, [100, 100, 100]);
    const b = solid(10, 10, [100, 100, 100]);
    b.data[0] = 110; // one pixel off by 10 in red
    b.data[4] = 101; // another off by 1: inside a tolerance of 2
    const d = compareImages(a, b, 2);
    expect(d.different).toBe(1);
    expect(d.fraction).toBeCloseTo(0.01);
    expect(d.max).toBe(10);
    expect(d.mean).toBeCloseTo(11 / 300);
    expect(withinTolerance(d, { channel: 2, fraction: 0.02, mean: 1 })).toBe(true);
    expect(withinTolerance(d, { channel: 2, fraction: 0.005, mean: 1 })).toBe(false);
  });

  it('refuses images of different sizes', () => {
    expect(() => compareImages(solid(2, 2, [0, 0, 0]), solid(3, 2, [0, 0, 0]), 1)).toThrow(/sizes differ/);
  });

  it('draws the difference and averages a region', () => {
    const a = solid(4, 4, [50, 50, 50]);
    const b = solid(4, 4, [50, 50, 50]);
    b.data[0] = 150;
    const diff = diffImage(a, b);
    expect(diff.data[0]).toBeGreaterThan(diff.data[4]!);
    expect(regionMean(a, 0, 0, 2, 2)).toEqual([50, 50, 50]);
  });
});

describe('png reader and writer', () => {
  it('round-trips an image', () => {
    const img = solid(5, 3, [1, 2, 3]);
    img.data[7] = 128;
    img.data[12] = 255;
    const back = decodePng(encodePng(img));
    expect(back.width).toBe(5);
    expect(back.height).toBe(3);
    expect(Array.from(back.data)).toEqual(Array.from(img.data));
  });
  it('rejects a file that is not a PNG', () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toThrow(/not a PNG/);
  });
});

// The committed pair, when it exists: the two backends' renders of the golden scene stay within tolerance.
const dir = join(import.meta.dirname, 'images');
const pair = ['webgl2.png', 'webgpu.png'].map((f) => join(dir, f));
describe.skipIf(!pair.every((p) => existsSync(p)))('the committed golden pair', () => {
  it('webgl2 and webgpu agree within the tolerance in golden/README.md', () => {
    const [a, b] = pair.map((p) => decodePng(readFileSync(p))) as [Rgba, Rgba];
    const d = compareImages(a, b, 24);
    console.log(`golden webgl2 vs webgpu: ${(d.fraction * 100).toFixed(2)}% of pixels differ by more than 24, mean ${d.mean.toFixed(2)}, rmse ${d.rmse.toFixed(2)}, psnr ${d.psnr.toFixed(1)} dB`);
    expect(withinTolerance(d, { channel: 24, fraction: 0.05, mean: 4 })).toBe(true);
  });
});
