// A preview per kind, drawn from the few numbers or colours the server read out of the asset (ContentThumb). No render, no
// canvas: a gradient, an SVG strip or a glyph, so a hundred tiles cost nothing and an unchanged asset is not redrawn.
import { memo, type JSX } from 'react';
import type { ContentThumb } from 'hull/dev/protocol';
import { Icon, type IconName } from '../ui/Icon.tsx';

const ICON: Record<string, IconName> = {
  tunables: 'sliders', code: 'console', 'input-map': 'input', mixer: 'sliders', tuning: 'sliders', game: 'game',
  'anim-set': 'play', 'anim-graph': 'branch', 'ui-theme': 'interface', 'ui-screen': 'interface',
  sound: 'audio', vfx: 'world', character: 'characters', material: 'world', look: 'world',
};
export const iconOf = (kind: string): IconName => ICON[kind] ?? 'file';

const mix = (c: string, to: string, pct: number): string => `color-mix(in srgb, ${to} ${pct}%, ${c})`;

function Sphere({ t }: { t: Extract<ContentThumb, { type: 'material' }> }): JSX.Element {
  // Roughness sets how big and bright the highlight is; metal darkens the diffuse and lets the surround show.
  const gloss = 1 - Math.min(1, Math.max(0, t.roughness));
  const metal = Math.min(1, Math.max(0, t.metalness));
  const lit = mix(t.color, '#000', Math.round(metal * 45));
  // A glowing material shows its emissive colour through the body and throws a halo, since it needs no light to be seen.
  const base = t.emissive ? mix(lit, t.emissive, 55) : lit;
  const spec = `radial-gradient(circle at 34% 28%, rgba(255,255,255,${(0.25 + gloss * 0.7).toFixed(2)}) 0, rgba(255,255,255,0) ${Math.round(10 + (1 - gloss) * 38)}%)`;
  const body = `radial-gradient(circle at 36% 30%, ${mix(base, '#fff', 30)} 0, ${base} 48%, ${mix(base, '#000', 62)} 100%)`;
  const env = metal > 0.3 ? `linear-gradient(180deg, rgba(190,210,235,${(metal * 0.32).toFixed(2)}) 0 46%, rgba(20,16,12,${(metal * 0.4).toFixed(2)}) 52% 100%)` : 'none';
  const glow = t.emissive ? { boxShadow: `0 0 14px 2px ${mix(t.emissive, 'transparent', 35)}, 0 0 4px ${t.emissive}` } : undefined;
  return <div className="ct-sphere" style={{ backgroundImage: `${spec}, ${env}, ${body}`, ...glow }} />;
}

function Strip({ bars }: { bars: number[] }): JSX.Element {
  const w = 100 / bars.length;
  return (
    <svg className="ct-wave" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
      {bars.map((b, i) => { const h = Math.max(1.5, b * 34); return <rect key={i} x={i * w + w * 0.18} y={20 - h / 2} width={w * 0.64} height={h} rx={w * 0.3} />; })}
    </svg>
  );
}

const DOTS: [number, number, number][] = [[50, 50, 15], [30, 34, 9], [68, 30, 8], [72, 62, 10], [32, 68, 8], [52, 22, 6], [20, 52, 5], [82, 44, 5]];

function Sparks({ colors }: { colors: string[] }): JSX.Element {
  const cs = colors.length ? colors : ['#8a919c'];
  return (
    <svg className="ct-vfx" viewBox="0 0 100 100" aria-hidden="true">
      <defs><radialGradient id="ctg" cx="50%" cy="50%" r="50%"><stop offset="0" stopColor={cs[0]} stopOpacity="0.5" /><stop offset="1" stopColor={cs[0]} stopOpacity="0" /></radialGradient></defs>
      <circle cx="50" cy="50" r="46" fill="url(#ctg)" />
      {DOTS.map(([x, y, r], i) => <circle key={i} cx={x} cy={y} r={r * 0.7} fill={cs[i % cs.length]} opacity={0.95 - i * 0.07} />)}
    </svg>
  );
}

function Figure({ colors }: { colors: string[] }): JSX.Element {
  const body = colors[0] ?? '#8a919c', accent = colors[1] ?? mix(body, '#000', 30);
  return (
    <svg className="ct-fig" viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="24" r="10" fill={colors[2] ?? body} />
      <path d="M30 88V50a8 8 0 0 1 8-8h24a8 8 0 0 1 8 8v38h-9V66h-4v22h-9V66h-4v22z" fill={body} />
      <rect x="27" y="48" width="8" height="26" rx="4" fill={accent} /><rect x="65" y="48" width="8" height="26" rx="4" fill={accent} />
    </svg>
  );
}

export const Thumb = memo(function Thumb({ kind, thumb }: { kind: string; thumb: ContentThumb | undefined }): JSX.Element {
  if (thumb?.type === 'material') return <div className="ct ct-mat"><Sphere t={thumb} /></div>;
  if (thumb?.type === 'look') {
    const [z, m, h] = thumb.sky;
    return <div className="ct ct-look" style={{ backgroundImage: `linear-gradient(180deg, ${z} 0%, ${m} 45%, ${h} 72%, ${thumb.fog} 100%)` }}><span style={{ background: `linear-gradient(180deg, transparent, ${thumb.fog})` }} /></div>;
  }
  if (thumb?.type === 'sound' && thumb.bars) return <div className="ct ct-snd"><Strip bars={thumb.bars} />{thumb.length > 0 && <small>{thumb.length.toFixed(thumb.length < 1 ? 2 : 1)} s</small>}</div>;
  if (thumb?.type === 'vfx') return <div className="ct ct-fx"><Sparks colors={thumb.colors} /></div>;
  if (thumb?.type === 'character') return <div className="ct ct-chr"><Figure colors={thumb.colors} /></div>;
  return <div className={`ct ct-ico ct-${kind.replace(/[^a-z-]/g, '')}`}><Icon name={iconOf(kind)} /></div>;
});
