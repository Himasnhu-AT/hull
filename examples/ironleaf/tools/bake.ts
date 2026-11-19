// Samples keyed frames, solves each with the Rig, and writes the result as keyframe tracks (simplified, linear curve).
import { writeFileSync } from 'node:fs';
import { Rig, easeK, type Frame, type Key, type V3 } from './rig.ts';

export interface ClipSpec {
  length: number;
  keys: Key[];
  loop?: boolean;
  /** Keep the hips travel as root motion. */
  root?: boolean;
  windows?: Record<string, [number, number] | [number, number][]>;
  events?: Record<string, number | number[]>;
  /** Only these bones are written (an upper-body hold). */
  only?: string[];
  travel?: number;
}

const BONES = ['hips', 'spine', 'chest', 'neck', 'head', 'armL', 'forearmL', 'handL', 'armR', 'forearmR', 'handR', 'legL', 'shinL', 'footL', 'legR', 'shinR', 'footR'];
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

function wrap1(prev: number, v: number): number {
  while (v - prev > Math.PI) v -= 2 * Math.PI;
  while (v - prev < -Math.PI) v += 2 * Math.PI;
  return v;
}
/** The Euler triple equal to e that is nearest the previous one (XYZ has a second solution: pi - y with x and z turned half a circle). */
function nearest(p: V3, e: V3): V3 {
  const a: V3 = [wrap1(p[0], e[0]), wrap1(p[1], e[1]), wrap1(p[2], e[2])];
  const b: V3 = [wrap1(p[0], e[0] + Math.PI), wrap1(p[1], Math.PI - e[1]), wrap1(p[2], e[2] + Math.PI)];
  const da = Math.hypot(a[0] - p[0], a[1] - p[1], a[2] - p[2]), db = Math.hypot(b[0] - p[0], b[1] - p[1], b[2] - p[2]);
  return db < da - 1e-9 ? b : a;
}

/** Ramer-Douglas-Peucker on a vector series against its linear interpolation. */
function simplify(ts: number[], vs: number[][], tol: number): number[] {
  const keep = new Uint8Array(ts.length);
  keep[0] = 1; keep[ts.length - 1] = 1;
  const rec = (a: number, b: number): void => {
    let worst = -1, wi = -1;
    for (let i = a + 1; i < b; i++) {
      const k = (ts[i]! - ts[a]!) / (ts[b]! - ts[a]!);
      let e = 0;
      for (let c = 0; c < vs[i]!.length; c++) e = Math.max(e, Math.abs(vs[i]![c]! - (vs[a]![c]! + (vs[b]![c]! - vs[a]![c]!) * k)));
      if (e > worst) { worst = e; wi = i; }
    }
    if (worst > tol) { keep[wi] = 1; rec(a, wi); rec(wi, b); }
  };
  if (ts.length > 2) rec(0, ts.length - 1);
  const out: number[] = [];
  keep.forEach((k, i) => { if (k) out.push(i); });
  return out;
}

export interface Baked { def: Record<string, unknown>; tip: V3[]; basePts: V3[]; times: number[]; hips: V3[]; }

export function bake(rig: Rig, base: Frame, spec: ClipSpec, dt = 1 / 60): Baked {
  const res = rig.resolve(base, spec.keys);
  const n = Math.round(spec.length / dt);
  const times: number[] = [];
  for (let i = 0; i <= n; i++) times.push(Math.min(spec.length, i * dt));
  const bones = spec.only ?? BONES;
  const series: Record<string, V3[]> = {};
  for (const b of bones) series[b] = [];
  const hipsOff: V3[] = [];
  const tip: V3[] = [], basePts: V3[] = [];
  const eul: Record<string, V3> = {};
  for (const b of BONES) eul[b] = [0, 0, 0];
  for (const t of times) {
    rig.solve(rig.frameAt(res, t));
    const off = rig.euler(eul);
    hipsOff.push(off);
    for (const b of bones) {
      const arr = series[b]!;
      const e = eul[b]!;
      const p = arr[arr.length - 1];
      arr.push(p ? nearest(p, e) : [e[0], e[1], e[2]]);
    }
    const bl = rig.blade();
    tip.push(bl.tip); basePts.push(bl.base);
  }
  const tracks: Record<string, Record<string, unknown>> = {};
  for (const b of bones) {
    const s = series[b]!;
    const moved = s.some((v) => Math.abs(v[0]) + Math.abs(v[1]) + Math.abs(v[2]) > 0.004);
    if (!moved) continue;
    const idx = simplify(times, s, 0.012);
    const tr: Record<string, unknown> = { rotation: idx.map((i) => [r3(times[i]!), s[i]!.map(r3)]) };
    if (b === 'hips' && !spec.only) {
      const oi = simplify(times, hipsOff, 0.004);
      tr.offset = oi.map((i) => [r3(times[i]!), hipsOff[i]!.map((v) => r3(v / rig.sk.scale))]);
    }
    tracks[b] = tr;
  }
  const def: Record<string, unknown> = { type: 'keyframes', length: spec.length, loop: !!spec.loop, curve: 'linear', tracks };
  if (spec.windows) def.windows = spec.windows;
  if (spec.events) def.events = spec.events;
  if (spec.root) def.rootMotion = true;
  if (spec.travel) def.travel = spec.travel;
  return { def, tip, basePts, times, hips: hipsOff };
}

/** Blade tip speed profile: where the blade really sweeps (speed over a third of its peak) in seconds. */
export function sweepWindow(b: Baked): { start: number; end: number; peak: number } {
  const sp: number[] = [];
  for (let i = 1; i < b.tip.length; i++) {
    const dt = b.times[i]! - b.times[i - 1]!;
    sp.push(Math.hypot(b.tip[i]![0] - b.tip[i - 1]![0], b.tip[i]![1] - b.tip[i - 1]![1], b.tip[i]![2] - b.tip[i - 1]![2] - 0) / dt);
  }
  const peak = Math.max(...sp);
  let s = -1, e = -1;
  sp.forEach((v, i) => { if (v > peak * 0.4) { if (s < 0) s = b.times[i]!; e = b.times[i + 1]!; } });
  return { start: s, end: e, peak };
}

export function saveSet(file: string, note: string, clips: Record<string, unknown>): void {
  const lines: string[] = [];
  lines.push('{', '  "kind": "anim-set",', '  "note": ' + JSON.stringify(note) + ',', '  "clips": {');
  const names = Object.keys(clips);
  names.forEach((nm, ci) => {
    const c = clips[nm] as Record<string, unknown>;
    lines.push('    ' + JSON.stringify(nm) + ': {');
    const keys = Object.keys(c);
    keys.forEach((k, ki) => {
      const v = c[k];
      const tail = ki < keys.length - 1 ? ',' : '';
      if (k === 'tracks') {
        lines.push('      "tracks": {');
        const bs = Object.keys(v as object);
        bs.forEach((b, bi) => {
          const tr = (v as Record<string, Record<string, unknown>>)[b]!;
          lines.push('        ' + JSON.stringify(b) + ': {');
          const ch = Object.keys(tr);
          ch.forEach((cn, cj) => {
            lines.push('          ' + JSON.stringify(cn) + ': [' );
            const ks = tr[cn] as unknown[];
            ks.forEach((kk, kj) => lines.push('            ' + JSON.stringify(kk) + (kj < ks.length - 1 ? ',' : '')));
            lines.push('          ]' + (cj < ch.length - 1 ? ',' : ''));
          });
          lines.push('        }' + (bi < bs.length - 1 ? ',' : ''));
        });
        lines.push('      }' + tail);
      } else lines.push('      ' + JSON.stringify(k) + ': ' + JSON.stringify(v) + tail);
    });
    lines.push('    }' + (ci < names.length - 1 ? ',' : ''));
  });
  lines.push('  }', '}', '');
  writeFileSync(file, lines.join('\n'));
}

/** A stick-figure contact sheet (SVG): n frames of a clip, side view above and front view below, blade trail in red. */
export function sheetSvg(rig: Rig, base: Frame, spec: ClipSpec, title: string, n = 8): string {
  const res = rig.resolve(base, spec.keys);
  const cw = 170, ch = 250;
  const bonesPairs: [string, string][] = [['hips', 'spine'], ['spine', 'chest'], ['chest', 'neck'], ['neck', 'head'], ['chest', 'armL'], ['armL', 'forearmL'], ['forearmL', 'handL'], ['chest', 'armR'], ['armR', 'forearmR'], ['forearmR', 'handR'], ['hips', 'legL'], ['legL', 'shinL'], ['shinL', 'footL'], ['hips', 'legR'], ['legR', 'shinR'], ['shinR', 'footR']];
  let body = '';
  const trailAll: V3[] = [];
  const dt = 1 / 60;
  const N = Math.round(spec.length / dt);
  for (let i = 0; i <= N; i++) { rig.solve(rig.frameAt(res, i * dt)); trailAll.push(rig.blade().tip); }
  for (let view = 0; view < 2; view++) {
    for (let c = 0; c < n; c++) {
      const t = (c / (n - 1)) * spec.length;
      rig.solve(rig.frameAt(res, t));
      const hp = rig.at('hips');
      const ox = c * cw + cw / 2, oy = view * ch + ch - 22;
      const S = 78; // px per metre
      // side view: screen x = forward (the character faces right), front view: screen x = model x (her right on the left? no: mirror so right is on the right).
      const P = (p: V3): [number, number] => {
        const rx = p[0] - hp[0], rz = p[2] - hp[2];
        const sx = view === 0 ? -rz : -rx;
        return [ox + sx * S, oy - p[1] * S];
      };
      body += '<line x1="' + (ox - 80) + '" y1="' + oy + '" x2="' + (ox + 80) + '" y2="' + oy + '" stroke="#444" stroke-width="1"/>';
      const mkp = (nm: string): [number, number] => P(rig.at(nm));
      for (const [a, b] of bonesPairs) {
        const A = mkp(a), B = mkp(b);
        const col = /R$|R\d?$/.test(a + b) && !/hips|spine|chest|neck|head/.test(b) ? '#6fa8ff' : /L$/.test(b) ? '#e5c07b' : '#ccc';
        body += '<line x1="' + A[0].toFixed(1) + '" y1="' + A[1].toFixed(1) + '" x2="' + B[0].toFixed(1) + '" y2="' + B[1].toFixed(1) + '" stroke="' + col + '" stroke-width="3" stroke-linecap="round"/>';
      }
      const H = mkp('head');
      body += '<circle cx="' + H[0].toFixed(1) + '" cy="' + (H[1] - 8).toFixed(1) + '" r="9" fill="none" stroke="#ccc" stroke-width="2"/>';
      const bl = rig.blade();
      const bb = P(bl.base), bt = P(bl.tip);
      body += '<line x1="' + bb[0].toFixed(1) + '" y1="' + bb[1].toFixed(1) + '" x2="' + bt[0].toFixed(1) + '" y2="' + bt[1].toFixed(1) + '" stroke="#fff" stroke-width="4" stroke-linecap="round"/>';
      // trail: tip positions in the last quarter second, relative to the current hips
      const upto = Math.round(t / dt);
      const from = Math.max(0, upto - 14);
      let pts = '';
      for (let i = from; i <= upto; i++) { const q = P(trailAll[i]!); pts += q[0].toFixed(1) + ',' + q[1].toFixed(1) + ' '; }
      body += '<polyline points="' + pts + '" fill="none" stroke="#ff5a4a" stroke-width="1.6" opacity="0.8"/>';
      body += '<text x="' + (c * cw + 6) + '" y="' + (view * ch + 14) + '" fill="#888" font-size="11" font-family="monospace">' + t.toFixed(2) + 's</text>';
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + n * cw + '" height="' + (2 * ch + 22) + '" viewBox="0 -22 ' + n * cw + ' ' + (2 * ch + 22) + '"><rect x="0" y="-22" width="100%" height="100%" fill="#14161b"/><text x="6" y="-6" fill="#ddd" font-size="14" font-family="monospace">' + title + '</text>' + body + '</svg>';
}

export { easeK };
