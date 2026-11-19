import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProject, startProjectServer } from './index.ts';

// A project edited between two runs of the server (by hand, by git, by an agent that had no server open): the history
// records the difference while the server is still starting, and that must not take the server down.
describe('project server restart', () => {
  it('starts again on a project whose files changed since the history last looked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hull-restart-'));
    const dir = join(root, 'game');
    try {
      await createProject({ template: 'cube', dir, title: 'Restart cube' });
      const first = await startProjectServer({ root: dir, port: 0, historyQuietMs: 60_000 });
      await first.close();
      const manifest = join(dir, 'hull.json');
      writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('Restart cube', 'Restart cube, edited'));
      const second = await startProjectServer({ root: dir, port: 0, historyQuietMs: 60_000 });
      expect(second.url).toMatch(/^ws:/);
      await second.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
