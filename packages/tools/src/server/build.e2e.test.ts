// The build report names the WebAssembly kernel: absent for a game that imports no module with one, present (with the
// module's size) for a game that imports hull/physics. Projects live in a temp dir outside the repo.
import { appendFileSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { KERNEL_BYTES } from 'hull/kernel';
import { buildProject } from './build.ts';
import { createProject } from './index.ts';

const tmp = mkdtempSync(join(tmpdir(), 'hull-kernel-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('build kernel report', () => {
  it('has no kernel for the cube template, and says so in the log', async () => {
    const dir = join(tmp, 'cube');
    await createProject({ template: 'cube', dir, title: 'Cube' });
    const lines: string[] = [];
    const r = await buildProject(dir, (l) => lines.push(l));
    expect(r.problems).toEqual([]);
    expect(r.kernel).toBeUndefined();
    expect(lines.some((l) => l.startsWith('kernel: none'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'dist/web/build.json'), 'utf8'))).not.toHaveProperty('kernel');
  }, 120_000);

  it('carries the kernel when the game imports hull/physics', async () => {
    const dir = join(tmp, 'physics');
    await createProject({ template: 'cube', dir, title: 'Physics' });
    // Used for real, so the bundler cannot drop the import as dead code.
    appendFileSync(join(dir, 'src/main.ts'), "\nimport { Physics } from 'hull/physics';\nexport const physicsKind = Physics.name;\n");
    const lines: string[] = [];
    const r = await buildProject(dir, (l) => lines.push(l));
    expect(r.problems).toEqual([]);
    expect(r.kernel).toEqual({ bytes: KERNEL_BYTES });
    expect(lines.some((l) => /^kernel: [\d.]+ kB of WebAssembly inside game\.js$/.test(l))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'dist/web/build.json'), 'utf8')).kernel).toEqual({ bytes: KERNEL_BYTES });
  }, 120_000);
});
