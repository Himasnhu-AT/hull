
import { writeFileSync } from 'node:fs';
import { Rig } from './rig.ts';
import { bake, sheetSvg, sweepWindow } from './bake.ts';
import { ayaClips } from './aya.ts';
const rig = new Rig('/Users/himanshu/codes/game/engine/.claude/worktrees/agent-a7a8d8a077b1f4606/examples/ironleaf/config/character/aya.json');
const all = ayaClips(rig);
const names = (process.env.CLIPS ?? Object.keys(all).join(',')).split(',');
for (const n of names) {
  const { base, spec } = all[n]!;
  const b = bake(rig, base, spec);
  const sw = sweepWindow(b);
  console.log(n, 'sweep', sw.start.toFixed(2), sw.end.toFixed(2), 'peak', sw.peak.toFixed(1), 'trace', JSON.stringify(spec.windows?.trace), 'keys', Object.values((b.def as any).tracks).reduce((s: number, t: any) => s + t.rotation.length, 0));
  writeFileSync(process.env.OUT + '/' + n + '.svg', sheetSvg(rig, base, spec, n, 9));
}
