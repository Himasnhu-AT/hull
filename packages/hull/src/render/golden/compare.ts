// Comparing two renders of the same scene, pure so Node tests cover it. The two backends cannot match bit for bit
// (different rasterisers, different shadow filters, different bloom rounding), so a pair passes when almost every
// pixel is within a per-channel tolerance and the average difference is small.
export interface Rgba {
  width: number;
  height: number;
  /** width * height * 4 bytes, row by row from the top. */
  data: Uint8Array | Uint8ClampedArray;
}

export interface Tolerance {
  /** A pixel is "different" when any of its colour channels differs by more than this (0 to 255). */
  channel: number;
  /** The most pixels allowed to be different, as a fraction of all pixels. */
  fraction: number;
  /** The mean absolute difference over every channel that is allowed (0 to 255). */
  mean: number;
}

export interface Difference {
  pixels: number;
  /** Pixels with a channel above the tolerance. */
  different: number;
  /** different / pixels. */
  fraction: number;
  /** Mean absolute difference over R, G and B, in 0..255 units. */
  mean: number;
  /** Root-mean-square difference over R, G and B, in 0..255 units. */
  rmse: number;
  /** Largest single-channel difference anywhere. */
  max: number;
  /** Peak signal to noise ratio in dB (infinity when identical). */
  psnr: number;
}

/** Throws when the sizes differ: a size mismatch is a setup mistake, not a small difference. */
export function compareImages(a: Rgba, b: Rgba, channelTolerance: number): Difference {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`compare: sizes differ (${a.width}x${a.height} against ${b.width}x${b.height})`);
  const n = a.width * a.height;
  let different = 0;
  let sum = 0;
  let sq = 0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    let worst = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.data[o + c]! - b.data[o + c]!);
      sum += d;
      sq += d * d;
      if (d > worst) worst = d;
    }
    if (worst > max) max = worst;
    if (worst > channelTolerance) different++;
  }
  const mse = sq / (n * 3);
  return {
    pixels: n,
    different,
    fraction: n === 0 ? 0 : different / n,
    mean: n === 0 ? 0 : sum / (n * 3),
    rmse: Math.sqrt(mse),
    max,
    psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse),
  };
}

export function withinTolerance(d: Difference, t: Tolerance): boolean {
  return d.fraction <= t.fraction && d.mean <= t.mean;
}

/** A picture of where two renders differ: grey where they agree, red scaled by the error where they do not. */
export function diffImage(a: Rgba, b: Rgba, gain = 4): Rgba {
  const out = new Uint8ClampedArray(a.width * a.height * 4);
  for (let i = 0; i < a.width * a.height; i++) {
    const o = i * 4;
    let worst = 0;
    for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(a.data[o + c]! - b.data[o + c]!));
    const grey = (a.data[o]! + a.data[o + 1]! + a.data[o + 2]!) / 3 * 0.35;
    out[o] = Math.min(255, grey + worst * gain);
    out[o + 1] = grey;
    out[o + 2] = grey;
    out[o + 3] = 255;
  }
  return { width: a.width, height: a.height, data: out };
}

/** Mean colour (0..255) of a rectangle, for judging a region (the sky, a shadow, a particle burst) on its own. */
export function regionMean(img: Rgba, x0: number, y0: number, x1: number, y1: number): [number, number, number] {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * img.width + x) * 4;
      r += img.data[o]!; g += img.data[o + 1]!; b += img.data[o + 2]!;
      n++;
    }
  }
  return n === 0 ? [0, 0, 0] : [r / n, g / n, b / n];
}
