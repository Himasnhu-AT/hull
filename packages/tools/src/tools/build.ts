import type { Problem } from 'hull';
import { buildProject } from '../server/build.ts';
import { defineTool } from '../tool.ts';
import { check } from './check.ts';

export interface BuildInput { skipCheck?: boolean }
export interface BuildOutput {
  ok: boolean;
  problems: Problem[];
  outDir?: string;
  files?: { path: string; bytes: number; gzip: number }[];
  devFree?: boolean;
  kernel?: { bytes: number };
}

export const build = defineTool<BuildInput, BuildOutput>({
  name: 'build',
  summary: 'Builds dist/web: game.js (one file, config inside, no dev code) and index.html.',
  input: { type: 'object', properties: { skipCheck: { type: 'boolean', description: 'Skip types, schemas and house rules.' } }, additionalProperties: false },
  output: { type: 'object', required: ['ok', 'problems'] },
  format: (o) => (o.ok ? [`Built ${o.outDir}`, ...(o.files ?? []).map((f) => `  ${f.path}: ${f.bytes} bytes${f.gzip ? ` (${f.gzip} gzip)` : ''}`), o.kernel ? `  kernel: ${(o.kernel.bytes / 1024).toFixed(1)} kB of WebAssembly inside game.js` : '  kernel: none (the game imports no module that has one)'] : []),
  async run(ctx, input) {
    if (!input.skipCheck) {
      const r = await check.run(ctx, {});
      if (!r.ok) return { ok: false, problems: r.problems };
    }
    return buildProject(ctx.root, ctx.log);
  },
});
