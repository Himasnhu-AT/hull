// Cheap previews for the Content Browser: a few numbers or colours per asset, read from its config text, never rendered.
// The Studio draws them (a lit sphere, a sky strip, a level strip). The server caches by text, so an unchanged file costs nothing.
import type { ContentThumb } from 'hull/dev/protocol';

const HEX = /^#[0-9a-fA-F]{3,8}$/;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const hex = (v: unknown, d: string): string => (typeof v === 'string' && HEX.test(v) ? v : d);

/** Every colour string inside a value, in order, at most n. */
function colours(v: unknown, n: number, out: string[] = []): string[] {
  if (out.length >= n) return out;
  if (typeof v === 'string') { if (HEX.test(v)) out.push(v); }
  else if (Array.isArray(v)) for (const x of v) colours(x, n, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) colours(x, n, out);
  return out;
}

const BINS = 28;

/** A level strip from a synth's layers: each layer is a gain, a start and an attack and decay. It is a sketch of loudness over time, not a render. */
function soundBars(v: Record<string, unknown>): number[] | null {
  const src = obj(v['source']);
  if (src['type'] !== 'synth') return null;
  const layers = Object.values(obj(src['layers'])).map(obj);
  if (layers.length === 0) return null;
  const level = num(v['level'], 0);
  const shaped = layers.map((l) => {
    let attack = 0.002, decay = 0.1, gain = 0;
    for (const step of Array.isArray(l['then']) ? l['then'] : []) {
      const s = obj(step);
      if (s['envelope']) { const e = obj(s['envelope']); attack = num(e['attack'], attack); decay = num(e['decay'], decay); }
      if (typeof s['gain'] === 'number') gain += s['gain'];
    }
    return { at: num(l['at'], 0), attack: Math.max(attack, 0.0005), decay: Math.max(decay, 0.005), amp: 10 ** ((gain + level) / 20) };
  });
  const total = Math.max(num(src['length'], 0), ...shaped.map((l) => l.at + l.attack + l.decay), 0.05);
  const bars: number[] = [];
  for (let i = 0; i < BINS; i++) {
    const t = ((i + 0.5) / BINS) * total;
    let peak = 0;
    for (const l of shaped) {
      const x = t - l.at;
      if (x < 0) continue;
      const env = x < l.attack ? x / l.attack : Math.exp(-(x - l.attack) / (l.decay / 3));
      peak = Math.max(peak, l.amp * env);
    }
    bars.push(peak);
  }
  const top = Math.max(...bars, 1e-6);
  return bars.map((b) => Math.round((b / top) * 100) / 100);
}

export function thumbOf(id: string, value: unknown, byId: (id: string) => unknown): ContentThumb | null {
  const v = obj(value);
  switch (v['kind']) {
    case 'material': {
      const thumb: ContentThumb = { type: 'material', color: hex(v['color'], '#8a919c'), roughness: num(v['roughness'], 0.6), metalness: num(v['metalness'], 0) };
      // Only a material that glows says so, so the thumbs of plain ones stay as they were.
      const glow = hex(v['emissive'], '#000000');
      if (glow !== '#000000' && num(v['emissiveIntensity'], 1) > 0) thumb.emissive = glow;
      return thumb;
    }
    case 'look': {
      const sky = obj(v['sky']);
      return { type: 'look', sky: [hex(sky['zenith'], '#5a7aa8'), hex(sky['mid'], '#8aa0bc'), hex(sky['horizon'], '#c3cdd3')], fog: hex(obj(v['fog'])['color'], hex(sky['horizon'], '#c3cdd3')) };
    }
    case 'vfx': return { type: 'vfx', colors: colours(obj(v['particle'])['color'], 4) };
    case 'sound': return { type: 'sound', bars: soundBars(v), length: num(obj(v['source'])['length'], 0) };
    case 'character': {
      // Colours of the materials the character names, so a soldier and a titan do not look alike.
      const found: string[] = [];
      const seen = (x: unknown): void => {
        if (found.length >= 3) return;
        if (typeof x === 'string' && x.startsWith('material/')) { const c = obj(byId(x))['color']; if (typeof c === 'string' && HEX.test(c)) found.push(c); }
        else if (Array.isArray(x)) x.forEach(seen);
        else if (x && typeof x === 'object') Object.values(x).forEach(seen);
      };
      seen(v);
      return { type: 'character', colors: found };
    }
    default: void id; return null;
  }
}
