// Clips: keyframed tracks (smooth Catmull-Rom curves through Euler keys), generated clips (a function of the loop
// phase with knobs), and the events on their timelines. Sampling writes into a Pose and allocates nothing.
import type { ClipDef } from '../schema/anim-set.ts';
import { Pose, type Skeleton } from './skeleton.ts';

export interface ClipEvent { name: string; /** Seconds into the clip. */ time: number }

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
  rotT: Float64Array; rotV: Float64Array;
  offT: Float64Array; offV: Float64Array;
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

export function evalCurve(times: Float64Array, vals: Float64Array, t: number, loop: boolean, length: number, smooth: boolean, out: Float64Array): void {
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
  if (!smooth) {
    for (let c = 0; c < 3; c++) out[c] = vals[a + c]! + (vals[b + c]! - vals[a + c]!) * s;
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
    return {
      name, length, loop, speed, travel, events: eventsOf(def, length, loop, where, problem),
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
  const tracks: Track[] = [];
  for (const [bone, tr] of Object.entries(def.tracks ?? {})) {
    const bi = skeleton.index(bone);
    if (bi < 0) {
      problem(`${where}/tracks/${bone}: the body has no bone "${bone}"; the track is ignored.`);
      continue;
    }
    const pack = (keys: readonly (readonly [number, readonly [number, number, number]])[] | undefined, scale: number): [Float64Array, Float64Array] => {
      if (!keys || keys.length === 0) return [new Float64Array(0), new Float64Array(0)];
      let list = [...keys].sort((a, b) => a[0] - b[0]);
      // A loop's last key at the very end would sit on top of the first one when it wraps; the first key stands for both.
      if (loop && list.length > 1 && list[list.length - 1]![0] >= length - 1e-9) list = list.slice(0, -1);
      const T = new Float64Array(list.length), V = new Float64Array(list.length * 3);
      list.forEach((k, i) => {
        T[i] = k[0];
        V[i * 3] = k[1][0] * scale; V[i * 3 + 1] = k[1][1] * scale; V[i * 3 + 2] = k[1][2] * scale;
      });
      return [T, V];
    };
    const [rotT, rotV] = pack(tr.rotation, 1);
    const [offT, offV] = pack(tr.offset, skeleton.scale);
    tracks.push({ bone: bi, rotT, rotV, offT, offV });
  }
  return {
    name, length, loop, speed, travel: def.travel ?? 0, events: eventsOf(def, length, loop, where, problem),
    sample(t, pose) {
      const tt = loop ? ((t % length) + length) % length : t;
      for (let i = 0; i < tracks.length; i++) {
        const tr = tracks[i]!;
        if (tr.rotT.length > 0) {
          evalCurve(tr.rotT, tr.rotV, tt, loop, length, smooth, _v);
          pose.setEuler(tr.bone, _v[0]!, _v[1]!, _v[2]!);
        }
        if (tr.offT.length > 0) {
          evalCurve(tr.offT, tr.offV, tt, loop, length, smooth, _v);
          pose.setOffset(tr.bone, _v[0]!, _v[1]!, _v[2]!);
        }
      }
    },
  };
}

/** Samples into a fresh pose; for tests and tools, not for the frame loop. */
export function sampleClip(clip: Clip, skeleton: Skeleton, t: number): Pose {
  const p = new Pose(skeleton.n);
  clip.sample(t, p);
  return p;
}
