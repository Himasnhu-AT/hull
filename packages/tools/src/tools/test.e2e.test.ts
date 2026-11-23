import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

describe('test tool output', () => {
  const copy = (name: string) => copyProject({ from: join(templatesDir, 'cube'), dir: join(tmp, name) }).root;
  const add = (root: string, body: string) => writeFileSync(join(root, 'src', 'print.test.ts'), "import { it } from 'vitest';\nit('prints', () => {\n" + body + "\n});\n");

  it('returns what the tests printed to stdout and stderr, so a value can be read without throwing', async () => {
    const root = copy('print');
    add(root, "console.log('speed is', 4.5);\nconsole.error('warned about x');");
    const out = (await runTool(root, 'test')) as { output?: string };
    expect(out.output).toContain('speed is 4.5');
    expect(out.output).toContain('warned about x');
    expect(out.output).toContain('print.test.ts');
  }, 120_000);

  it('cuts a long print to about 4000 characters and says so', async () => {
    const root = copy('long');
    add(root, "console.log('x'.repeat(10000));");
    const out = (await runTool(root, 'test')) as { output?: string };
    expect(out.output!.length).toBeLessThan(4400);
    expect(out.output).toMatch(/cut/);
  }, 120_000);
});
