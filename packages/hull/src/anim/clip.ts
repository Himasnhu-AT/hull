// Clips: keyframed tracks (smooth Catmull-Rom curves through Euler keys), generated clips (a function of the loop
// phase with knobs), and the events on their timelines. Sampling writes into a Pose and allocates nothing.
import type { ClipDef, Ease } from '../schema/anim-set.ts';
import { Pose, type Skeleton } from './skeleton.ts';

export interface ClipEvent { name: string; /** Seconds into the clip. */ time: number }

/** A named time range of a clip, in seconds: active from `start` up to (not including) `end`. */
export interface ClipWindow { name: string; start: number; end: number }

/**
 * Where a clip's root bone travels, taken out of the pose. `at` writes the travel since the clip's first moment as
 * x, y, z (metres, in the character's frame, already scaled for its height) and yaw (radians) into out[0..3].
 */
export interface ClipRoot {
  /** Index of the bone in the skeleton. */
  readonly bone: number;
  readonly turn: boolean;
  /** Travel from the start to the end of one pass. */
  readonly total: Readonly<Float64Array>;
  at(t: number, out: Float64Array): void;
}

export interface Clip {
  readonly name: string;
  /** Seconds of one pass at speed 1. */
  readonly length: number;
  readonly loop: boolean;
  /** Playback multiplier from the file. */
  readonly speed: number;
  /** Ground speed the feet are authored for (m/s); 0 if the clip does not travel. */
  readonly travel: number;
  /** Sorted by time. */
  readonly events: readonly ClipEvent[];
  /** Sorted by start. */
  readonly windows: readonly ClipWindow[];
  /** Null unless the file asks for root motion. */
  readonly root: ClipRoot | null;
  /** Writes the bones this clip moves into `pose` (call `pose.clear()` first). `t` is seconds; loops wrap, others clamp. */
  sample(t: number, pose: Pose): void;
}

export interface Generated {
  /** Seconds of one cycle. */
  length: number;
  /** Ground speed of the cycle in m/s, 0 if it stays in place. */
  travel: number;
  /** `phase` is 0 to 1 over one cycle. */
  sample(phase: number, pose: Pose): void;
}
export type GeneratorFactory = (skeleton: Skeleton, knobs: Readonly<Record<string, number>>) => Generated;

const generators = new Map<string, GeneratorFactory>();

/** A game can add its own generators; a clip names them in `generator` and gets a bench with sliders for its knobs. */
export function registerGenerator(name: string, make: GeneratorFactory): void {
  generators.set(name, make);
}
export function generatorNames(): string[] {
  return [...generators.keys()].sort();
}

interface Track {
  bone: number;
  rotT: Float64Array; rotV: Float64Array; rotE: Uint8Array;
  offT: Float64Array; offV: Float64Array; offE: Uint8Array;
}

/** 0 follows the clip's own curve. The rest are the names of `Ease`, in the order of EASE_CODE. */
const EASE_CODE: Record<Ease, number> = { smooth: 1, linear: 2, in: 3, out: 4, inOut: 5, snap: 6, hold: 7 };

/** Shapes the position s (0 to 1) along a segment. Plain function: no allocation. */
function shape(code: number, s: number): number {
  switch (code) {
    case 3: return s * s * s;
    case 4: { const u = 1 - s; return 1 - u * u * u; }
    case 5: return s * s * (3 - 2 * s);
    case 6: { const u = 1 - s; return 1 - u * u * u * u * u; }
    case 7: return s < 1 ? 0 : 1;
    default: return s;
  }
}

const _v = new Float64Array(3);

/**
 * Evaluates one vec3 curve at time t. With `smooth` the curve is a cubic Hermite spline with Catmull-Rom tangents
 * (so it passes through every key and has no kinks); a looping curve wraps from the last key to the first.
 */
// The index and time of key j, where j may run off either end (a wrap for loops, a clamp otherwise). Plain functions,
// not closures, so evaluating a curve allocates nothing.
function idx(j: number, n: number, loop: boolean): number {
  return loop ? ((j % n) + n) % n : j < 0 ? 0 : j >= n ? n - 1 : j;
}
function keyT(times: Float64Array, j: number, loop: boolean, length: number): number {
  const n = times.length;
  return loop ? times[idx(j, n, true)]! + Math.floor(j / n) * length : times[idx(j, n, false)]!;
}

export function evalCurve(times: Float64Array, vals: Float64Array, t: number, loop: boolean, length: number, smooth: boolean, out: Float64Array, ease: Uint8Array | null = null): void {
  const n = times.length;
  if (n === 1) { out[0] = vals[0]!; out[1] = vals[1]!; out[2] = vals[2]!; return; }
  let k: number;
  if (!loop) {
    if (t <= times[0]!) { out[0] = vals[0]!; out[1] = vals[1]!; out[2] = vals[2]!; return; }
    if (t >= times[n - 1]!) { const o = (n - 1) * 3; out[0] = vals[o]!; out[1] = vals[o + 1]!; out[2] = vals[o + 2]!; return; }
    k = 0;
    while (times[k + 1]! <= t) k++;
  } else {
    if (t < times[0]!) { t += length; k = n - 1; }
    else {
      k = n - 1;
      while (k > 0 && times[k]! > t) k--;
    }
  }
  const t1 = keyT(times, k, loop, length), t2 = keyT(times, k + 1, loop, length);
  const h = t2 - t1;
  const s = h > 1e-12 ? (t - t1) / h : 0;
  const a = idx(k, n, loop) * 3, b = idx(k + 1, n, loop) * 3;
  // The key at the start of a segment says how the curve leaves it: its own ease, or else the clip's.
  const code = ease === null ? 0 : ease[idx(k, n, loop)]!;
  const eased = code === 0 ? smooth : code === 1;
  if (!eased) {
    const f = code <= 2 ? s : shape(code, s);
    for (let c = 0; c < 3; c++) out[c] = vals[a + c]! + (vals[b + c]! - vals[a + c]!) * f;
    return;
  }
  const p0 = idx(k - 1, n, loop) * 3, p3 = idx(k + 2, n, loop) * 3;
  const d1 = t2 - keyT(times, k - 1, loop, length), d2 = keyT(times, k + 2, loop, length) - t1;
  const s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  for (let c = 0; c < 3; c++) {
    const m1 = d1 > 1e-12 ? (vals[b + c]! - vals[p0 + c]!) / d1 : 0;
    const m2 = d2 > 1e-12 ? (vals[p3 + c]! - vals[a + c]!) / d2 : 0;
    out[c] = h00 * vals[a + c]! + h10 * h * m1 + h01 * vals[b + c]! + h11 * h * m2;
  }
}

function eventsOf(def: ClipDef, length: number, loop: boolean, where: string, problem: (m: string) => void): ClipEvent[] {
  const out: ClipEvent[] = [];
  for (const [name, at] of Object.entries(def.events ?? {})) {
    for (const e of Array.isArray(at) ? at : [at]) {
      const time = loop ? e * length : e;
      if (time > length + 1e-9 || (loop && e > 1)) {
        problem(`${where}/events/${name}: ${e} is past the end of the clip (${loop ? 'loops use 0 to 1' : `${length} s`}); the event is dropped.`);
        continue;
      }
      out.push({ name, time });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

function windowsOf(def: ClipDef, length: number, loop: boolean, where: string, problem: (m: string) => void): ClipWindow[] {
  const out: ClipWindow[] = [];
  for (const [name, spec] of Object.entries(def.windows ?? {})) {
    const list: readonly (readonly [number, number])[] = typeof spec[0] === 'number' ? [spec as readonly [number, number]] : (spec as readonly (readonly [number, number])[]);
    list.forEach((r, i) => {
      const at = Array.isArray(spec[0]) ? `${where}/windows/${name}/${i}` : `${where}/windows/${name}`;
      const unit = loop ? length : 1;
      const start = r[0] * unit, end = r[1] * unit;
      if (!(r[1] > r[0])) { problem(`${at}: the window ends (${r[1]}) before it starts (${r[0]}); it is dropped.`); return; }
      if (end > length + 1e-9 || (loop && r[1] > 1)) {
        problem(`${at}: ends at ${r[1]}, past the end of the clip (${loop ? 'loops use 0 to 1' : `${length} s`}); it is cut at the end.`);
      }
      out.push({ name, start, end: Math.min(end, length) });
    });
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Builds a clip for a skeleton. Problems are reported by place, and the clip is skipped by returning null for a bad one. */
export function compileClip(name: string, def: ClipDef, skeleton: Skeleton, where: string, problem: (m: string) => void): Clip | null {
  if (def.type === 'gltf') {
    problem(`${where}: glTF clips are not supported yet; the clip "${name}" is skipped.`);
    return null;
  }
  const speed = def.speed ?? 1;
  if (def.type === 'generated') {
    const make = generators.get(def.generator ?? '');
    if (!make) {
      problem(`${where}/generator: "${def.generator ?? ''}" is not a known generator (known: ${generatorNames().join(', ')}).`);
      return null;
    }
    const g = make(skeleton, def.knobs ?? {});
    const length = def.length ?? g.length;
    const loop = def.loop ?? true;
    const travel = def.travel ?? (g.travel * g.length) / length;
    if (def.rootMotion) problem(`${where}/rootMotion: a generated clip stays in place; use its \`travel\` for stride matching. Root motion is ignored.`);
    return {
      name, length, loop, speed, travel, events: eventsOf(def, length, loop, where, problem), windows: windowsOf(def, length, loop, where, problem), root: null,
      sample(t, pose) {
        const ph = loop ? ((t / length) % 1 + 1) % 1 : Math.min(Math.max(t / length, 0), 1);
        g.sample(ph, pose);
      },
    };
  }

  const length = def.length;
  if (length === undefined) {
    problem(`${where}/length: a keyframe clip needs its length in seconds; "${name}" is skipped.`);
    return null;
  }
  const loop = def.loop ?? false;
  const smooth = (def.curve ?? 'smooth') === 'smooth';

  // Root motion: the root bone's x/z (or y) offset and, if asked, its yaw leave the pose and become travel.
  const rm = def.rootMotion === true ? {} : def.rootMotion === false || def.rootMotion === undefined ? null : def.rootMotion;
  let rootBone = -1;
  let rmx = 0, rmy = 0, rmz = 0;
  let rmTurn = false;
  if (rm) {
    const bn = rm.bone ?? 'hips';
    rootBone = skeleton.index(bn);
    if (rootBone < 0) problem(`${where}/rootMotion/bone: the body has no bone "${bn}"; root motion is off.`);
    const axes = rm.axes ?? 'xz';
    rmx = axes === 'y' ? 0 : 1; rmz = axes === 'y' ? 0 : 1; rmy = axes === 'xz' ? 0 : 1;
    rmTurn = rm.turn ?? false;
  }

  const tracks: Track[] = [];
  let root: ClipRoot | null = null;
  for (const [bone, tr] of Object.entries(def.tracks ?? {})) {
    const bi = skeleton.index(bone);
    if (bi < 0) {
      problem(`${where}/tracks/${bone}: the body has no bone "${bone}"; the track is ignored.`);
      continue;
    }
    const pack = (
      keys: readonly (readonly [number, readonly [number, number, number]] | readonly [number, readonly [number, number, number], Ease])[] | undefined,
      scale: number,
      dropLast: boolean,
    ): [Float64Array, Float64Array, Uint8Array] => {
      if (!keys || keys.length === 0) return [new Float64Array(0), new Float64Array(0), new Uint8Array(0)];
      let list = [...keys].sort((a, b) => a[0] - b[0]);
      // A loop's last key at the very end would sit on top of the first one when it wraps; the first key stands for both.
      if (dropLast && loop && list.length > 1 && list[list.length - 1]![0] >= length - 1e-9) list = list.slice(0, -1);
      const T = new Float64Array(list.length), V = new Float64Array(list.length * 3), E = new Uint8Array(list.length);
      list.forEach((k, i) => {
        T[i] = k[0];
        V[i * 3] = k[1][0] * scale; V[i * 3 + 1] = k[1][1] * scale; V[i * 3 + 2] = k[1][2] * scale;
        E[i] = (k as readonly [number, unknown, Ease?])[2] !== undefined ? EASE_CODE[(k as readonly [number, unknown, Ease])[2]] : 0;
      });
      return [T, V, E];
    };
    const [rotT, rotV, rotE] = pack(tr.rotation, 1, true);
    const [offT, offV, offE] = pack(tr.offset, skeleton.scale, true);
    tracks.push({ bone: bi, rotT, rotV, rotE, offT, offV, offE });
    if (bi === rootBone) {
      // The root path is read from the keys as written (the last key included), as a plain curve over one pass.
      const [rt, rv, re] = pack(tr.rotation, 1, false);
      const [ot, ov, oe] = pack(tr.offset, skeleton.scale, false);
      root = makeRoot(bi, ot, ov, oe, rt, rv, re, length, smooth, rmx, rmy, rmz, rmTurn);
    }
  }
  if (rm && rootBone >= 0 && !root) problem(`${where}/rootMotion: the clip has no track for "${skeleton.names[rootBone]}", so there is no travel to take out.`);
  const rmask = root !== null;
  const mx = rmx, my = rmy, mz = rmz;
  return {
    name, length, loop, speed, travel: def.travel ?? 0, events: eventsOf(def, length, loop, where, problem), windows: windowsOf(def, length, loop, where, problem), root,
    sample(t, pose) {
      const tt = loop ? ((t % length) + length) % length : t;
      for (let i = 0; i < tracks.length; i++) {
        const tr = tracks[i]!;
        const isRoot = rmask && tr.bone === rootBone;
        if (tr.rotT.length > 0) {
          evalCurve(tr.rotT, tr.rotV, tt, loop, length, smooth, _v, tr.rotE);
          pose.setEuler(tr.bone, _v[0]!, isRoot && rmTurn ? 0 : _v[1]!, _v[2]!);
        }
        if (tr.offT.length > 0) {
          evalCurve(tr.offT, tr.offV, tt, loop, length, smooth, _v, tr.offE);
          pose.setOffset(tr.bone, isRoot && mx === 1 ? 0 : _v[0]!, isRoot && my === 1 ? 0 : _v[1]!, isRoot && mz === 1 ? 0 : _v[2]!);
        }
      }
    },
  };
}

const _r = new Float64Array(3);

function makeRoot(
  bone: number, ot: Float64Array, ov: Float64Array, oe: Uint8Array, rt: Float64Array, rv: Float64Array, re: Uint8Array,
  length: number, smooth: boolean, mx: number, my: number, mz: number, turn: boolean,
): ClipRoot {
  const o0 = new Float64Array(3), r0 = new Float64Array(3);
  if (ot.length > 0) evalCurve(ot, ov, 0, false, length, smooth, o0, oe);
  if (rt.length > 0) evalCurve(rt, rv, 0, false, length, smooth, r0, re);
  const at = (t: number, out: Float64Array): void => {
    out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0;
    const tt = t < 0 ? 0 : t > length ? length : t;
    if (ot.length > 0) {
      evalCurve(ot, ov, tt, false, length, smooth, _r, oe);
      out[0] = (_r[0]! - o0[0]!) * mx; out[1] = (_r[1]! - o0[1]!) * my; out[2] = (_r[2]! - o0[2]!) * mz;
    }
    if (turn && rt.length > 0) {
      evalCurve(rt, rv, tt, false, length, smooth, _r, re);
      out[3] = _r[1]! - r0[1]!;
    }
  };
  const total = new Float64Array(4);
  at(length, total);
  return { bone, turn, total, at };
}

/** Samples into a fresh pose; for tests and tools, not for the frame loop. */
export function sampleClip(clip: Clip, skeleton: Skeleton, t: number): Pose {
  const p = new Pose(skeleton.n);
  clip.sample(t, p);
  return p;
}
