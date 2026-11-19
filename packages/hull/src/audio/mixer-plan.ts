// The mixer as plain data: which bus feeds which, at what level. Pure, so a bad file (a loop, a bus that feeds a
// bus that is not there) is caught and described before any node is made.
import type { Mixer } from '../schema/mixer.ts';

export interface BusCompressor { threshold: number; ratio: number; attack: number; release: number }
export interface BusPlan { name: string; to: string | null; levelDb: number; compressor: BusCompressor | null }
export interface MixerPlan {
  /** Feeders first, master last. */
  buses: BusPlan[];
  compressor: { threshold: number; ratio: number } | null;
  limiterDb: number;
  /** Things that were wrong and what was done about them: shown once by the engine. */
  problems: string[];
}

/** What a game gets with no mixer file. */
export const defaultMixer: Mixer = {
  kind: 'mixer',
  buses: { master: { level: 0 }, sfx: { to: 'master', level: 0 }, ui: { to: 'master', level: -4 }, voice: { to: 'master', level: 0 }, music: { to: 'master', level: -10 } },
};

export function planMixer(mixer: Mixer | undefined, where = 'mixer'): MixerPlan {
  const m = mixer ?? defaultMixer;
  const problems: string[] = [];
  const names = new Set(Object.keys(m.buses));
  names.add('master');
  const target = new Map<string, string | null>();
  const level = new Map<string, number>();
  for (const name of names) {
    const b = m.buses[name];
    level.set(name, b?.level ?? 0);
    if (name === 'master') {
      target.set(name, null);
      if (b?.to) problems.push(`${where}#/buses/master/to: master is the end of the chain and cannot feed "${b.to}"; ignored`);
      continue;
    }
    let to = b?.to ?? 'master';
    if (!names.has(to)) {
      problems.push(`${where}#/buses/${name}/to: there is no bus "${to}"; "${name}" feeds master instead`);
      to = 'master';
    }
    target.set(name, to);
  }
  // A bus whose chain never reaches master is in a loop: send it to master.
  for (const name of names) {
    const seen = new Set<string>();
    let cur: string | null = name;
    while (cur && !seen.has(cur)) { seen.add(cur); cur = target.get(cur) ?? null; }
    if (cur) {
      problems.push(`${where}#/buses/${name}/to: the buses feed each other in a loop; "${name}" feeds master instead`);
      target.set(name, 'master');
    }
  }
  // Order by depth: the farther from master, the earlier.
  const depth = (n: string): number => { let d = 0; let c = target.get(n) ?? null; while (c) { d++; c = target.get(c) ?? null; } return d; };
  const ordered = [...names].sort((a, b) => depth(b) - depth(a) || (a < b ? -1 : 1));
  const comp = m.master?.compressor;
  return {
    buses: ordered.map((name) => {
      const c = m.buses[name]?.compressor;
      return { name, to: target.get(name) ?? null, levelDb: level.get(name) ?? 0, compressor: c ? { threshold: c.threshold, ratio: c.ratio, attack: c.attack ?? 0.003, release: c.release ?? 0.12 } : null };
    }),
    compressor: comp ? { threshold: comp.threshold, ratio: comp.ratio } : null,
    limiterDb: m.master?.limiter ?? -1,
    problems,
  };
}
