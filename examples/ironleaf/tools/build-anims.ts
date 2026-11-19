// pnpm tsx examples/ironleaf/tools/build-anims.ts : writes config/anim-set/aya.json, raider.json and the anim graphs.
// Hand-keyed and generated clips already in a set (idle, walk, run, breathe, the raiders' holds, hit, stagger and death)
// are kept; every clip authored in aya.ts and raiders.ts is solved and written over them.
import { readFileSync } from 'node:fs';
import { bake, saveSet } from './bake.ts';
import { Rig } from './rig.ts';
import { ayaClips } from './aya.ts';
import { raiderClips } from './raiders.ts';
import { writeAyaGraph, writeRaiderGraphs } from './graphs.ts';

const CFG = new URL('../config/', import.meta.url).pathname;
const keep = (file: string, names: string[]): Record<string, unknown> => {
  const j = JSON.parse(readFileSync(CFG + 'anim-set/' + file + '.json', 'utf8'));
  return Object.fromEntries(names.filter((n) => j.clips[n]).map((n) => [n, j.clips[n]]));
};
const solve = (set: ReturnType<typeof ayaClips>, fallback: Rig): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [n, a] of Object.entries(set)) out[n] = bake(a.rig ?? fallback, a.base, a.spec).def;
  return out;
};

const aya = new Rig(CFG + 'character/aya.json');
saveSet(CFG + 'anim-set/aya.json', 'Aya: generated locomotion, and every move solved by IK from key poses (tools/aya.ts). Names are the move names of GAME.md section 5.', {
  ...keep('aya', ['idle', 'walk', 'run', 'breathe']),
  ...solve(ayaClips(aya), aya),
});
const raiders = raiderClips(CFG);
const rset = JSON.parse(readFileSync(CFG + 'anim-set/raider.json', 'utf8')).clips as Record<string, unknown>;
const authored = solve(raiders, aya);
const kept = Object.fromEntries(Object.entries(rset).filter(([n]) => !(n in authored)));
saveSet(CFG + 'anim-set/raider.json', 'The Ashfall Band: holds and locomotion, and the attack moves solved by IK from key poses (tools/raiders.ts), timed to the move-sets (raider-*.json).', { ...kept, ...authored });
writeAyaGraph();
writeRaiderGraphs();
console.log('written', Object.keys(authored).length, 'raider clips');
