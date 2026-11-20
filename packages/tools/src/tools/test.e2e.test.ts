import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { copyProject, templatesDir, repoRoot } from '../server/templates.ts';
import { runTool } from '../run.ts';

// The test tool runs Vitest with no project config, so these projects (copied outside the repo, no node_modules) only
// pass if `hull` and `hull/<module>` imports resolve the way the dev server resolves them.
const tmp = mkdtempSync(join(tmpdir(), 'hull-testtool-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('test tool resolves hull imports', () => {
  for (const [name, from] of [['cube template', join(templatesDir, 'cube')], ['ironleaf example', join(repoRoot, 'examples', 'ironleaf')]] as const) {
    it(`runs the tests of the ${name} copied outside the repo`, async () => {
      const { root } = copyProject({ from, dir: join(tmp, name.replace(' ', '-')) });
      const out = (await runTool(root, 'test')) as { ok: boolean; total: number; passed: number; problems: unknown[] };
      expect(out.problems).toEqual([]);
      expect(out.total).toBeGreaterThan(0);
      expect(out.passed).toBe(out.total);
    }, 180_000);
  }
});
