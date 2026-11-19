// Procedural canvas textures, weathered and natural (all tileable). Each maker returns a TexSet: the colour map plus a
// tangent-space normal map derived from the texture's own relief (mortar joints, furrows, tile gaps sit lower).
// Sizes are documented in metres per repeat.
import * as THREE from 'hull/three';
import { Rng } from './rng';
import { drawEmblem } from '../player/model';
import { makeCanvas } from '../canvas';

export interface TexSet { map: THREE.Texture; normal?: THREE.Texture }
type Ctx2D = CanvasRenderingContext2D;

function canvas(w: number, h: number): [HTMLCanvasElement, Ctx2D] {
  const c = makeCanvas(); c.width = w; c.height = h;
  return [c, c.getContext('2d', { willReadFrequently: true })!];
}
function toTex(c: HTMLCanvasElement, { repeat = true, aniso = 8, srgb = true } = {}): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}
const hsl = (h: number, s: number, l: number, a = 1) => `hsla(${h.toFixed(1)},${s.toFixed(1)}%,${l.toFixed(1)}%,${a})`;

// ---------------------------------------------------------------------------------------------------------------
// Tileable value noise (lattice wraps every `period` cells) and fBm built on it.
function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x: number, y: number, px: number, py: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const x0 = ((xi % px) + px) % px, y0 = ((yi % py) + py) % py, x1 = (x0 + 1) % px, y1 = (y0 + 1) % py;
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed), c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
/** fBm in [0,1] at texel (x,y) of a W x H tile; fx/fy = base lattice cells across the tile (integers keep it tileable). */
function fbm(x: number, y: number, W: number, H: number, fx: number, fy: number, oct: number, seed: number): number {
  let s = 0, a = 0.5, n = 0, cx = fx, cy = fy;
  for (let o = 0; o < oct; o++) {
    s += a * vnoise((x / W) * cx, (y / H) * cy, cx, cy, seed + o * 31); n += a;
    a *= 0.5; cx *= 2; cy *= 2;
  }
  return s / n;
}

/**
 * Per-pixel weathering pass: multiplies the canvas by a soft fBm (blotches) and a fine grain, optionally pulls colour
 * towards a stain colour where a second noise is high. Keeps the tile seamless.
 */
function weather(c: HTMLCanvasElement, seed: number, o: { blotch?: number; grain?: number; fx?: number; fy?: number; stain?: [number, number, number]; stainAmt?: number; desat?: number } = {}): void {
  const W = c.width, H = c.height, ctx = c.getContext('2d')!;
  const img = ctx.getImageData(0, 0, W, H), d = img.data;
  const blotch = o.blotch ?? 0.18, grain = o.grain ?? 0.1, fx = o.fx ?? 4, fy = o.fy ?? Math.max(1, Math.round(fx * H / W));
  const st = o.stain, sa = o.stainAmt ?? 0, ds = o.desat ?? 0;
  const rng = new Rng(seed);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const b = fbm(x, y, W, H, fx, fy, 3, seed);
    const g = (rng.next() - 0.5) * grain + (vnoise(x * 0.5, y * 0.5, W / 2, H / 2, seed + 7) - 0.5) * grain;
    const k = 1 + (b - 0.5) * 2 * blotch + g;
    let r = d[i] * k, gg = d[i + 1] * k, bb = d[i + 2] * k;
    if (ds > 0) { const l = (r + gg + bb) / 3; r += (l - r) * ds; gg += (l - gg) * ds; bb += (l - bb) * ds; }
    if (st && sa > 0) {
      const s = Math.max(0, fbm(x, y, W, H, fx * 2, fy * 2, 2, seed + 99) - 0.55) * 2.2 * sa;
      r += (st[0] - r) * s; gg += (st[1] - gg) * s; bb += (st[2] - bb) * s;
    }
    d[i] = r; d[i + 1] = gg; d[i + 2] = bb;
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Tangent-space normal map from the canvas' luminance (darker = lower): a 3x3 blur, then central differences that
 * wrap at the edges. strength scales the slopes (about 1-4 for masonry, less for fine grain).
 */
function normalFromLuma(c: HTMLCanvasElement, strength: number, invert = false): THREE.CanvasTexture {
  const W = c.width, H = c.height, src = c.getContext('2d')!.getImageData(0, 0, W, H).data;
  const h0 = new Float32Array(W * H), h = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) { const l = (src[i * 4] * 0.299 + src[i * 4 + 1] * 0.587 + src[i * 4 + 2] * 0.114) / 255; h0[i] = invert ? 1 - l : l; }
  const at = (a: Float32Array, x: number, y: number) => a[((y + H) % H) * W + ((x + W) % W)];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += at(h0, x + i, y + j);
    h[y * W + x] = s / 9;
  }
  const [nc, nctx] = canvas(W, H), img = nctx.createImageData(W, H), d = img.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = (at(h, x + 1, y) - at(h, x - 1, y)) * strength, dy = (at(h, x, y + 1) - at(h, x, y - 1)) * strength;
    // canvas y runs down while texture v runs up: +dy on the canvas is -dv
    let nx = -dx, ny = dy, nz = 1; const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const i = (y * W + x) * 4;
    d[i] = (nx * 0.5 + 0.5) * 255; d[i + 1] = (ny * 0.5 + 0.5) * 255; d[i + 2] = (nz * 0.5 + 0.5) * 255; d[i + 3] = 255;
  }
  nctx.putImageData(img, 0, 0);
  return toTex(nc, { srgb: false });
}
const set = (c: HTMLCanvasElement, nStrength: number): TexSet => ({ normal: normalFromLuma(c, nStrength), map: toTex(c) });

/** Draw fn at (x,y) and at its wrapped copies so shapes crossing the tile edge stay seamless. */
function wrap(W: number, H: number, x: number, y: number, r: number, fn: (x: number, y: number) => void): void {
  for (const ox of [-W, 0, W]) for (const oy of [-H, 0, H]) {
    const px = x + ox, py = y + oy;
    if (px > -r && px < W + r && py > -r && py < H + r) fn(px, py);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Masonry
interface BlockOpts {
  seed: number; W: number; H: number; pxm: number; courseM: number; minW: number; maxW: number;
  hue: number; hueVar: number; sat: number; lMin: number; lMax: number; mortar: string; wear?: number;
}
/** Masonry courses. W x H px = (W/pxm) x (H/pxm) metres. Block widths wrap so the tile repeats seamlessly. */
function blocks({ seed, W, H, pxm, courseM, minW, maxW, hue, hueVar, sat, lMin, lMax, mortar, wear = 1 }: BlockOpts): HTMLCanvasElement {
  const rng = new Rng(seed); const [c, ctx] = canvas(W, H);
  ctx.fillStyle = mortar; ctx.fillRect(0, 0, W, H);
  const ch = courseM * pxm, nC = Math.round(H / ch), gap = Math.max(1.5, pxm * 0.022);
  for (let r = 0; r < nC; r++) {
    const ws: number[] = []; let sum = 0;
    while (sum < W) { const w = rng.range(minW, maxW) * pxm; ws.push(w); sum += w; }
    const k = W / sum; for (let i = 0; i < ws.length; i++) ws[i] *= k;
    let x = rng.range(0, W);
    for (const w of ws) {
      const y = r * ch;
      const l = rng.range(lMin, lMax), hh = hue + rng.range(-hueVar, hueVar), ss = Math.max(0, sat + rng.range(-3, 3));
      const tilt = rng.range(-0.6, 0.6);             // each stone a slightly different face: lighter top or side
      const chips: [number, number, number][] = [];
      for (let i = 0; i < 4; i++) if (rng.chance(0.35 * wear)) chips.push([rng.next() < 0.5 ? 0 : 1, rng.next() < 0.5 ? 0 : 1, rng.range(3, 9) * pxm / 128]);
      const crack = rng.chance(0.14 * wear) ? { u: rng.range(0.2, 0.8), pts: Array.from({ length: 4 }, () => [rng.range(-8, 8), rng.range(0.15, 0.3)]) } : null;
      const lichen = rng.chance(0.18 * wear) ? { u: rng.range(0.1, 0.9), v: rng.range(0.1, 0.9), r: rng.range(0.1, 0.3) } : null;
      for (const ox of [-W, 0, W]) {
        const bx = x + ox; if (bx > W || bx + w < 0) continue;
        const x0 = bx + gap, y0 = y + gap, bw = w - gap * 2, bh = ch - gap * 2;
        const g = ctx.createLinearGradient(x0, y0, x0 + bw * (0.3 + tilt * 0.3), y0 + bh);
        g.addColorStop(0, hsl(hh, ss, l + 3)); g.addColorStop(1, hsl(hh, ss, l - 4));
        ctx.fillStyle = g; ctx.fillRect(x0, y0, bw, bh);
        // worn arrises: a dark band just inside the joint, a faint light lip on the top edge
        ctx.strokeStyle = 'rgba(30,26,22,0.22)'; ctx.lineWidth = gap * 1.6; ctx.strokeRect(x0 + gap * 0.4, y0 + gap * 0.4, bw - gap * 0.8, bh - gap * 0.8);
        ctx.fillStyle = 'rgba(255,248,232,0.08)'; ctx.fillRect(x0 + gap, y0, bw - gap * 2, Math.max(1.5, pxm * 0.02));
        // chipped corners (fill with mortar tone)
        ctx.fillStyle = mortar;
        for (const [cx, cy, s] of chips) {
          const px = cx ? x0 + bw : x0, py = cy ? y0 + bh : y0, sx = cx ? -1 : 1, sy = cy ? -1 : 1;
          ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + sx * s * 1.6, py); ctx.lineTo(px + sx * s * 0.4, py + sy * s * 0.5); ctx.lineTo(px, py + sy * s * 1.3); ctx.fill();
        }
        if (crack) {
          ctx.strokeStyle = 'rgba(28,24,20,0.45)'; ctx.lineWidth = 1.2; ctx.beginPath();
          let px = x0 + crack.u * bw, py = y0; ctx.moveTo(px, py);
          for (const [dx, dy] of crack.pts) { px += dx * pxm / 128; py += dy * bh; ctx.lineTo(px, py); }
          ctx.stroke();
        }
        if (lichen) {
          const lx = x0 + lichen.u * bw, ly = y0 + lichen.v * bh, lr = lichen.r * pxm;
          const lg = ctx.createRadialGradient(lx, ly, 0, lx, ly, lr);
          lg.addColorStop(0, 'rgba(118,122,92,0.32)'); lg.addColorStop(1, 'rgba(118,122,92,0)');
          ctx.fillStyle = lg; ctx.fillRect(lx - lr, ly - lr, lr * 2, lr * 2);
        }
      }
      x += w; if (x > W) x -= W;
    }
  }
  // pitting
  for (let i = 0; i < W * H / 90; i++) {
    ctx.fillStyle = rng.chance(0.6) ? `rgba(25,22,18,${rng.range(0.05, 0.22)})` : `rgba(255,250,240,${rng.range(0.03, 0.1)})`;
    const s = rng.range(0.8, 2.4); ctx.fillRect(rng.range(0, W), rng.range(0, H), s, s);
  }
  weather(c, seed + 5, { blotch: 0.16 * wear + 0.06, grain: 0.07, fx: Math.max(2, Math.round(W / pxm)), stain: [70, 66, 58], stainAmt: 0.35 * wear });
  return c;
}

/** The Ashwall's face: huge weathered grey-beige ashlar in 1.5 m courses, 12 x 6 m. */
export function makeWallStone(): TexSet { return set(blocks({ seed: 11, W: 1024, H: 512, pxm: 1024 / 12, courseM: 1.5, minW: 2.2, maxW: 3.8, hue: 38, hueVar: 6, sat: 6, lMin: 50, lMax: 62, mortar: '#625e56', wear: 1 }), 2.6); }
/** Wall-top and plaza flagstones, 4 x 4 m. */
export function makePaving(): TexSet { return set(blocks({ seed: 12, W: 512, H: 512, pxm: 128, courseM: 1, minW: 1.0, maxW: 2.0, hue: 36, hueVar: 8, sat: 7, lMin: 44, lMax: 62, mortar: '#4e4a44', wear: 1.1 }), 2.2); }
/** Small limestone ashlar (chimneys, HQ trim), 4 x 4 m. */
export function makeHQStone(): TexSet { return set(blocks({ seed: 13, W: 512, H: 512, pxm: 128, courseM: 0.5, minW: 0.7, maxW: 1.4, hue: 34, hueVar: 5, sat: 9, lMin: 58, lMax: 70, mortar: '#6a645a', wear: 0.6 }), 2.2); }

/** Cobbled street of granite setts, 4 x 4 m. */
export function makeCobbles(): TexSet {
  const rng = new Rng(21), W = 512, [c, ctx] = canvas(W, W);
  ctx.fillStyle = '#3d3933'; ctx.fillRect(0, 0, W, W);
  const rows = 22, rh = W / rows;
  for (let r = 0; r < rows; r++) {
    let x = rng.range(0, W); const end = x + W;
    while (x < end - 4) {
      let w = rh * rng.range(0.9, 1.5); if (end - x - w < rh * 0.8) w = end - x;
      const l = rng.range(36, 54), hh = rng.range(25, 45), ss = rng.range(4, 10);
      const y = r * rh, inset = rh * rng.range(0.07, 0.13);
      wrap(W, W, x, y, w + rh, (px, py) => {
        const g = ctx.createRadialGradient(px + w * 0.4, py + rh * 0.35, 1, px + w * 0.5, py + rh * 0.5, Math.max(w, rh) * 0.7);
        g.addColorStop(0, hsl(hh, ss, l + 5)); g.addColorStop(1, hsl(hh, ss, l - 7));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.roundRect(px + inset, py + inset, w - inset * 2, rh - inset * 2, rh * 0.28); ctx.fill();
      });
      x += w;
    }
  }
  // dirt and grit in the joints, the odd puddle stain
  for (let i = 0; i < 2600; i++) { ctx.fillStyle = `rgba(${rng.chance(0.5) ? '40,34,26' : '120,110,96'},${rng.range(0.05, 0.25)})`; ctx.fillRect(rng.range(0, W), rng.range(0, W), rng.range(1, 2.5), rng.range(1, 2.5)); }
  weather(c, 2121, { blotch: 0.22, grain: 0.08, fx: 4, stain: [52, 46, 38], stainAmt: 0.45 });
  return set(c, 3);
}

/** Dirt road: u across the whole road (~9 m), v along (9 m); compacted ruts at 30% / 70%, a grassy crown down the middle. */
export function makeDirt(): TexSet {
  const rng = new Rng(22), W = 512, [c, ctx] = canvas(W, W);
  ctx.fillStyle = '#7d6a50'; ctx.fillRect(0, 0, W, W);
  for (let i = 0; i < 70; i++) {
    const x = rng.range(0, W), y = rng.range(0, W), rx = rng.range(14, 50), ry = rng.range(10, 30), col = hsl(rng.range(28, 38), rng.range(14, 24), rng.range(32, 48), 0.22);
    wrap(W, W, x, y, rx, (px, py) => { ctx.fillStyle = col; ctx.beginPath(); ctx.ellipse(px, py, rx, ry, 0, 0, 7); ctx.fill(); });
  }
  for (const x of [0.3, 0.7]) {
    const g = ctx.createLinearGradient((x - 0.09) * W, 0, (x + 0.09) * W, 0);
    g.addColorStop(0, 'rgba(60,48,34,0)'); g.addColorStop(0.5, 'rgba(60,48,34,0.42)'); g.addColorStop(1, 'rgba(60,48,34,0)');
    ctx.fillStyle = g; ctx.fillRect((x - 0.09) * W, 0, 0.18 * W, W);
  }
  // sparse grass on the crown and the verges
  for (let i = 0; i < 900; i++) {
    const u = rng.chance(0.5) ? rng.range(0.44, 0.56) : rng.chance(0.5) ? rng.range(0, 0.12) : rng.range(0.88, 1);
    const x = u * W, y = rng.range(0, W), h = rng.range(3, 8);
    ctx.strokeStyle = hsl(rng.range(62, 85), rng.range(18, 32), rng.range(26, 40), 0.65); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + rng.range(-2, 2), y - h); ctx.stroke();
  }
  // pebbles with a shadow side
  for (let i = 0; i < 260; i++) {
    const x = rng.range(4, W - 4), y = rng.range(4, W - 4), r = rng.range(1.2, 4), l = rng.range(40, 66);
    ctx.fillStyle = 'rgba(30,24,16,0.45)'; ctx.beginPath(); ctx.ellipse(x + 0.8, y + 0.8, r, r * 0.75, 0, 0, 7); ctx.fill();
    ctx.fillStyle = hsl(30, 8, l); ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.75, 0, 0, 7); ctx.fill();
  }
  weather(c, 2222, { blotch: 0.2, grain: 0.14, fx: 4 });
  return set(c, 2.2);
}

/**
 * Ground detail, 8 x 8 m: fine blades and soil showing through. Used as a luminance detail (the shader divides by
 * map.userData.meanLuma, so the paint underneath sets the colour).
 */
export function makeGrass(): TexSet {
  const rng = new Rng(23), W = 512, [c, ctx] = canvas(W, W);
  ctx.fillStyle = '#5b6b3a'; ctx.fillRect(0, 0, W, W);
  for (let i = 0; i < 90; i++) {
    const x = rng.range(0, W), y = rng.range(0, W), r = rng.range(20, 70), soil = rng.chance(0.3);
    wrap(W, W, x, y, r, (px, py) => {
      const g = ctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, soil ? 'rgba(92,76,52,0.35)' : rng.chance(0.5) ? 'rgba(40,56,26,0.25)' : 'rgba(130,140,80,0.2)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(px - r, py - r, r * 2, r * 2);
    });
  }
  for (let i = 0; i < 4200; i++) {
    const x = rng.range(0, W), y = rng.range(0, W), h = rng.range(4, 11), lean = rng.range(-3, 3), dark = rng.chance(0.5);
    const col = dark ? hsl(rng.range(75, 100), rng.range(20, 35), rng.range(18, 28), 0.7) : hsl(rng.range(55, 85), rng.range(22, 40), rng.range(38, 52), 0.65);
    const lw = rng.range(0.8, 1.6);
    wrap(W, W, x, y, 14, (px, py) => {
      ctx.strokeStyle = col; ctx.lineWidth = lw;
      ctx.beginPath(); ctx.moveTo(px, py); ctx.quadraticCurveTo(px + lean * 0.3, py - h * 0.6, px + lean, py - h); ctx.stroke();
    });
  }
  weather(c, 2323, { blotch: 0.12, grain: 0.12, fx: 4 });
  const s = set(c, 1.4);
  // mean linear luminance, so the ground shader can use the map as a detail around 1.0
  const d = ctx.getImageData(0, 0, W, W).data; let sum = 0;
  const lin = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  for (let i = 0; i < d.length; i += 16) sum += lin(d[i]) * 0.2126 + lin(d[i + 1]) * 0.7152 + lin(d[i + 2]) * 0.0722;
  s.map.userData.meanLuma = sum / (d.length / 16);
  return s;
}

/** Tree bark: u around (4 m), v along (8 m). Deep vertical furrows between corky ridges, patches of lichen. */
export function makeBark(): TexSet {
  const rng = new Rng(24), W = 512, H = 1024, [c, ctx] = canvas(W, H);
  const img = ctx.createImageData(W, H), d = img.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // ridged noise stretched along the trunk, with a slow sideways wander so the furrows weave
    const wob = (fbm(x, y, W, H, 2, 4, 2, 241) - 0.5) * 70;
    const n = fbm(x + wob, y, W, H, 18, 3, 3, 242);
    const ridge = 1 - Math.abs(n * 2 - 1);                 // 1 on the ridges, 0 in the furrows
    const plate = Math.pow(ridge, 0.65);
    const cross = fbm(x, y, W, H, 12, 40, 2, 243);          // horizontal breaks in the corky plates
    const k = plate * (0.82 + 0.3 * cross) * (0.88 + 0.24 * fbm(x, y, W, H, 3, 6, 2, 244));
    const i = (y * W + x) * 4;
    d[i] = 34 + 92 * k; d[i + 1] = 28 + 78 * k; d[i + 2] = 22 + 64 * k; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  for (let i = 0; i < 70; i++) {
    const x = rng.range(0, W), y = rng.range(0, H), r = rng.range(10, 34), grey = rng.chance(0.6);
    wrap(W, H, x, y, r * 1.6, (px, py) => {
      const g = ctx.createRadialGradient(px, py, 0, px, py, r * 1.4);
      g.addColorStop(0, grey ? 'rgba(150,152,136,0.28)' : 'rgba(88,104,58,0.3)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(px, py, r * 0.8, r * 1.5, 0, 0, 7); ctx.fill();
    });
  }
  weather(c, 2424, { blotch: 0.1, grain: 0.1, fx: 3, fy: 6 });
  return set(c, 3.5);
}

/** Roof tiles: 3 x 3 m. 'clay' (weathered terracotta pantiles) or 'slate'. */
export function makeRoof(kind: 'clay' | 'slate' = 'clay'): TexSet {
  const clay = kind === 'clay';
  const rng = new Rng(clay ? 31 : 32), W = 512, H = 512, [c, ctx] = canvas(W, H);
  const rows = 12, rh = H / rows, nt = clay ? 8 : 10, tw = W / nt;
  ctx.fillStyle = clay ? '#2e1a12' : '#2a2d31'; ctx.fillRect(0, 0, W, H);
  for (let r = 0; r < rows; r++) {
    const y = H - (r + 1) * rh;           // bottom row first (canvas bottom = eave side)
    const off = (r % 2) * tw / 2;
    for (let i = -1; i <= nt; i++) {
      const x = i * tw + off;
      const hh = clay ? rng.range(12, 24) : rng.range(200, 220), ss = clay ? rng.range(28, 46) : rng.range(4, 9);
      let ll = clay ? rng.range(30, 42) : rng.range(34, 46);
      if (rng.chance(0.08)) ll += clay ? rng.range(-10, -5) : -5;        // an odd replaced / darker tile
      const g = ctx.createLinearGradient(0, y - rh * 0.6, 0, y + rh);
      g.addColorStop(0, hsl(hh, ss, ll - 6)); g.addColorStop(0.35, hsl(hh, ss, ll + 3)); g.addColorStop(1, hsl(hh, ss, ll - 3));
      ctx.fillStyle = g; ctx.beginPath();
      if (clay) {
        // pantile: a rounded roll on one side
        ctx.moveTo(x + 1.5, y - rh * 0.6); ctx.lineTo(x + tw - 1.5, y - rh * 0.6); ctx.lineTo(x + tw - 1.5, y + rh * 0.45);
        ctx.quadraticCurveTo(x + tw / 2, y + rh * 0.62, x + 1.5, y + rh * 0.45); ctx.closePath(); ctx.fill();
        const rg = ctx.createLinearGradient(x, 0, x + tw, 0);
        rg.addColorStop(0, 'rgba(0,0,0,0.18)'); rg.addColorStop(0.3, 'rgba(255,230,210,0.08)'); rg.addColorStop(0.6, 'rgba(0,0,0,0)'); rg.addColorStop(1, 'rgba(0,0,0,0.22)');
        ctx.fillStyle = rg; ctx.fill();
      } else {
        ctx.rect(x + 1.5, y - rh * 0.6, tw - 3, rh * 1.6 - 1); ctx.fill();
      }
      // shadow of the course above
      ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fillRect(x, y - rh * 0.6, tw, rh * 0.18);
    }
  }
  // lichen, soot and moss streaks running down the slope
  for (let i = 0; i < 40; i++) {
    const x = rng.range(0, W), y = rng.range(0, H), r = rng.range(6, 18);
    wrap(W, H, x, y, r * 3, (px, py) => {
      ctx.fillStyle = clay ? `rgba(${rng.chance(0.5) ? '150,148,120' : '60,64,40'},${rng.range(0.12, 0.25)})` : `rgba(120,124,100,${rng.range(0.08, 0.18)})`;
      ctx.beginPath(); ctx.ellipse(px, py, r, r * 0.7, 0, 0, 7); ctx.fill();
    });
  }
  weather(c, clay ? 3131 : 3232, { blotch: 0.24, grain: 0.1, fx: 3, stain: clay ? [62, 58, 46] : [40, 42, 40], stainAmt: 0.5 });
  return set(c, 3);
}

/** Half-timbered plaster wall: 6 m wide x 3.8 m (one storey). variant 0 = braced + shutters, 1 = plain with arched windows. */
export function makePlaster(variant = 0, shutter = '#4a5a48'): TexSet {
  const rng = new Rng(40 + variant), W = 768, H = 512, [c, ctx] = canvas(W, H);
  const pxx = W / 6, pxy = H / 3.8;
  ctx.fillStyle = '#d8d1c2'; ctx.fillRect(0, 0, W, H);
  // uneven limewash and rising damp at the foot of the wall
  for (let i = 0; i < 60; i++) {
    const x = rng.range(0, W), y = rng.range(0, H), r = rng.range(20, 80);
    wrap(W, H, x, y, r, (px, py) => {
      const g = ctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, `rgba(${rng.chance(0.6) ? '110,96,74' : '245,242,232'},0.12)`); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(px - r, py - r, r * 2, r * 2);
    });
  }
  const g2 = ctx.createLinearGradient(0, H * 0.7, 0, H); g2.addColorStop(0, 'rgba(84,72,56,0)'); g2.addColorStop(1, 'rgba(84,72,56,0.35)'); ctx.fillStyle = g2; ctx.fillRect(0, H * 0.7, W, H * 0.3);
  const timber = (x: number, y: number, w: number, h: number) => {
    ctx.fillStyle = '#3a2d22'; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(16,10,6,0.45)'; ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      if (w > h) { const yy = y + rng.range(1, h - 1); ctx.moveTo(x, yy); ctx.lineTo(x + w, yy + rng.range(-1.5, 1.5)); }
      else { const xx = x + rng.range(1, w - 1); ctx.moveTo(xx, y); ctx.lineTo(xx + rng.range(-1.5, 1.5), y + h); }
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(150,130,104,0.12)'; if (w > h) ctx.fillRect(x, y + 1, w, 1.5); else ctx.fillRect(x + 1, y, 1.5, h);
  };
  const beam = variant === 0 ? 0.2 : 0.13, bx = beam * pxy, post = beam * pxx;
  const win = (cx: number, wM: number, hM: number, yTopM: number, arched: boolean) => {
    const w = wM * pxx, h = hM * pxy, x = cx - w / 2, y = yTopM * pxy;
    for (const s of [-1, 1]) {
      const sw = w * 0.5, sx = s < 0 ? x - sw - 3 : x + w + 3;
      ctx.fillStyle = shutter; ctx.fillRect(sx, y, sw, h);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1.5;
      for (let k = 1; k < 7; k++) { ctx.beginPath(); ctx.moveTo(sx, y + (k / 7) * h); ctx.lineTo(sx + sw, y + (k / 7) * h); ctx.stroke(); }
      ctx.strokeStyle = 'rgba(220,214,200,0.18)'; ctx.strokeRect(sx + 1, y + 1, sw - 2, h - 2);
    }
    ctx.fillStyle = '#b9b2a2'; ctx.beginPath();          // stone surround
    if (arched) { ctx.moveTo(x - 6, y + h + 6); ctx.lineTo(x - 6, y + w / 2); ctx.arc(cx, y + w / 2, w / 2 + 6, Math.PI, 0); ctx.lineTo(x + w + 6, y + h + 6); } else ctx.rect(x - 6, y - 6, w + 12, h + 12);
    ctx.fill();
    const gg = ctx.createLinearGradient(x, y, x + w * 0.4, y + h);
    gg.addColorStop(0, '#5d6a72'); gg.addColorStop(0.4, '#262d33'); gg.addColorStop(1, '#14181c');
    ctx.fillStyle = gg; ctx.beginPath();
    if (arched) { ctx.moveTo(x, y + h); ctx.lineTo(x, y + w / 2); ctx.arc(cx, y + w / 2, w / 2, Math.PI, 0); ctx.lineTo(x + w, y + h); } else ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.fillStyle = '#4a3a2c'; ctx.fillRect(cx - 2, y, 4, h); ctx.fillRect(x, y + h * 0.42, w, 4);       // glazing bars
    ctx.fillStyle = '#8d8676'; ctx.fillRect(x - 9, y + h + 5, w + 18, 7);                                // sill
    ctx.fillStyle = 'rgba(40,32,24,0.18)'; ctx.fillRect(x - 4, y + h + 12, w + 8, 18);                    // grime run-off under the sill
  };
  if (variant === 0) {
    for (const [x0, x1] of [[0, 3], [3, 6]]) for (const dir of [1, -1]) {
      const ax = (dir > 0 ? x0 : x1) * pxx + dir * post / 2, bx2 = ax + dir * 1.1 * pxx;
      ctx.strokeStyle = '#3a2d22'; ctx.lineWidth = 0.17 * pxx; ctx.lineCap = 'butt';
      ctx.beginPath(); ctx.moveTo(ax, H - bx); ctx.lineTo(bx2, H - bx - 1.1 * pxx); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ax, bx); ctx.lineTo(bx2, bx + 1.1 * pxx); ctx.stroke();
    }
  }
  timber(0, 0, W, bx / 2); timber(0, H - bx / 2, W, bx / 2);
  timber(0, 0, post / 2, H); timber(W - post / 2, 0, post / 2, H); timber(W / 2 - post / 2, 0, post, H);
  if (variant === 0) { win(W * 0.25, 0.95, 1.35, 0.95, false); win(W * 0.75, 0.95, 1.35, 0.95, false); }
  else { win(W * 0.25, 0.9, 1.6, 0.85, true); win(W * 0.75, 0.9, 1.6, 0.85, true); timber(0, H * 0.47, W, bx * 0.5); }
  weather(c, 4040 + variant, { blotch: 0.12, grain: 0.07, fx: 6, fy: 4, stain: [96, 88, 74], stainAmt: 0.3 });
  return { map: toTex(c), normal: normalFromLuma(c, 1.4) };
}

/** Wooden planks: 1 x 1 m, planks run along v; grey, sun-bleached and weathered. */
export function makePlanks(): TexSet {
  const rng = new Rng(50), W = 256, [c, ctx] = canvas(W, W);
  const n = 5, pw = W / n;
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = hsl(rng.range(24, 34), rng.range(16, 26), rng.range(30, 40)); ctx.fillRect(i * pw, 0, pw, W);
    for (let k = 0; k < 12; k++) {
      ctx.strokeStyle = `rgba(${rng.chance(0.5) ? '30,20,12' : '170,150,124'},${rng.range(0.1, 0.3)})`; ctx.lineWidth = rng.range(0.6, 1.6);
      const x = i * pw + rng.range(2, pw - 2); ctx.beginPath(); ctx.moveTo(x, 0); ctx.bezierCurveTo(x + rng.range(-5, 5), W * 0.3, x + rng.range(-5, 5), W * 0.7, x, W); ctx.stroke();
    }
    if (rng.chance(0.5)) { const ky = rng.range(20, W - 20), kx = i * pw + rng.range(10, pw - 10); ctx.fillStyle = 'rgba(40,26,16,0.6)'; ctx.beginPath(); ctx.ellipse(kx, ky, 3, 5, 0, 0, 7); ctx.fill(); }
    ctx.fillStyle = 'rgba(14,9,5,0.75)'; ctx.fillRect(i * pw, 0, 2.5, W);
    ctx.fillStyle = '#262220'; for (const y of [18, W - 18]) { ctx.beginPath(); ctx.arc(i * pw + pw / 2, y, 2, 0, 7); ctx.fill(); }
  }
  weather(c, 5050, { blotch: 0.15, grain: 0.1, fx: 2, desat: 0.15 });
  return set(c, 2);
}

/** Rock surface: grey stone with fractures and lichen, 2-3 m. */
export function makeRockTex(): TexSet {
  const rng = new Rng(60), W = 256, [c, ctx] = canvas(W, W);
  const img = ctx.createImageData(W, W), d = img.data;
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const n = fbm(x, y, W, W, 4, 4, 4, 601), k = 0.75 + 0.5 * n, i = (y * W + x) * 4;
    d[i] = 150 * k; d[i + 1] = 146 * k; d[i + 2] = 138 * k; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  for (let i = 0; i < 50; i++) {
    ctx.strokeStyle = `rgba(28,26,22,${rng.range(0.15, 0.4)})`; ctx.lineWidth = rng.range(0.8, 2.2); ctx.beginPath();
    let x = rng.range(0, W), y = rng.range(0, W); ctx.moveTo(x, y);
    for (let k = 0; k < 4; k++) { x += rng.range(-30, 30); y += rng.range(-30, 30); ctx.lineTo(x, y); }
    ctx.stroke();
  }
  for (let i = 0; i < 26; i++) {
    const x = rng.range(0, W), y = rng.range(0, W), r = rng.range(8, 26), col = rng.chance(0.5) ? 'rgba(150,152,128,0.3)' : 'rgba(84,96,56,0.3)';
    wrap(W, W, x, y, r, (px, py) => { ctx.fillStyle = col; ctx.beginPath(); ctx.ellipse(px, py, r, r * 0.7, 0, 0, 7); ctx.fill(); });
  }
  weather(c, 6060, { blotch: 0.1, grain: 0.14, fx: 4 });
  return set(c, 3);
}

// ---------------------------------------------------------------------------------------------------------------
// Flags (3:2 cloth). 'outriders' carries the Outriders' emblem; 'wallguard' the Wallguard's tower over crossed spears.
const BONE = '#e6e1d6', DEEP_GREEN = '#24382c', OXBLOOD = '#6e211d';

function clothGrain(ctx: Ctx2D, W: number, H: number, rng: Rng): void {
  for (let y = 0; y < H; y += 2) { ctx.fillStyle = `rgba(0,0,0,${rng.range(0, 0.05)})`; ctx.fillRect(0, y, W, 1); }
  for (let x = 0; x < W; x += 2) { ctx.fillStyle = `rgba(255,255,255,${rng.range(0, 0.03)})`; ctx.fillRect(x, 0, 1, H); }
}

/** The Wallguard device: a crenellated tower over two crossed spears, bone on oxblood. Centred at (cx, cy), S = height. */
function drawWallguard(ctx: Ctx2D, cx: number, cy: number, S: number): void {
  ctx.save(); ctx.translate(cx, cy);
  ctx.fillStyle = BONE; ctx.strokeStyle = BONE; ctx.lineCap = 'round';
  // crossed spears (behind the tower)
  for (const s of [-1, 1]) {
    ctx.save(); ctx.rotate(s * 0.62);
    ctx.lineWidth = S * 0.035; ctx.beginPath(); ctx.moveTo(0, S * 0.5); ctx.lineTo(0, -S * 0.38); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -S * 0.56); ctx.quadraticCurveTo(S * 0.06, -S * 0.44, 0, -S * 0.36); ctx.quadraticCurveTo(-S * 0.06, -S * 0.44, 0, -S * 0.56); ctx.fill();
    ctx.fillRect(-S * 0.04, -S * 0.37, S * 0.08, S * 0.02);
    ctx.restore();
  }
  // tower: body, three merlons, gate, arrow slit
  const tw = S * 0.34, top = -S * 0.22, bot = S * 0.36, mh = S * 0.09;
  ctx.fillStyle = OXBLOOD; ctx.fillRect(-tw / 2 - S * 0.03, top - mh - S * 0.03, tw + S * 0.06, bot - top + mh + S * 0.06);   // a ring of field round the tower
  ctx.fillStyle = BONE;
  ctx.fillRect(-tw / 2, top, tw, bot - top);
  const mw = tw / 5;
  for (const k of [0, 2, 4]) ctx.fillRect(-tw / 2 + k * mw, top - mh, mw, mh + 1);
  ctx.fillStyle = OXBLOOD;
  ctx.beginPath(); ctx.moveTo(-tw * 0.18, bot); ctx.lineTo(-tw * 0.18, bot - S * 0.1); ctx.arc(0, bot - S * 0.1, tw * 0.18, Math.PI, 0); ctx.lineTo(tw * 0.18, bot); ctx.fill();
  ctx.fillRect(-S * 0.012, top + S * 0.08, S * 0.024, S * 0.1);
  ctx.restore();
}

export function makeFlag(kind: 'outriders' | 'wallguard'): TexSet {
  const W = 512, H = 340, [c, ctx] = canvas(W, H), rng = new Rng(kind === 'outriders' ? 71 : 72);
  if (kind === 'outriders') {
    ctx.fillStyle = DEEP_GREEN; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = BONE; ctx.lineWidth = 5; ctx.strokeRect(14, 14, W - 28, H - 28);
    drawEmblem(ctx, W / 2, H / 2, 210);
  } else {
    ctx.fillStyle = OXBLOOD; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = BONE; ctx.fillRect(0, 16, W, 5); ctx.fillRect(0, H - 21, W, 5);
    drawWallguard(ctx, W / 2, H / 2 + 6, 250);
  }
  clothGrain(ctx, W, H, rng);
  weather(c, kind === 'outriders' ? 7171 : 7272, { blotch: 0.12, grain: 0.06, fx: 3, fy: 2 });
  return { map: toTex(c, { aniso: 4 }) };
}

/** Wallguard HQ / chapel stone wall with arched windows: 6 m wide x 5 m tall tile. */
export function makeHQWall(): TexSet {
  const W = 768, H = 640, pxm = 128;
  const c = blocks({ seed: 14, W, H, pxm, courseM: 0.5, minW: 0.7, maxW: 1.5, hue: 36, hueVar: 5, sat: 8, lMin: 62, lMax: 74, mortar: '#726c62', wear: 0.6 });
  const ctx = c.getContext('2d')!;
  const win = (cx: number, wM: number, hM: number, yTopM: number) => {
    const w = wM * pxm, h = hM * pxm, x = cx - w / 2, y = yTopM * pxm;
    ctx.fillStyle = '#b8b0a0'; ctx.beginPath(); ctx.moveTo(x - 12, y + h + 10); ctx.lineTo(x - 12, y + w / 2); ctx.arc(cx, y + w / 2, w / 2 + 12, Math.PI, 0); ctx.lineTo(x + w + 12, y + h + 10); ctx.fill();
    ctx.strokeStyle = 'rgba(40,34,28,0.5)'; ctx.lineWidth = 2; ctx.stroke();
    const g = ctx.createLinearGradient(x, y, x + w * 0.5, y + h); g.addColorStop(0, '#56626c'); g.addColorStop(0.45, '#20262c'); g.addColorStop(1, '#121518');
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x, y + w / 2); ctx.arc(cx, y + w / 2, w / 2, Math.PI, 0); ctx.lineTo(x + w, y + h); ctx.fill();
    ctx.fillStyle = '#3a3630'; ctx.fillRect(cx - 3, y, 6, h); ctx.fillRect(x, y + h * 0.5, w, 5);
    ctx.fillStyle = '#9a9282'; ctx.fillRect(x - 16, y + h + 10, w + 32, 10);
    ctx.fillStyle = 'rgba(40,34,26,0.2)'; ctx.fillRect(x - 10, y + h + 20, w + 20, 40);
  };
  win(W * 0.25, 1.0, 2.3, 1.2); win(W * 0.75, 1.0, 2.3, 1.2);
  ctx.fillStyle = 'rgba(30,26,20,0.35)'; ctx.fillRect(0, 0, W, 5); ctx.fillStyle = 'rgba(240,232,214,0.12)'; ctx.fillRect(0, 5, W, 4);
  return set(c, 2.2);
}
