// The state graph. Layers hold states (a clip, a 1D blend, or nothing); transitions move between them on
// conditions over named parameters and cross-fade by weight. `step` runs on the fixed step and fires clip events;
// `evaluate` runs per frame and only reads, blending the poses at a time between the last two steps.
import { isTracing, trace } from '../core/trace.ts';
import type { AnimGraph } from '../schema/anim-graph.ts';
import type { Clip, ClipWindow } from './clip.ts';
import { clamp } from './math.ts';
import { accumulate, composite, Pose, type Skeleton } from './skeleton.ts';

// ---- the condition language: numbers, parameter names, ! && || and the six comparisons ----

type Cond = (v: Float64Array) => number;

/** Compiles `speed > 0.3 && !grounded`. Parameter names may contain `-` (there is no arithmetic): `stone-1 && !broken`. Throws a sentence with the column of the mistake. */
export function compileCondition(src: string, param: (name: string) => number): Cond {
  const toks: { t: string; at: number }[] = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_.-]*)|(&&|\|\||==|!=|<=|>=|<|>|!|\(|\)))/y;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) {
      let at = pos;
      while (/\s/.test(src[at] ?? '')) at++;
      throw new Error(`unexpected "${src[at]}" at column ${at + 1} of "${src}"`);
    }
    toks.push({ t: m[1] ?? m[2] ?? m[3]!, at: m.index + m[0].length - (m[1] ?? m[2] ?? m[3]!).length });
    pos = re.lastIndex;
  }
  let i = 0;
  const fail = (what: string): never => {
    const at = toks[i]?.at ?? src.length;
    throw new Error(`${what} at column ${at + 1} of "${src}"`);
  };
  const atom = (): Cond => {
    const tk = toks[i];
    if (!tk) return fail('expected a value');
    i++;
    if (tk.t === '(') {
      const e = or();
      if (toks[i]?.t !== ')') fail('expected )');
      i++;
      return e;
    }
    if (/^\d/.test(tk.t)) { const n = Number(tk.t); return () => n; }
    if (tk.t === 'true') return () => 1;
    if (tk.t === 'false') return () => 0;
    if (/^[A-Za-z_]/.test(tk.t)) {
      const p = param(tk.t);
      if (p < 0) { i--; return fail(`unknown parameter "${tk.t}"`); }
      return (v) => v[p]!;
    }
    i--;
    return fail(`unexpected "${tk.t}"`);
  };
  const not = (): Cond => {
    if (toks[i]?.t === '!') { i++; const e = not(); return (v) => (e(v) === 0 ? 1 : 0); }
    return atom();
  };
  const cmp = (): Cond => {
    const a = not();
    const op = toks[i]?.t;
    if (op === '<' || op === '<=' || op === '>' || op === '>=' || op === '==' || op === '!=') {
      i++;
      const b = not();
      switch (op) {
        case '<': return (v) => (a(v) < b(v) ? 1 : 0);
        case '<=': return (v) => (a(v) <= b(v) ? 1 : 0);
        case '>': return (v) => (a(v) > b(v) ? 1 : 0);
        case '>=': return (v) => (a(v) >= b(v) ? 1 : 0);
        case '==': return (v) => (a(v) === b(v) ? 1 : 0);
        default: return (v) => (a(v) !== b(v) ? 1 : 0);
      }
    }
    return a;
  };
  const and = (): Cond => {
    let a = cmp();
    while (toks[i]?.t === '&&') { i++; const l = a, r = cmp(); a = (v) => (l(v) !== 0 && r(v) !== 0 ? 1 : 0); }
    return a;
  };
  const or = (): Cond => {
    let a = and();
    while (toks[i]?.t === '||') { i++; const l = a, r = and(); a = (v) => (l(v) !== 0 || r(v) !== 0 ? 1 : 0); }
    return a;
  };
  const e = or();
  if (i < toks.length) fail(`unexpected "${toks[i]!.t}"`);
  return e;
}

// ---- compiled graph ----

interface StateRT {
  name: string;
  clips: Clip[];
  /** Blend positions, ascending, one per clip. Empty for a single clip. */
  points: Float64Array;
  by: number;
  /** A 2D blend space: the two parameters and the position of each clip on their plane (empty for 1D). */
  by2: number;
  px: Float64Array;
  py: Float64Array;
  speedFrom: number;
  rate: number;
  exit: number;
  exitBlend: number;
}

interface TransRT { from: number; to: number; cond: Cond | null; blend: number; after: number; sync: boolean }

/** A window of a clip with the graph's number for its name. */
interface WinRT { id: number; start: number; end: number }

interface Entry { state: number; t: number; age: number; w: number; prevW: number; dur: number; adv: number; fresh: boolean }

interface LayerRT {
  name: string;
  states: StateRT[];
  trans: TransRT[];
  start: number;
  mask: Uint8Array | null;
  additive: boolean;
  weight: number;
  /** Parameter that scales the weight, or -1. */
  weightParam: number;
  entries: Entry[];
  /** Per window name: 1 while the layer's newest state is inside it (and the same a step ago). */
  win: Uint8Array;
  winPrev: Uint8Array;
  /** The clip that opened each window. */
  winClip: string[];
  count: number;
  pose: Pose;
}

const MAX_ENTRIES = 4;
const EPS = 1e-9;

export type EventSink = (name: string, clip: string, layer: string) => void;
/** Called when a window opens (`entering` true) or closes. */
export type WindowSink = (name: string, entering: boolean, clip: string, layer: string) => void;

export class Graph {
  readonly paramNames: string[] = [];
  readonly params: Float64Array;
  private readonly paramIndex = new Map<string, number>();
  private readonly isTrigger: Uint8Array;
  private readonly lo: Float64Array;
  private readonly hi: Float64Array;
  private readonly defaults: Float64Array;
  readonly layers: LayerRT[] = [];
  private readonly tmp: Pose;
  private readonly tmp2: Pose;
  private readonly w = new Float64Array(32);
  /** Every window name in the clips the graph can play, in a fixed order. */
  readonly windowNames: string[] = [];
  private readonly windowIndex = new Map<string, number>();
  private readonly clipWindows = new Map<Clip, WinRT[]>();
  /**
   * Root motion of the last fixed step: x, y, z (metres) and yaw (radians) in the character's frame, blended over the
   * layers and states the same way the pose is. Zero when no playing clip has root motion.
   */
  readonly rootDelta = new Float64Array(4);
  private readonly rd = new Float64Array(4);
  private readonly ra = new Float64Array(4);
  private readonly rb = new Float64Array(4);
  private readonly rc = new Float64Array(4);
  /** True when some clip the graph can play has root motion. */
  private hasRoot = false;
  private rootBone = -1;
  /** Foot slide of the layer that plays a speed-matched state, in m/s: |ground speed - what the feet cover|. */
  slide = 0;
  /** What the feet cover and what the game asked for (m/s), for the same layer. */
  stride = 0;
  speed = 0;
  /** Settings for IK, from the file. */
  readonly ik: NonNullable<AnimGraph['ik']>;

  /** What the "Just now" feed calls this graph and the node it moves; the animator sets them after building it. */
  traceId = '';
  traceNode: string | undefined;

  constructor(readonly def: AnimGraph, clips: ReadonlyMap<string, Clip>, readonly skeleton: Skeleton, where: string, problem: (m: string) => void) {
    this.ik = def.ik ?? {};
    for (const [name, p] of Object.entries(def.params ?? {})) {
      this.paramIndex.set(name, this.paramNames.length);
      this.paramNames.push(name);
      void p;
    }
    const n = this.paramNames.length;
    this.params = new Float64Array(n);
    this.defaults = new Float64Array(n);
    this.isTrigger = new Uint8Array(n);
    this.lo = new Float64Array(n).fill(-Infinity);
    this.hi = new Float64Array(n).fill(Infinity);
    this.paramNames.forEach((name, i) => {
      const p = def.params![name]!;
      this.isTrigger[i] = p.type === 'trigger' ? 1 : 0;
      const d = p.default;
      this.defaults[i] = typeof d === 'boolean' ? (d ? 1 : 0) : (d ?? 0);
      if (p.min !== undefined) this.lo[i] = p.min;
      if (p.max !== undefined) this.hi[i] = p.max;
    });
    this.tmp = new Pose(skeleton.n);
    this.tmp2 = new Pose(skeleton.n);
    const paramOf = (nm: string): number => this.paramIndex.get(nm) ?? -1;

    for (const [lname, l] of Object.entries(def.layers)) {
      const lw = `${where}/layers/${lname}`;
      const names = Object.keys(l.states);
      const states: StateRT[] = names.map((sn) => {
        const sd = l.states[sn]!;
        const sw = `${lw}/states/${sn}`;
        const st: StateRT = { name: sn, clips: [], points: new Float64Array(0), by: -1, by2: -1, px: new Float64Array(0), py: new Float64Array(0), speedFrom: -1, rate: sd.speed ?? 1, exit: -1, exitBlend: sd.exitBlend ?? 0.1 };
        const clipOf = (cn: string, at: string): Clip | undefined => {
          const c = clips.get(cn);
          if (!c) problem(`${at}: the anim-set has no clip "${cn}"; this state plays nothing.`);
          return c;
        };
        if (sd.blend) {
          st.by = paramOf(sd.blend.by);
          if (st.by < 0) problem(`${sw}/blend/by: no parameter "${sd.blend.by}"; the state plays its first clip.`);
          const pts = Object.entries(sd.blend.points).map(([k, v]) => [Number(k), v] as const).sort((a, b) => a[0] - b[0]);
          const cs: Clip[] = [];
          const ps: number[] = [];
          for (const [p, cn] of pts) {
            const c = clipOf(cn, `${sw}/blend/points/${p}`);
            if (c) { cs.push(c); ps.push(p); }
          }
          st.clips = cs;
          st.points = Float64Array.from(ps);
        } else if (sd.blend2d) {
          const b = sd.blend2d;
          st.by = paramOf(b.x);
          st.by2 = paramOf(b.y);
          if (st.by < 0) problem(`${sw}/blend2d/x: no parameter "${b.x}"; the state plays its first clip.`);
          if (st.by2 < 0) problem(`${sw}/blend2d/y: no parameter "${b.y}"; the state plays its first clip.`);
          const cs: Clip[] = [], xs: number[] = [], ys: number[] = [];
          b.points.forEach((p, pi) => {
            const c = clipOf(p.clip, `${sw}/blend2d/points/${pi}/clip`);
            if (c) { cs.push(c); xs.push(p.x); ys.push(p.y); }
          });
          st.clips = cs;
          st.px = Float64Array.from(xs);
          st.py = Float64Array.from(ys);
        } else if (sd.clip !== undefined) {
          const c = clipOf(sd.clip, `${sw}/clip`);
          if (c) st.clips = [c];
        }
        if (sd.speedFrom !== undefined) {
          st.speedFrom = paramOf(sd.speedFrom);
          if (st.speedFrom < 0) problem(`${sw}/speedFrom: no parameter "${sd.speedFrom}"; playback speed stays fixed.`);
        }
        return st;
      });
      names.forEach((sn, si) => {
        const ex = l.states[sn]!.exit;
        if (ex === undefined) return;
        const ti = names.indexOf(ex);
        if (ti < 0) problem(`${lw}/states/${sn}/exit: no state "${ex}"; the state never exits.`);
        else states[si]!.exit = ti;
      });
      const start = names.indexOf(l.start);
      if (start < 0) problem(`${lw}/start: no state "${l.start}"; starting at "${names[0] ?? ''}".`);
      const trans: TransRT[] = [];
      (l.transitions ?? []).forEach((t, ti) => {
        const tw = `${lw}/transitions/${ti}`;
        const from = t.from === '*' ? -1 : names.indexOf(t.from);
        const to = names.indexOf(t.to);
        if (t.from !== '*' && from < 0) return problem(`${tw}/from: no state "${t.from}"; the transition is skipped.`);
        if (to < 0) return problem(`${tw}/to: no state "${t.to}"; the transition is skipped.`);
        let cond: Cond | null = null;
        if (t.when !== undefined) {
          try { cond = compileCondition(t.when, paramOf); } catch (e) {
            return problem(`${tw}/when: ${e instanceof Error ? e.message : String(e)}; the transition is skipped.`);
          }
        }
        trans.push({ from, to, cond, blend: t.blend ?? 0.15, after: t.after ?? 0, sync: t.sync ?? false });
      });
      let mask: Uint8Array | null = null;
      if (l.mask) {
        mask = new Uint8Array(skeleton.n);
        l.mask.forEach((b, bi) => {
          if (skeleton.index(b) < 0) problem(`${lw}/mask/${bi}: the body has no bone "${b}"; it is ignored.`);
          else skeleton.subtree(b, mask!);
        });
      }
      const entries: Entry[] = [];
      for (let e = 0; e < MAX_ENTRIES; e++) entries.push({ state: 0, t: 0, age: 0, w: 0, prevW: 0, dur: 0, adv: 0, fresh: true });
      let weightParam = -1;
      if (l.weightFrom !== undefined) {
        weightParam = paramOf(l.weightFrom);
        if (weightParam < 0) problem(`${lw}/weightFrom: no parameter "${l.weightFrom}"; the layer keeps its weight.`);
      }
      this.layers.push({
        name: lname, states, trans, start: Math.max(start, 0), mask, additive: l.additive ?? false, weight: l.weight ?? 1, weightParam,
        entries, count: 1, pose: new Pose(skeleton.n), win: new Uint8Array(0), winPrev: new Uint8Array(0), winClip: [],
      });
    }
    // Windows: one number per name across every clip a state can play.
    for (const l of this.layers) {
      for (const st of l.states) {
        for (const c of st.clips) {
          if (this.clipWindows.has(c)) continue;
          const list: WinRT[] = [];
          for (const wd of c.windows as readonly ClipWindow[]) {
            let id = this.windowIndex.get(wd.name);
            if (id === undefined) { id = this.windowNames.length; this.windowNames.push(wd.name); this.windowIndex.set(wd.name, id); }
            list.push({ id, start: wd.start, end: wd.end });
          }
          this.clipWindows.set(c, list);
        }
      }
    }
    for (const l of this.layers) {
      l.win = new Uint8Array(this.windowNames.length); l.winPrev = new Uint8Array(this.windowNames.length);
      l.winClip = this.windowNames.map(() => '');
    }
    const rooted = [...this.clipWindows.keys()].find((c) => c.root !== null);
    this.hasRoot = rooted !== undefined;
    this.rootBone = rooted?.root?.bone ?? -1;
    this.reset();
  }

  paramIndexOf(name: string): number {
    return this.paramIndex.get(name) ?? -1;
  }

  /** Back to the start states and default parameters. */
  reset(): void {
    this.params.set(this.defaults);
    for (const l of this.layers) {
      l.count = 1;
      const e = l.entries[0]!;
      e.state = l.start; e.t = 0; e.age = 0; e.w = 1; e.prevW = 1; e.dur = 0; e.adv = 0; e.fresh = true;
    }
    this.slide = 0; this.stride = 0; this.speed = 0;
    this.rootDelta.fill(0);
    for (const l of this.layers) { l.win.fill(0); l.winPrev.fill(0); }
  }

  setParam(i: number, v: number): void {
    if (this.isTrigger[i] === 1) { this.params[i] = v ? 1 : 0; return; }
    this.params[i] = clamp(v, this.lo[i]!, this.hi[i]!);
  }

  /** Name of the state a layer is heading to. */
  stateName(layer: string): string | undefined {
    const l = this.layers.find((x) => x.name === layer);
    return l ? l.states[l.entries[l.count - 1]!.state]?.name : undefined;
  }

  /** Puts a layer straight into a state (no fade). Used to keep the state across a live rebuild. */
  setState(layer: string, state: string): void {
    const l = this.layers.find((x) => x.name === layer);
    const si = l ? l.states.findIndex((s) => s.name === state) : -1;
    if (!l || si < 0) return;
    this.begin(l, si, 0);
  }

  /** How far through its clip (or cycle) the newest state of a layer is, 0 to 1. For tools. */
  progress(layer: string): number {
    const l = this.layers.find((x) => x.name === layer);
    if (!l) return 0;
    const e = l.entries[l.count - 1]!;
    return this.phaseOf(l.states[e.state]!, e);
  }

  /** Weight of each state in a layer right now, by name (for tests and the bench). */
  weights(layer: string): Record<string, number> {
    const out: Record<string, number> = {};
    const l = this.layers.find((x) => x.name === layer);
    if (!l) return out;
    for (let i = 0; i < l.count; i++) {
      const e = l.entries[i]!;
      const nm = l.states[e.state]!.name;
      out[nm] = (out[nm] ?? 0) + e.w;
    }
    return out;
  }

  /** Plain numbers and names, in a fixed order: this goes into the checksum. */
  snapshot(): unknown[] {
    const out: unknown[] = [Array.from(this.params)];
    for (const l of this.layers) {
      const es: unknown[] = [];
      for (let i = 0; i < l.count; i++) {
        const e = l.entries[i]!;
        es.push(l.states[e.state]!.name, e.t, e.age, e.w);
      }
      out.push(es);
    }
    return out;
  }

  // ---- fixed step ----

  step(dt: number, emit: EventSink | null, emitWindow: WindowSink | null = null): void {
    let slide = -1;
    const root = this.rootDelta;
    root.fill(0);
    for (let li = 0; li < this.layers.length; li++) {
      const l = this.layers[li]!;
      this.transitions(l);
      const newest = l.count - 1;
      const lr = this.ra;
      lr.fill(0);
      let rootCov = 0;
      for (let i = 0; i < l.count; i++) {
        const e = l.entries[i]!;
        e.prevW = e.w;
        this.advance(l, e, dt, i === newest ? emit : null);
        // This entry's travel, weighted like its pose; an entry with no clip says nothing about the root.
        if (this.hasRoot && l.states[e.state]!.clips.length > 0) {
          for (let k = 0; k < 4; k++) lr[k] = lr[k]! + this.rd[k]! * e.w;
          rootCov += e.w;
        }
        if (i === newest) {
          const st = l.states[e.state]!;
          if (st.speedFrom >= 0 && slide < 0) {
            const info = this.pace(st);
            this.speed = this.params[st.speedFrom]!;
            this.stride = info.travel * info.rate;
            slide = Math.abs(this.speed - this.stride);
          }
        }
      }
      this.fade(l, dt);
      if (this.hasRoot && rootCov > 0 && (l.mask === null || l.mask[this.rootBone] === 1)) {
        // A state that has a clip but no root motion stands still, with its weight. A layer lays itself over what is
        // below it, like its pose does; an additive one adds.
        const cov = Math.min(1, rootCov) * l.weight * (l.weightParam >= 0 ? clamp(this.params[l.weightParam]!, 0, 1) : 1);
        const norm = 1 / rootCov;
        for (let k = 0; k < 4; k++) root[k] = l.additive ? root[k]! + lr[k]! * norm * cov : root[k]! * (1 - cov) + lr[k]! * norm * cov;
      }
      this.updateWindows(l, emitWindow);
    }
    this.slide = slide < 0 ? 0 : slide;
    for (let i = 0; i < this.isTrigger.length; i++) if (this.isTrigger[i] === 1) this.params[i] = 0;
  }

  private transitions(l: LayerRT): void {
    const cur = l.entries[l.count - 1]!;
    const trs = l.trans;
    for (let i = 0; i < trs.length; i++) {
      const t = trs[i]!;
      if (t.from >= 0 && t.from !== cur.state) continue;
      if (t.from < 0 && t.to === cur.state) continue;
      if (t.after > 0 && cur.age < t.after - EPS) continue;
      if (t.cond !== null && t.cond(this.params) === 0) continue;
      this.note(l, t.to);
      this.begin(l, t.to, t.blend, t.sync);
      return;
    }
    const st = l.states[cur.state]!;
    if (st.exit >= 0 && st.clips.length === 1 && !st.clips[0]!.loop && cur.t >= st.clips[0]!.length - EPS) { this.note(l, st.exit); this.begin(l, st.exit, st.exitBlend); }
  }

  /** The hook for the "Just now" feed: a state change decided by the graph (not a live rebuild putting a state back), once per change. */
  private note(l: LayerRT, to: number): void {
    if (isTracing()) trace('anim', `${this.traceId}#${l.states[to]!.name}`, this.traceNode);
  }

  /** Where in its cycle a state is, 0 to 1 (a clip that plays once reports how far through it is). */
  private phaseOf(st: StateRT, e: Entry): number {
    const n = st.clips.length;
    if (n === 0) return 0;
    if (n === 1 && st.points.length === 0) {
      const c = st.clips[0]!;
      return c.loop ? ((e.t / c.length) % 1 + 1) % 1 : Math.min(1, e.t / c.length);
    }
    return e.t;
  }

  private begin(l: LayerRT, to: number, blend: number, sync = false): void {
    // A synced fade starts the new state where the old one is in its cycle (both should be cycles: walk into run).
    let phase = -1;
    if (sync && blend > 0) {
      const cur = l.entries[l.count - 1]!;
      phase = this.phaseOf(l.states[cur.state]!, cur);
    }
    if (blend <= 0) {
      l.count = 1;
      const e = l.entries[0]!;
      e.state = to; e.t = 0; e.age = 0; e.w = 1; e.prevW = 1; e.dur = 0; e.adv = 0; e.fresh = true;
      return;
    }
    if (l.count === MAX_ENTRIES) {
      // Too many fades in flight: the oldest gives way. Its weight is shared out again by `fade`.
      const first = l.entries[0]!;
      for (let i = 0; i < l.count - 1; i++) l.entries[i] = l.entries[i + 1]!;
      l.entries[l.count - 1] = first;
      l.count--;
    }
    const e = l.entries[l.count]!;
    e.state = to; e.t = 0; e.age = 0; e.w = 0; e.prevW = 0; e.dur = blend; e.adv = 0; e.fresh = true;
    const ns = l.states[to]!;
    if (phase >= 0 && ns.clips.length > 0) {
      e.t = ns.clips.length === 1 && ns.points.length === 0 ? phase * ns.clips[0]!.length : phase;
      e.fresh = false;
    }
    l.count++;
  }

  /** Raises the newest state's weight and shares the rest among the others. */
  private fade(l: LayerRT, dt: number): void {
    const n = l.count;
    const newest = l.entries[n - 1]!;
    if (n === 1) { newest.w = 1; return; }
    newest.w = newest.dur > 0 ? Math.min(1, newest.w + dt / newest.dur) : 1;
    let others = 0;
    for (let i = 0; i < n - 1; i++) others += l.entries[i]!.w;
    const want = 1 - newest.w;
    const k = others > 0 ? want / others : 0;
    // Entries that have faded out are swapped behind the kept ones, which keep their order.
    let keep = 0;
    for (let i = 0; i < n; i++) {
      const e = l.entries[i]!;
      if (i < n - 1) e.w *= k;
      if (i === n - 1 || e.w > EPS) {
        if (keep !== i) { l.entries[i] = l.entries[keep]!; l.entries[keep] = e; }
        keep++;
      }
    }
    l.count = keep;
  }

  private advance(l: LayerRT, e: Entry, dt: number, emit: EventSink | null): void {
    const st = l.states[e.state]!;
    e.age += dt;
    const nClips = st.clips.length;
    this.rd.fill(0);
    if (nClips === 0) { e.t += dt; e.adv = dt; e.fresh = false; return; }
    const info = this.pace(st);
    const t0 = e.fresh ? -1e-7 : e.t;
    if (nClips === 1 && st.points.length === 0) {
      const c = st.clips[0]!;
      const adv = dt * info.rate;
      const t1 = e.t + adv;
      if (emit) this.fire(c, t0, t1, c.loop, 1, c.length, emit, l.name);
      if (this.hasRoot && c.root) this.rootAcc(c, e.t, t1, 1);
      e.adv = adv;
      e.t = c.loop && t1 >= c.length ? t1 % c.length : t1;
    } else {
      // A blend plays on a shared phase (cycles), so a walk and a run keep their feet in step.
      const adv = (dt * info.rate) / info.length;
      const t1 = e.t + adv;
      if (emit) {
        const dom = this.dominant(st);
        this.fire(dom, t0, t1, true, 1 / dom.length, 1, emit, l.name);
      }
      if (this.hasRoot) {
        const w = this.w;
        this.weightsOf(st, w);
        for (let i = 0; i < nClips; i++) {
          const c = st.clips[i]!;
          if (c.root && w[i]! > 0) this.rootAcc(c, e.t * c.length, t1 * c.length, w[i]!);
        }
      }
      e.adv = adv;
      e.t = t1 % 1;
    }
    e.fresh = false;
  }

  /** Adds the travel of `c` between two clip times (seconds, not wrapped), times `w`, into `rd`. */
  private rootAcc(c: Clip, tA: number, tB: number, w: number): void {
    this.cumRoot(c, tA, this.rb);
    this.cumRoot(c, tB, this.rc);
    for (let k = 0; k < 4; k++) this.rd[k] = this.rd[k]! + (this.rc[k]! - this.rb[k]!) * w;
  }

  private cumRoot(c: Clip, t: number, out: Float64Array): void {
    const r = c.root!;
    if (c.loop && t >= c.length) {
      const n = Math.floor(t / c.length);
      r.at(t - n * c.length, out);
      for (let k = 0; k < 4; k++) out[k] = out[k]! + r.total[k]! * n;
    } else r.at(t, out);
  }

  /** Opens and closes the layer's windows to match the clip time its newest state is at, and tells the sink. */
  private updateWindows(l: LayerRT, sink: WindowSink | null): void {
    const n = l.win.length;
    if (n === 0) return;
    const prev = l.win;
    l.win = l.winPrev;
    l.winPrev = prev;
    const now = l.win;
    now.fill(0);
    const e = l.entries[l.count - 1]!;
    const st = l.states[e.state]!;
    let clip: Clip | null = null;
    let tt = 0;
    if (st.clips.length === 1 && st.points.length === 0) { clip = st.clips[0]!; tt = e.t; }
    else if (st.clips.length > 0) { clip = this.dominant(st); tt = e.t * clip.length; }
    if (clip) {
      const list = this.clipWindows.get(clip);
      if (list) {
        for (let i = 0; i < list.length; i++) {
          const w = list[i]!;
          if (tt + EPS >= w.start && tt < w.end - EPS) {
            if (now[w.id] === 0) l.winClip[w.id] = clip.name;
            now[w.id] = 1;
          }
        }
      }
    }
    if (sink === null) return;
    for (let i = 0; i < n; i++) {
      if (now[i] !== prev[i]) sink(this.windowNames[i]!, now[i] === 1, l.winClip[i]!, l.name);
    }
  }

  /** True while any layer's newest state is inside the window. */
  inWindow(name: string, layer?: string): boolean {
    const id = this.windowIndex.get(name);
    if (id === undefined) return false;
    for (let i = 0; i < this.layers.length; i++) {
      const l = this.layers[i]!;
      if (layer !== undefined && l.name !== layer) continue;
      if (l.win[id] === 1) return true;
    }
    return false;
  }

  /** Names of the windows that are open now (for tools; it allocates). */
  openWindows(layer?: string): string[] {
    const out: string[] = [];
    this.windowNames.forEach((nm) => { if (this.inWindow(nm, layer)) out.push(nm); });
    return out;
  }

  /** Events with times in (t0, t1], in the units of t (seconds, or cycles for a blend). No event is missed or doubled. */
  private fire(c: Clip, t0: number, t1: number, loop: boolean, evScale: number, period: number, emit: EventSink, layer: string): void {
    const evs = c.events;
    for (let i = 0; i < evs.length; i++) {
      const ev = evs[i]!;
      const at = ev.time * evScale;
      if (loop) {
        const m0 = Math.floor((t0 + EPS - at) / period) + 1;
        const m1 = Math.floor((t1 + EPS - at) / period);
        for (let m = m0; m <= m1; m++) emit(ev.name, c.name, layer);
      } else if (at > t0 + EPS && at <= t1 + EPS) {
        emit(ev.name, c.name, layer);
      }
    }
  }

  // ---- blend arithmetic ----

  private pace(st: StateRT): { length: number; travel: number; rate: number } {
    const w = this.w;
    const n = st.clips.length;
    this.weightsOf(st, w);
    let length = 0, travel = 0, spd = 0;
    for (let i = 0; i < n; i++) {
      const c = st.clips[i]!;
      length += w[i]! * c.length;
      travel += w[i]! * c.travel;
      spd += w[i]! * c.speed;
    }
    let rate = st.rate * (n > 0 ? spd : 1);
    if (st.speedFrom >= 0 && travel > 0) rate = clamp(this.params[st.speedFrom]! / travel, 0.5, 1.6) * st.rate;
    paceOut.length = length; paceOut.travel = travel; paceOut.rate = rate;
    return paceOut;
  }

  /** Weight of each clip of a state: all on the one clip, or linear between the two points the parameter lies between. */
  private weightsOf(st: StateRT, w: Float64Array): void {
    const n = st.clips.length;
    if (st.px.length > 0 && n > 1) {
      if (st.by < 0 || st.by2 < 0) { w.fill(0, 0, n); w[0] = 1; return; }
      // Inverse distance, to the fourth power: a clip dominates near its own point and two neighbours share between them.
      const vx = this.params[st.by]!, vy = this.params[st.by2]!;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const dx = vx - st.px[i]!, dy = vy - st.py[i]!;
        const d2 = dx * dx + dy * dy;
        if (d2 < 1e-10) { w.fill(0, 0, n); w[i] = 1; return; }
        w[i] = 1 / (d2 * d2);
        sum += w[i]!;
      }
      for (let i = 0; i < n; i++) w[i] = w[i]! / sum;
      return;
    }
    if (n === 1 || st.by < 0) { w.fill(0, 0, n); if (n > 0) w[0] = 1; return; }
    const v = this.params[st.by]!;
    const p = st.points;
    w.fill(0, 0, n);
    if (v <= p[0]!) { w[0] = 1; return; }
    if (v >= p[n - 1]!) { w[n - 1] = 1; return; }
    let k = 0;
    while (p[k + 1]! < v) k++;
    const f = (v - p[k]!) / (p[k + 1]! - p[k]!);
    w[k] = 1 - f; w[k + 1] = f;
  }

  private dominant(st: StateRT): Clip {
    const w = this.w;
    this.weightsOf(st, w);
    let best = 0;
    for (let i = 1; i < st.clips.length; i++) if (w[i]! > w[best]!) best = i;
    return st.clips[best]!;
  }

  /** What a state's clip weights are right now, by clip name (for tests and the bench). */
  clipWeights(layer: string, state: string): Record<string, number> {
    const l = this.layers.find((x) => x.name === layer);
    const st = l?.states.find((s) => s.name === state);
    const out: Record<string, number> = {};
    if (!st) return out;
    const w = new Float64Array(st.clips.length);
    this.weightsOf(st, w);
    st.clips.forEach((c, i) => { out[c.name] = w[i]!; });
    return out;
  }

  /** Foot slide at a given ground speed for a state, without running the graph (for the bench's slide curve). */
  slideAt(layer: string, state: string, speed: number): number {
    const l = this.layers.find((x) => x.name === layer);
    const st = l?.states.find((s) => s.name === state);
    if (!st || st.speedFrom < 0) return 0;
    const keep = this.params[st.speedFrom]!;
    this.params[st.speedFrom] = speed;
    const info = this.pace(st);
    const out = Math.abs(speed - info.travel * info.rate);
    this.params[st.speedFrom] = keep;
    return out;
  }

  // ---- per frame ----

  /** Blends everything into `out` at a time `alpha` of the way from the last step to this one. */
  evaluate(alpha: number, out: Pose): void {
    out.setRest();
    for (let li = 0; li < this.layers.length; li++) {
      const l = this.layers[li]!;
      const lp = l.pose;
      lp.clear();
      let total = 0;
      for (let i = 0; i < l.count; i++) { const e = l.entries[i]!; total += e.prevW + (e.w - e.prevW) * alpha; }
      if (total <= 0) total = 1;
      for (let i = 0; i < l.count; i++) {
        const e = l.entries[i]!;
        const w = (e.prevW + (e.w - e.prevW) * alpha) / total;
        if (w <= 0) continue;
        this.evalEntry(l, e, alpha, this.tmp);
        accumulate(lp, this.tmp, w);
      }
      composite(out, lp, l.mask, l.weightParam >= 0 ? l.weight * clamp(this.params[l.weightParam]!, 0, 1) : l.weight, l.additive);
    }
  }

  /** Pose of one state at its own time, into `dst` (which is cleared first). */
  private evalEntry(l: LayerRT, e: Entry, alpha: number, dst: Pose): void {
    dst.clear();
    const st = l.states[e.state]!;
    const n = st.clips.length;
    if (n === 0) return;
    const t = e.t - (1 - alpha) * e.adv;
    if (n === 1 && st.points.length === 0) { st.clips[0]!.sample(t, dst); return; }
    const w = this.w;
    this.weightsOf(st, w);
    const s = this.tmp2;
    for (let i = 0; i < n; i++) {
      const wi = w[i]!;
      if (wi <= 0) continue;
      const c = st.clips[i]!;
      s.clear();
      c.sample(t * c.length, s);
      accumulate(dst, s, wi);
    }
  }
}

const paceOut = { length: 1, travel: 0, rate: 1 };
