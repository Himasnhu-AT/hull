// The state graph, drawn from the anim-graph file and lit from the running animator: the state a layer is in is
// outlined, its fill follows the blend weight, and a transition whose condition is true right now glows.

import { useMemo, type JSX } from 'react';
import type { Animator } from 'hull/anim';
import type { Engine } from './engine.ts';

interface Trans { from: string; to: string; when?: string | undefined; blend?: number | undefined }
interface Blend2d { x: string; y: string; points: { x: number; y: number; clip: string }[] }
interface StateDef { blend2d?: Blend2d; blend?: { by: string; points: Record<string, string> } }
interface LayerDef { states: Record<string, unknown>; transitions?: Trans[]; mask?: string[]; additive?: boolean; weight?: number; start?: string }
export interface GraphDef { layers: Record<string, LayerDef>; params?: Record<string, { min?: number; max?: number }> }

export interface LiveLayer {
  state: string; weights: Record<string, number>;
  /** How far through its clip the state is, 0 to 1. */
  progress?: number;
  /** Windows open on this layer now, and the weight of each clip of the state when it blends. */
  windows?: string[];
  clips?: Record<string, number>;
}
export interface Live { layers: Record<string, LiveLayer>; params: Record<string, number> }

/** One colour for a window name, the same everywhere. */
const WINDOW_HUES: Record<string, number> = { trace: 8, hit: 8, parry: 205, iframe: 150, cancel: 48, charge: 280, stun: 340 };
export const windowColor = (name: string): string => {
  let h = WINDOW_HUES[name];
  if (h === undefined) { h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360; }
  return `hsl(${h} 70% 58%)`;
};

const W = 480;
const NW = 78;
const NH = 26;

interface P { x: number; y: number }

/** Where a line from the centre of a node box towards `to` leaves the box. */
function edgePoint(c: P, to: P): P {
  const dx = to.x - c.x, dy = to.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const t = Math.min(dx === 0 ? Infinity : NW / 2 / Math.abs(dx), dy === 0 ? Infinity : NH / 2 / Math.abs(dy));
  return { x: c.x + dx * t, y: c.y + dy * t };
}

function layout(names: string[]): { pos: Record<string, P>; h: number } {
  const n = names.length;
  const pos: Record<string, P> = {};
  if (n === 1) { pos[names[0]!] = { x: W / 2, y: 52 }; return { pos, h: 104 }; }
  const h = n <= 3 ? 130 : n <= 5 ? 200 : 250;
  const rx = 190, ry = h / 2 - 34;
  names.forEach((nm, i) => {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    pos[nm] = { x: W / 2 + Math.cos(a) * rx, y: h / 2 + Math.sin(a) * ry };
  });
  return { pos, h };
}

/** A 2D blend space: the clips as dots on the plane (bigger as they weigh more), the parameters as a handle you drag. */
function BlendPad({ state, space, live, params, onParam, weights }: { state: string; space: Blend2d; live: Record<string, number>; params: GraphDef['params']; onParam(name: string, v: number): void; weights: Record<string, number> | undefined }): JSX.Element {
  const xs = space.points.map((p) => p.x), ys = space.points.map((p) => p.y);
  const lo = (n: string, v: number[]): number => params?.[n]?.min ?? Math.min(...v, 0);
  const hi = (n: string, v: number[]): number => params?.[n]?.max ?? Math.max(...v, 0);
  const x0 = lo(space.x, xs), x1 = Math.max(hi(space.x, xs), x0 + 0.01), y0 = lo(space.y, ys), y1 = Math.max(hi(space.y, ys), y0 + 0.01);
  const S = 150, M = 14;
  const px = (v: number): number => M + ((v - x0) / (x1 - x0)) * (S - 2 * M);
  const py = (v: number): number => S - M - ((v - y0) / (y1 - y0)) * (S - 2 * M);
  const set = (e: React.PointerEvent<SVGSVGElement>): void => {
    const r = e.currentTarget.getBoundingClientRect();
    const fx = ((e.clientX - r.left) / r.width) * S, fy = ((e.clientY - r.top) / r.height) * S;
    onParam(space.x, x0 + ((fx - M) / (S - 2 * M)) * (x1 - x0));
    onParam(space.y, y0 + ((S - M - fy) / (S - 2 * M)) * (y1 - y0));
  };
  const cx = live[space.x] ?? 0, cy = live[space.y] ?? 0;
  return (
    <div className="bpad">
      <div className="bb-dim" style={{ fontSize: 11.5 }}>{state}: <span className="mono">{space.x}</span> across, <span className="mono">{space.y}</span> up</div>
      <svg viewBox={`0 0 ${S} ${S}`} width={S} height={S} role="slider" aria-label={`Blend space ${state}`} aria-valuetext={`${space.x} ${cx.toFixed(2)}, ${space.y} ${cy.toFixed(2)}`}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); set(e); }} onPointerMove={(e) => { if (e.buttons) set(e); }}>
        <rect x={1} y={1} width={S - 2} height={S - 2} rx={8} className="pbg" />
        <line x1={px(0)} x2={px(0)} y1={M / 2} y2={S - M / 2} className="pax" />
        <line y1={py(0)} y2={py(0)} x1={M / 2} x2={S - M / 2} className="pax" />
        {space.points.map((p, i) => {
          const w = weights?.[p.clip] ?? 0;
          return (
            <g key={i}>
              <circle cx={px(p.x)} cy={py(p.y)} r={4 + w * 7} className="pdot" style={{ opacity: 0.35 + w * 0.65 }} />
              <text x={px(p.x)} y={py(p.y) - 10} textAnchor="middle" className="plab">{p.clip}</text>
            </g>
          );
        })}
        <circle cx={px(Math.min(x1, Math.max(x0, cx)))} cy={py(Math.min(y1, Math.max(y0, cy)))} r={5} className="pcur" />
      </svg>
    </div>
  );
}

function LayerCard({ name, def, live, test, params, allLive, onParam }: { name: string; def: LayerDef; live: LiveLayer | undefined; test: (when: string | undefined) => boolean; params: GraphDef['params']; allLive: Record<string, number>; onParam(name: string, v: number): void }): JSX.Element {
  const names = Object.keys(def.states);
  const { pos, h } = useMemo(() => layout(names), [names.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  const trans = def.transitions ?? [];
  const active = live?.state;
  const pairs = new Set(trans.map((t) => `${t.from}>${t.to}`));
  return (
    <div className="bcard gl">
      <h3>
        {name}
        {def.additive && <span className="tag2">additive {def.weight ?? 1}</span>}
        {def.mask && <span className="tag2" title={def.mask.join(', ')}>masked</span>}
      </h3>
      <svg viewBox={`0 0 ${W} ${h}`} role="img" aria-label={`State graph of layer ${name}`} style={{ width: '100%', height: h, display: 'block' }}>
        <defs>
          <marker id={`ar-${name}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="currentColor" /></marker>
        </defs>
        {trans.map((t, i) => {
          if (t.from === t.to) return null;
          const live1 = test(t.when);
          if (t.from === '*') {
            // From any state: a short stub arriving at the target from outside the ring.
            const b = pos[t.to];
            if (!b) return null;
            const cx = W / 2, cy = h / 2;
            const d = Math.hypot(b.x - cx, b.y - cy) || 1;
            const ux = (b.x - cx) / d, uy = (b.y - cy) / d;
            const to = edgePoint(b, { x: b.x + ux * 50, y: b.y + uy * 50 });
            const from = { x: to.x + ux * 22, y: to.y + uy * 22 };
            return <line key={i} className={`edge any${live1 ? ' fire' : ''}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} markerEnd={`url(#ar-${name})`}><title>any state to {t.to}: {t.when ?? 'always'}</title></line>;
          }
          const a = pos[t.from], b = pos[t.to];
          if (!a || !b) return null;
          const p0 = edgePoint(a, b), p1 = edgePoint(b, a);
          const two = pairs.has(`${t.to}>${t.from}`);
          const nx = -(p1.y - p0.y), ny = p1.x - p0.x;
          const nl = Math.hypot(nx, ny) || 1;
          const off = two ? 14 : 0;
          const cx = (p0.x + p1.x) / 2 + (nx / nl) * off, cy = (p0.y + p1.y) / 2 + (ny / nl) * off;
          const lit = t.from === active;
          return (
            <path key={i} className={`edge${lit ? ' from' : ''}${lit && live1 ? ' fire' : ''}`} d={`M${p0.x} ${p0.y} Q${cx} ${cy} ${p1.x} ${p1.y}`} fill="none" markerEnd={`url(#ar-${name})`}>
              <title>{t.from} to {t.to}: {t.when ?? 'always'}{t.blend !== undefined ? ` (${t.blend}s blend)` : ''}</title>
            </path>
          );
        })}
        {names.map((nm) => {
          const p = pos[nm]!;
          const wgt = live?.weights[nm] ?? 0;
          const on = nm === active;
          return (
            <g key={nm} className={`gnode${on ? ' on' : ''}`} transform={`translate(${p.x - NW / 2} ${p.y - NH / 2})`}>
              <rect width={NW} height={NH} rx={7} className="gbg" />
              <rect width={NW} height={NH} rx={7} className="gfill" style={{ opacity: Math.min(1, wgt) * 0.85 }} />
              <rect width={NW} height={NH} rx={7} className="gline" />
              <text x={NW / 2} y={NH / 2 + 4} textAnchor="middle">{nm}</text>
              {wgt > 0.005 && wgt < 0.995 && <text x={NW - 5} y={-3} textAnchor="end" className="gw">{Math.round(wgt * 100)}%</text>}
            </g>
          );
        })}
      </svg>
      {live && (
        <div className="lnow">
          <div className="lbar" title="How far through the clip"><i style={{ width: `${Math.round((live.progress ?? 0) * 100)}%` }} /></div>
          {live.clips && Object.keys(live.clips).length > 1 && (
            <div className="lclips">{Object.entries(live.clips).map(([c, w]) => <span key={c} style={{ opacity: 0.35 + w * 0.65 }}>{c} <b className="mono">{Math.round(w * 100)}%</b></span>)}</div>
          )}
          {(live.windows?.length ?? 0) > 0 && (
            <div className="bb-wlist">{live.windows!.map((w) => <span key={w} className="bb-wchip on" style={{ borderColor: windowColor(w) }}><i style={{ background: windowColor(w) }} />{w}</span>)}</div>
          )}
        </div>
      )}
      {Object.entries(def.states).map(([sn, sd]) => {
        const b = (sd as StateDef).blend2d;
        return b ? <BlendPad key={sn} state={sn} space={b} live={allLive} params={params} onParam={onParam} weights={sn === live?.state ? live.clips : undefined} /> : null;
      })}
    </div>
  );
}

export function GraphView({ eng, animator, def, live, onParam }: { eng: Engine; animator: Animator; def: GraphDef; live: Live | null; onParam(name: string, v: number): void }): JSX.Element {
  // A condition is compiled once per graph; it reads the parameters the animator holds right now.
  const conds = useMemo(() => {
    const m = new Map<string, (v: Float64Array) => number>();
    const rt = animator.graphRuntime;
    if (!rt) return m;
    for (const l of Object.values(def.layers)) for (const t of l.transitions ?? []) {
      if (t.when && !m.has(t.when)) { try { m.set(t.when, eng.anim.compileCondition(t.when, (n) => rt.paramIndexOf(n))); } catch { /* shown as a graph problem elsewhere */ } }
    }
    return m;
  }, [eng, animator, def]);
  const test = (when: string | undefined): boolean => {
    const rt = animator.graphRuntime;
    if (!rt) return false;
    if (!when) return true;
    const c = conds.get(when);
    return c ? c(rt.params) !== 0 : false;
  };
  return (
    <div className="gl-wrap">
      {Object.entries(def.layers).map(([n, l]) => <LayerCard key={n} name={n} def={l} live={live?.layers[n]} test={test} params={def.params} allLive={live?.params ?? {}} onParam={onParam} />)}
    </div>
  );
}
