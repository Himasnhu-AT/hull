// Shared by the perf scripts: turns a V8 sampling profile into "where the time goes", by subsystem and by function.
// The same reading serves Node (perf-aott.ts, file URLs) and the dev page in a browser (perf-frame.ts, where the game
// is served from /src/, Hull from /@fs/.../packages/hull/src/ and three.js from Vite's pre-bundled deps).

export interface ProfileNode { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; }
export interface CpuProfile { nodes: ProfileNode[]; samples?: number[]; timeDeltas?: number[]; }
export interface Where { subsystems: Record<string, number>; top: { fn: string; at: string; ms: number }[] }

const r4 = (v: number): number => Math.round(v * 10000) / 10000;

/** three.js functions that are its transform hierarchy: the cost plan-rust.md section 7 calls out of a kernel's reach. */
const TRANSFORMS = new Set(['updateMatrixWorld', 'updateWorldMatrix', 'updateMatrix', 'compose', 'decompose', 'multiplyMatrices', 'multiply', 'premultiply', 'setFromRotationMatrix', 'makeRotationFromQuaternion', 'setFromEuler', '_onChangeCallback', 'setFromQuaternion']);

/** The path of a game source file inside its project's src/, or undefined when the URL is not the game's. */
function gamePath(url: string): string | undefined {
  const node = url.split('/examples/aott/src/')[1];
  if (node !== undefined) return node;
  const m = /^https?:\/\/[^/]+\/src\/(.*)$/.exec(url);
  return m ? m[1] : undefined;
}

/** The subsystem a sampled function belongs to, by the file it lives in. */
export function bucket(url: string, fn: string): string {
  if (fn === '(garbage collector)') return 'garbage collector';
  if (fn === '(program)') return 'browser and natives';
  if (/[/_]three[./_]/.test(url) || url.includes('/three/')) return TRANSFORMS.has(fn) ? 'three.js transforms' : 'three.js, the rest';
  const hull = url.split('/packages/hull/src/')[1];
  if (hull !== undefined) {
    const dir = hull.split('/')[0]!;
    return dir === 'physics' || dir === 'anim' || dir === 'vfx' || dir === 'audio' || dir === 'kits' || dir === 'render' || dir === 'ui' ? 'hull ' + dir : 'hull core and the rest';
  }
  const game = gamePath(url);
  if (game !== undefined) {
    if (game.startsWith('titans/')) return 'game: titans';
    if (game.startsWith('player/')) return 'game: soldier, comrades, horses';
    if (game.startsWith('npc/')) return 'game: civilians';
    if (game.startsWith('core/collision')) return 'game: collision wrapper';
    if (game.startsWith('fx/')) return 'game: effects';
    if (game.startsWith('ui/')) return 'game: hud';
    return 'game: the rest';
  }
  return 'browser and natives';
}

/**
 * Shares of the sampled time by subsystem and by function, turned into milliseconds with `ms`, the time one unit of
 * work (a step, a frame) took when no profiler was attached. `keepProgram` counts the samples V8 files under
 * "(program)" (native work with no JavaScript frame: in a browser, style and GPU command work); a Node run leaves
 * them out, where they are the profiler's own bookkeeping.
 */
export function attribute(p: CpuProfile, ms: number, keepProgram = false): Where {
  const byId = new Map<number, ProfileNode>();
  for (const n of p.nodes) byId.set(n.id, n);
  const sub = new Map<string, number>(), fns = new Map<string, number>();
  let total = 0;
  const samples = p.samples ?? [], deltas = p.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) {
    const f = byId.get(samples[i]!)!.callFrame, dt = deltas[i] ?? 0;
    if (f.functionName === '(idle)' || f.functionName === '(root)') continue;
    if (f.functionName === '(program)' && !keepProgram) continue;
    // The profiler's own calls (node:inspector) are not the game's.
    if (f.url.startsWith('node:inspector')) continue;
    total += dt;
    const b = bucket(f.url, f.functionName);
    sub.set(b, (sub.get(b) ?? 0) + dt);
    const at = f.url.replace(/^.*\/(packages\/hull\/src|examples\/aott\/src|node_modules|\.vite\/deps)\//, '').replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, '') + ':' + (f.lineNumber + 1);
    const key = (f.functionName || '(anonymous)') + ' ' + at;
    fns.set(key, (fns.get(key) ?? 0) + dt);
  }
  const k = total > 0 ? ms / total : 0;
  const subsystems: Record<string, number> = {};
  for (const [name, t] of [...sub].sort((a, b) => b[1] - a[1])) subsystems[name] = r4(t * k);
  const top = [...fns].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([key, t]) => {
    const cut = key.indexOf(' ');
    return { fn: key.slice(0, cut), at: key.slice(cut + 1), ms: r4(t * k) };
  });
  return { subsystems, top };
}
