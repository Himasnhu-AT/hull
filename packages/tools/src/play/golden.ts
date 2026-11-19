// Golden images: a screenshot taken at a known step, kept under tests/golden/, compared pixel by pixel.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decodePng, encodePng, type Image } from './png.ts';

export interface Tolerance {
  /** Largest difference in any one channel (0-255) that still counts as the same pixel. Default 8: GPU rounding. */
  channel: number;
  /** How many pixels may differ by more than that. Default 0. */
  pixels: number;
}

export interface Comparison {
  ok: boolean;
  width: number;
  height: number;
  /** Pixels whose channel difference is above the tolerance. */
  diffPixels: number;
  /** Largest channel difference seen anywhere. */
  maxDelta: number;
  /** A red-on-dim picture of where they differ; absent when the sizes differ. */
  diff?: Image;
  sizeMismatch?: { golden: [number, number]; actual: [number, number] };
}

export function compareImages(golden: Image, actual: Image, tol: Tolerance): Comparison {
  if (golden.width !== actual.width || golden.height !== actual.height) {
    return { ok: false, width: actual.width, height: actual.height, diffPixels: actual.width * actual.height, maxDelta: 255, sizeMismatch: { golden: [golden.width, golden.height], actual: [actual.width, actual.height] } };
  }
  const n = actual.width * actual.height;
  const diff = new Uint8Array(n * 4);
  let diffPixels = 0;
  let maxDelta = 0;
  for (let i = 0; i < n; i++) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(golden.data[i * 4 + c]! - actual.data[i * 4 + c]!));
    if (d > maxDelta) maxDelta = d;
    const bad = d > tol.channel;
    if (bad) diffPixels++;
    const o = i * 4;
    diff[o] = bad ? 255 : actual.data[o]! >> 2; diff[o + 1] = bad ? 0 : actual.data[o + 1]! >> 2; diff[o + 2] = bad ? 0 : actual.data[o + 2]! >> 2; diff[o + 3] = 255;
  }
  return { ok: diffPixels <= tol.pixels, width: actual.width, height: actual.height, diffPixels, maxDelta, diff: { width: actual.width, height: actual.height, data: diff } };
}

const safe = (name: string): boolean => /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/.test(name);

export const goldenPath = (root: string, name: string): string => join(root, 'tests', 'golden', `${name}.png`);

export type GoldenResult =
  | { status: 'new' | 'updated'; path: string }
  | { status: 'match'; path: string; comparison: Comparison }
  | { status: 'differs'; path: string; comparison: Comparison; actualPath: string; diffPath?: string };

/** Compares a PNG to its golden. A missing golden (or `update`) is written instead; a mismatch leaves the actual and diff under .hull/play/. */
export function checkGolden(root: string, name: string, png: Buffer, tol: Tolerance, update: boolean): GoldenResult {
  if (!safe(name)) throw new Error(`"${name}" is not a golden name (letters, digits, - and _, with / for folders)`);
  const path = goldenPath(root, name);
  const rel = `tests/golden/${name}.png`;
  if (!existsSync(path) || update) {
    const status = existsSync(path) ? 'updated' : 'new';
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, png);
    return { status, path: rel };
  }
  const comparison = compareImages(decodePng(readFileSync(path)), decodePng(png), tol);
  if (comparison.ok) return { status: 'match', path: rel, comparison };
  const dir = join(root, '.hull', 'play');
  mkdirSync(dirname(join(dir, `${name}.actual.png`)), { recursive: true });
  writeFileSync(join(dir, `${name}.actual.png`), png);
  let diffPath: string | undefined;
  if (comparison.diff) { writeFileSync(join(dir, `${name}.diff.png`), encodePng(comparison.diff)); diffPath = `.hull/play/${name}.diff.png`; }
  return { status: 'differs', path: rel, comparison, actualPath: `.hull/play/${name}.actual.png`, ...(diffPath ? { diffPath } : {}) };
}
