import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProject } from '../server/index.ts';
import { checkConfigMeaning } from './meaning.ts';

// The kits' own rules reach the check tool: a finding has its file, pointer, line and column like any other problem.
describe('check runs what the kits know about their kinds', () => {
  it('places a prefab with no material and a missing model file, and passes once they are right', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'hull-meaning-')), 'g');
    try {
      await createProject({ template: 'arena', dir, title: 'Meaning' });
      mkdirSync(join(dir, 'config', 'prefab'), { recursive: true });
      const file = join(dir, 'config', 'prefab', 'crate.json');
      writeFileSync(file, JSON.stringify({ kind: 'prefab', parts: [{ shape: 'box', at: [0, 0.5, 0], size: [1, 1, 1] }, { model: 'models/none.glb', at: [0, 0, 0], size: [1, 1, 1] }] }, null, 2));
      const bad = await checkConfigMeaning(dir);
      expect(bad.map((p) => p.pointer)).toEqual(['/parts/0', '/parts/1/model']);
      expect(bad[0]).toMatchObject({ file: 'config/prefab/crate.json', rule: 'meaning' });
      expect(bad[0]!.message).toContain('needs a material');
      expect(bad[0]!.line).toBeGreaterThan(1);
      expect(bad[1]!.message).toBe('assets/models/none.glb does not exist');

      mkdirSync(join(dir, 'assets', 'models'), { recursive: true });
      writeFileSync(join(dir, 'assets', 'models', 'none.glb'), 'glTF');
      writeFileSync(file, JSON.stringify({ kind: 'prefab', parts: [{ shape: 'box', at: [0, 0.5, 0], size: [1, 1, 1], material: 'material/crate' }, { model: 'models/none.glb', at: [0, 0, 0], size: [1, 1, 1] }] }, null, 2));
      expect(await checkConfigMeaning(dir)).toEqual([]);
    } finally { rmSync(join(dir, '..'), { recursive: true, force: true }); }
  }, 60_000);
});
