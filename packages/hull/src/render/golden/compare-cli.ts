/// <reference types="node" />
// usage: node compare-cli.ts a.png b.png [diff.png] [channelTolerance]
// Prints how far two renders are apart (see compare.ts) and optionally writes a picture of where they differ.
import { readFileSync, writeFileSync } from 'node:fs';
import { compareImages, diffImage } from './compare.ts';
import { decodePng, encodePng } from './png.ts';

const [pa, pb, out, tol] = process.argv.slice(2);
if (!pa || !pb) {
  console.error('usage: node compare-cli.ts a.png b.png [diff.png] [channelTolerance]');
  process.exit(2);
}
const a = decodePng(readFileSync(pa));
const b = decodePng(readFileSync(pb));
const t = Number(tol ?? 24);
const d = compareImages(a, b, t);
console.log(`${a.width}x${a.height}: ${(d.fraction * 100).toFixed(2)}% of pixels differ by more than ${t}/255; mean ${d.mean.toFixed(2)}, rmse ${d.rmse.toFixed(2)}, max ${d.max}, psnr ${d.psnr.toFixed(1)} dB`);
if (out) writeFileSync(out, encodePng(diffImage(a, b)));
