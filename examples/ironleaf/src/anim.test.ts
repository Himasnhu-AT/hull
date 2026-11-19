/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';
import { Graph, Pose, buildBody, compileClip, sampleClip, type Clip } from 'hull/anim';
import { config } from 'hull';
import type { AnimGraph } from 'hull/schema';
import { projectSources } from 'hull/kits/testing';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

// Every clip GAME.md names for Aya (sections 4 and 5, the standoff, the finishers) and for the raiders (section 6).
const AYA = [
  'idle-stone', 'idle-water', 'idle-wind', 'hold-stone', 'hold-water', 'hold-wind', 'guard-stone', 'guard-water', 'guard-wind', 'walk', 'run',
  'stone-1', 'stone-2', 'stone-3', 'stone-heavy', 'stone-charge', 'water-1', 'water-2', 'water-3', 'water-4', 'water-heavy', 'water-charge',
  'wind-1', 'wind-2', 'wind-heavy', 'wind-charge', 'finisher-stone', 'finisher-water', 'finisher-wind', 'deflect', 'riposte', 'block',
  'dodge-l', 'dodge-r', 'dodge-back', 'roll', 'draw', 'sheathe', 'sheathed', 'standoff', 'quickdraw', 'hit-light', 'hit-heavy', 'stagger', 'guard-broken', 'broken', 'death',
];
const RAIDER = [
  'idle', 'walk', 'run', 'hold-sword', 'hold-spear', 'hold-hulk', 'hold-bow', 'hold-duel', 'sword-cut', 'sword-cross', 'sword-feint', 'spear-thrust', 'spear-sweep',
  'hulk-smash', 'hulk-grab', 'bow-shoot', 'duel-cut', 'duel-thrust', 'duel-sweep', 'duel-rush', 'duel-phase', 'back-step', 'hit', 'stagger', 'death',
];

interface Kit { name: string; set: string; clips: Map<string, Clip>; sk: ReturnType<typeof buildBody>['skeleton']; graph: AnimGraph }

function kit(character: string): Kit {
  const def = config.lookup('character', character) as unknown as { body: never; animSet: string; animGraph: string };
  const sk = buildBody(def.body).skeleton;
  const setName = def.animSet.replace('anim-set/', '');
  const set = config.lookup('anim-set', setName) as unknown as { clips: Record<string, never> };
  const problems: string[] = [];
  const clips = new Map<string, Clip>();
  for (const [n, d] of Object.entries(set.clips)) {
    const c = compileClip(n, d, sk, 'anim-set/' + setName + '#/clips/' + n, (m) => problems.push(m));
    if (c) clips.set(n, c);
  }
  expect(problems).toEqual([]);
  return { name: character, set: setName, clips, sk, graph: config.lookup('anim-graph', def.animGraph.replace('anim-graph/', '')) as unknown as AnimGraph };
}

/** Where the blade tip is (hand joint plus 0.91 along its -Y, in model space) for a pose. */
const mq = new Float64Array(64 * 4), mp = new Float64Array(64 * 3);
function tip(k: Kit, pose: Pose, len: number, out: number[]): void {
  k.sk.fk(pose, mq, mp);
  const h = k.sk.index('handR');
  const x = mq[h * 4]!, y = mq[h * 4 + 1]!, z = mq[h * 4 + 2]!, w = mq[h * 4 + 3]!;
  // rotate (0, -len, 0) by the quaternion
  const vx = 2 * (x * y - z * w) * -len, vy = (1 - 2 * (x * x + z * z)) * -len, vz = 2 * (y * z + x * w) * -len;
  out[0] = mp[h * 3]! + vx; out[1] = mp[h * 3 + 1]! + vy; out[2] = mp[h * 3 + 2]! + vz;
}

beforeAll(() => {
  expect(config.load(projectSources(root)).problems).toEqual([]);
});

describe('Ironleaf animation set', () => {
  it('has every clip GAME.md names for Aya and the raiders, and every graph state finds its clip', () => {
    const aya = kit('aya');
    for (const n of AYA) expect(aya.clips.has(n), 'aya clip ' + n).toBe(true);
    for (const c of ['ashblade', 'ashpike', 'hulk', 'ashkite', 'kagari']) {
      const k = kit(c);
      for (const n of RAIDER) expect(k.clips.has(n), c + ' clip ' + n).toBe(true);
    }
    for (const c of ['aya', 'ashblade', 'ashpike', 'hulk', 'ashkite', 'kagari']) {
      const k = kit(c);
      const p: string[] = [];
      new Graph(k.graph, k.clips, k.sk, 'graph#', (m) => p.push(m));
      expect(p, c).toEqual([]);
    }
  });

  it('samples every clip deterministically and finitely, and keeps windows inside the clip', () => {
    for (const c of ['aya', 'ashblade', 'kagari', 'hulk']) {
      const k = kit(c);
      const hash = (): string => {
        let s = 0;
        for (const [, clip] of k.clips) {
          for (let i = 0; i <= 8; i++) {
            const pose = sampleClip(clip, k.sk, (clip.length * i) / 8);
            for (const v of pose.rot) { expect(Number.isFinite(v)).toBe(true); s = (s * 31 + Math.round(v * 1e5)) | 0; }
            for (const v of pose.off) { expect(Number.isFinite(v)).toBe(true); s = (s * 31 + Math.round(v * 1e5)) | 0; }
          }
          for (const w of clip.windows ?? []) expect(w.end).toBeLessThanOrEqual(clip.length + 1e-6);
        }
        return String(s);
      };
      expect(hash()).toBe(hash());
    }
  });

  it('puts the fastest part of every strike inside its trace window: the blade sweeps when the window says', () => {
    const rows: string[] = [];
    for (const c of ['aya', 'ashblade', 'ashpike', 'hulk', 'kagari']) {
      const k = kit(c);
      const len = c === 'ashpike' ? 1.4 : c === 'hulk' ? 1.3 : c === 'kagari' ? 1.3 : c === 'aya' ? 0.91 : 0.96;
      for (const [n, clip] of k.clips) {
        const tr = (clip.windows ?? []).find((w) => w.name === 'trace');
        if (!tr) continue;
        let peak = 0, at = 0, inPeak = 0;
        const a = [0, 0, 0], b = [0, 0, 0];
        tip(k, sampleClip(clip, k.sk, 0), len, a);
        const dt = 1 / 60;
        for (let t = dt; t <= clip.length; t += dt) {
          tip(k, sampleClip(clip, k.sk, t), len, b);
          const sp = Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!) / dt;
          if (sp > peak) { peak = sp; at = t; }
          if (t >= tr.start && t <= tr.end + dt) inPeak = Math.max(inPeak, sp);
          a[0] = b[0]!; a[1] = b[1]!; a[2] = b[2]!;
        }
        rows.push(c + ' ' + n + ' peak ' + peak.toFixed(0) + ' m/s at ' + at.toFixed(2) + ' window ' + tr.start.toFixed(2) + '-' + tr.end.toFixed(2) + ' in-window ' + inPeak.toFixed(0));
        expect(inPeak, c + ' ' + n + ' is slow while the trace is live').toBeGreaterThan(peak * 0.5);
        expect(peak, c + ' ' + n).toBeGreaterThan(8);
      }
    }
    console.log(rows.join('\n'));
  });

  it('agrees with the move-set files: a move that plays a clip has the same trace window', () => {
    const dir = root + '/config/move-set/';
    const clips = new Map<string, Map<string, Clip>>();
    for (const c of ['aya', 'ashblade', 'ashpike', 'hulk', 'kagari']) clips.set(c, kit(c).clips);
    let checked = 0;
    for (const f of readdirSync(dir)) {
      if (!/^(aya|raider)/.test(f)) continue;
      const ms = JSON.parse(readFileSync(dir + f, 'utf8')) as { moves: Record<string, { clip?: string; windows?: { trace?: [number, number] | [number, number][] } }> };
      for (const [name, mv] of Object.entries(ms.moves)) {
        const tr = mv.windows?.trace;
        if (!tr) continue;
        const clipName = mv.clip ?? name;
        for (const set of clips.values()) {
          const clip = set.get(clipName);
          const w = clip?.windows?.find((x) => x.name === 'trace');
          if (!clip || !w) continue;
          const first = (Array.isArray(tr[0]) ? tr[0] : tr) as [number, number];
          expect(Math.abs(w.start - first[0]), f + ' ' + name).toBeLessThan(0.04);
          expect(Math.abs(w.end - first[1]), f + ' ' + name).toBeLessThan(0.04);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(5);
  });
});
