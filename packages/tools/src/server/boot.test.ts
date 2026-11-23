import { describe, expect, it } from 'vitest';
import { bootSource } from './boot.ts';

const base = { entry: 'src/main.ts', sources: [] as { path: string; text: string }[] };

describe('bootSource vfx', () => {
  it('mounts vfx when hull.json lists the feature, and skips it on failure like the other parts', () => {
    const s = bootSource({ ...base, features: ['vfx'] });
    expect(s).toContain("import { mountVfx } from 'hull/vfx';");
    expect(s).toContain('views.vfx = mountVfx(g)');
    expect(s).toContain("vfx failed to start and was skipped");
  });
  it('mounts vfx when the project has vfx config, and not otherwise', () => {
    expect(bootSource({ ...base, sources: [{ path: 'config/vfx/dust.json', text: '{}' }] })).toContain('mountVfx(g)');
    expect(bootSource({ ...base, features: ['audio'] })).not.toContain('mountVfx');
  });
  it('disposes it on hot reload with the other parts, and the build page mounts it too', () => {
    const dev = bootSource({ ...base, features: ['vfx'], devUrl: 'ws://x' });
    expect(dev).toContain('for (const p of parts) p.dispose?.()');
    expect(dev).toContain('import.meta.hot?.dispose(stop)');
    expect(bootSource({ ...base, features: ['vfx'], build: true })).toContain('mountVfx(g)');
  });
});

describe('bootSource kernels', () => {
  const manifest = (extra: object): { path: string; text: string }[] => [{ path: 'hull.json', text: JSON.stringify({ kind: 'game', id: 'g', title: 'G', entry: 'src/main.ts', ...extra }) }];
  it('starts the game with no option by default, and never imports the kernel module', () => {
    for (const s of [bootSource({ ...base, sources: manifest({}), build: true }), bootSource({ ...base, sources: manifest({ kernels: true }), build: true })]) {
      expect(s).toContain('await startGame(game);');
      expect(s).not.toContain('hull/kernel');
    }
  });
  it("passes kernels: 'off' to startGame when hull.json says kernels false", () => {
    const s = bootSource({ ...base, sources: manifest({ kernels: false }), build: true });
    expect(s).toContain("await startGame(game, { kernels: 'off' });");
    expect(s).not.toContain('hull/kernel');
  });
  it('reads the ?kernels= flag only on the dev page, where it wins over hull.json', () => {
    const dev = bootSource({ ...base, sources: manifest({ kernels: false }), devUrl: 'ws://x' });
    expect(dev).toContain("get('kernels')");
    expect(dev).toContain("kq === 'off' || kq === 'fail' ? kq : 'off'");
    expect(bootSource({ ...base, devUrl: 'ws://x' })).toContain("kq : 'on'");
    expect(bootSource({ ...base, sources: manifest({}), build: true })).not.toContain('kernels');
  });
});
