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
