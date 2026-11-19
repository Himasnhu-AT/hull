
import { Rig } from './rig.ts';
import { bake } from './bake.ts';
import { raiderClips } from './raiders.ts';
const CFG = '/Users/himanshu/codes/game/engine/.claude/worktrees/agent-a7a8d8a077b1f4606/examples/ironleaf/config';
const all = raiderClips(CFG);
const a = all[process.env.CLIP!]!;
const b = bake(a.rig!, a.base, a.spec);
for (let i = 0; i < b.times.length; i += 2) { const t = b.times[i]!; if (t < Number(process.env.FROM ?? 0.5)) continue; console.log(t.toFixed(2), 'tip f=' + (-b.tip[i]![2]).toFixed(2), 'y=' + b.tip[i]![1].toFixed(2), 'x=' + b.tip[i]![0].toFixed(2), 'hips f=' + (-b.hips[i]![2]).toFixed(2)); }
