import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProject, startProjectServer } from './index.ts';

// The sound bench renders a sound whose source is `code` with the game's own generators, so the project server serves
// the engine bundled with the module hull.json names as "generators".
describe('the sound bench bundle', () => {
  it('is absent without "generators", and with it carries the registered generators and the engine', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hull-bench-'));
    const dir = join(root, 'game');
    try {
      await createProject({ template: 'cube', dir, title: 'Bench cube' });
      const server = await startProjectServer({ root: dir, port: 0, historyQuietMs: 60_000 });
      try {
        const url = `${server.gameUrl}__hull/bench/audio.js`;
        const none = await fetch(url);
        expect(none.status).toBe(404);

        writeFileSync(join(dir, 'src', 'gens.ts'), [
          "import { registerGenerator, registerLiveGenerator } from 'hull/audio';",
          'export default function register(): void {',
          "  registerGenerator('bench/beep', () => 0.2);",
          "  registerLiveGenerator('bench/hum', () => ({ stop() {} }) as never);",
          '}',
          '',
        ].join('\n'));
        const manifest = join(dir, 'hull.json');
        writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), generators: 'src/gens.ts' }, null, 2));
        // The manifest change is noticed; give the watcher a moment, then ask again.
        let res = await fetch(url);
        for (let i = 0; i < 50 && res.status !== 200; i++) { await new Promise((r) => setTimeout(r, 100)); res = await fetch(url); }
        expect(res.status).toBe(200);
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
        const code = await res.text();

        // Self-contained: it runs with nothing around it, and its engine knows the project's generators.
        const mod = (await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)) as Record<string, unknown> & { hasGenerator(n: string): boolean };
        expect(typeof mod['renderSound']).toBe('function');
        expect(typeof mod['measureSound']).toBe('function');
        expect(typeof mod['playBuffer']).toBe('function');
        expect(mod['config']).toBeDefined();
        expect(mod.hasGenerator('bench/beep')).toBe(true);
        expect(mod.hasGenerator('bench/hum')).toBe(true);
        expect(mod.hasGenerator('bench/nope')).toBe(false);

        // A module that does not bundle is reported with its name, not served as an empty page.
        writeFileSync(join(dir, 'src', 'gens.ts'), "import './missing-file';\n");
        const bad = await fetch(url);
        expect(bad.status).toBe(500);
        expect(await bad.text()).toContain('src/gens.ts');
      } finally {
        await server.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
