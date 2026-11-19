
import { writeFileSync } from 'node:fs';
import { Rig } from './rig.ts';
import { bake, sheetSvg } from './bake.ts';
import { ayaClips } from './aya.ts';
import { raiderClips } from './raiders.ts';
const CFG = '/Users/himanshu/codes/game/engine/.claude/worktrees/agent-a7a8d8a077b1f4606/examples/ironleaf/config';
const ayaRig = new Rig(CFG + '/character/aya.json');
const all = { ...ayaClips(ayaRig), ...raiderClips(CFG) };
const sel = process.env.CLIPS ?? 'all';
const names = (sel === 'all' ? Object.keys(all) : sel === 'raiders' ? Object.keys(raiderClips(CFG)) : sel.split(','));
for (const n of names) {
  const { base, spec, rig } = all[n]!;
  const r = rig ?? ayaRig;
  const b = bake(r, base, spec);
  const tr = spec.windows?.trace as [number, number] | undefined;
  let info = '';
  if (tr) {
    let peak = 0, pt = 0, reach = 0, mx = 0;
    for (let i = 1; i < b.tip.length; i++) {
      const dt = b.times[i]! - b.times[i - 1]!;
      const sp = Math.hypot(b.tip[i]![0] - b.tip[i - 1]![0], b.tip[i]![1] - b.tip[i - 1]![1], b.tip[i]![2] - b.tip[i - 1]![2]) / dt;
      if (sp > peak) { peak = sp; pt = b.times[i]!; }
      if (b.times[i]! >= tr[0] && b.times[i]! <= tr[1]) { reach = Math.max(reach, -b.tip[i]![2]); mx += sp; }
    }
    info = 'peak ' + peak.toFixed(0) + 'm/s at ' + pt.toFixed(2) + ' trace ' + tr.join('-') + ' reach ' + reach.toFixed(2) + ' meanSpeed ' + (mx / Math.max(1, Math.round((tr[1] - tr[0]) * 60))).toFixed(0);
  }
  console.log(n, info, 'keys', Object.values((b.def as any).tracks).reduce((s: number, t: any) => s + t.rotation.length, 0));
  writeFileSync(process.env.OUT + '/' + n + '.svg', sheetSvg(r, base, spec, n, 9));
}
