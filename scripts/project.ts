// Maintainer script (never ships): runs one Hull tool on a project folder, the way the app would call it.
//   pnpm project:check <dir>     pnpm project:build <dir>     pnpm project:dev <dir>
//   pnpm project:run <tool> <dir> [json input]     e.g. pnpm project:run play examples/aott '{"file":"tests/smoke.steps.json"}'
import { resolve } from 'node:path';
import { allTools, failed, render, runTool } from '../packages/tools/src/index.ts';

const [tool, dir = '.', json] = process.argv.slice(2).filter((a) => a !== '--');
if (!tool) { console.error('usage: project.ts <tool> <dir> [json input]; tools: ' + allTools.map((t) => t.name).join(', ')); process.exit(2); }
const root = resolve(dir);
const t = allTools.find((x) => x.name === tool);
if (!t) { console.error(`unknown tool "${tool}"`); process.exit(2); }
const abort = new AbortController();
process.on('SIGINT', () => { abort.abort(); process.exit(0); });
try {
  const out = await runTool(root, tool, json ? JSON.parse(json) : {}, { author: 'maintainer', log: (l) => console.error(l), signal: abort.signal });
  console.log(render(t, out).join('\n'));
  if (failed(out)) process.exitCode = 1;
  // The dev server keeps the process alive on its own; everything else ends here.
  if (tool !== 'dev') process.exit(process.exitCode ?? 0);
} catch (e) {
  console.error(`${tool}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
