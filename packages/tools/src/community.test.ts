import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { compareVersions, examplesDir, listCommunity, localCatalog, openCommunity } from './server/community.ts';
import { communityList, communityOpen } from './tools/community.ts';

const projects = (): string => mkdtempSync(join(tmpdir(), 'hull-community-'));

describe('community catalog', () => {
  it('lists AOTT with a cover and no copy yet', async () => {
    const dir = projects();
    const g = (await listCommunity({ projectsDir: dir })).find((x) => x.id === 'aott');
    expect(g?.title).toBe('AOTT');
    expect(g?.cover).toMatch(/^data:image\/(jpeg|webp|png);base64,/);
    expect(g?.copy).toEqual({ root: join(dir, 'community', 'aott'), exists: false, version: null });
    expect(g?.source).toBe('local');
    // a cover is a thumbnail, not an asset
    expect(Buffer.from(g!.cover!.split(',')[1]!, 'base64').length).toBeLessThan(160_000);
  });

  it('copies on first open without touching the example, reuses the copy, and resets it', async () => {
    const dir = projects();
    const first = await openCommunity({ id: 'aott', projectsDir: dir });
    expect(first.created).toBe(true);
    for (const f of ['hull.json', 'src/main.ts', 'config', 'cover.jpg', 'tsconfig.json', 'package.json']) {
      if (f === 'cover.jpg' && !existsSync(join(examplesDir, 'aott', f))) continue;
      expect(existsSync(join(first.root, f)), f).toBe(true);
    }
    expect(existsSync(join(first.root, 'node_modules'))).toBe(false);
    expect(JSON.parse(readFileSync(join(first.root, 'hull.json'), 'utf8')).title).toBe('AOTT');
    // standalone: hull is reached by path, not by the workspace
    expect(readFileSync(join(first.root, 'tsconfig.json'), 'utf8')).toContain('"paths"');

    writeFileSync(join(first.root, 'mine.txt'), 'edit');
    expect(await openCommunity({ id: 'aott', projectsDir: dir })).toMatchObject({ root: first.root, created: false });
    expect(existsSync(join(first.root, 'mine.txt'))).toBe(true);
    expect((await listCommunity({ projectsDir: dir }))[0]!.copy.exists).toBe(true);

    expect((await openCommunity({ id: 'aott', projectsDir: dir, reset: true })).created).toBe(true);
    expect(existsSync(join(first.root, 'mine.txt'))).toBe(false);
    expect(existsSync(join(first.root, 'hull.json'))).toBe(true);
  });

  it('refuses an id that is not in the catalog (no path tricks)', async () => {
    await expect(openCommunity({ id: '../templates/cube', projectsDir: projects() })).rejects.toThrow(/not a community game id/);
    await expect(openCommunity({ id: 'nope', projectsDir: projects() })).rejects.toThrow(/no community game/);
    expect(localCatalog().every((e) => /^[a-z0-9-]+$/.test(e.id))).toBe(true);
  });

  it('compares versions as numbers', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.9.9', '1.0.0')).toBe(-1);
    expect(compareVersions('x', '1.0.0')).toBe(0);
  });

  it('is reachable as tools, and the list leaves covers out', async () => {
    const dir = projects();
    const ctx = { root: dir, author: 'test', log: () => {}, signal: new AbortController().signal };
    const l = await communityList.run(ctx, { projectsDir: dir });
    expect(l.items[0]!.cover).toBeNull();
    const o = await communityOpen.run(ctx, { id: 'aott', projectsDir: dir });
    expect(o.created).toBe(true);
  });
});

// A packed game, as the backend serves it: a tar.gz of a folder with a hull.json, and its sha256.
function pack(version: string): { bytes: Buffer; sha: string } {
  const src = mkdtempSync(join(tmpdir(), 'hull-pack-'));
  mkdirSync(join(src, 'src'));
  writeFileSync(join(src, 'hull.json'), JSON.stringify({ kind: 'game', id: 'drone', title: 'Drone', version }));
  writeFileSync(join(src, 'src', 'main.ts'), `export const v = '${version}';\n`);
  const out = join(src, '..', `pack-${version}-${Date.now()}.tar.gz`);
  expect(spawnSync('tar', ['-czf', out, '-C', src, '.']).status).toBe(0);
  const bytes = readFileSync(out);
  return { bytes, sha: createHash('sha256').update(bytes).digest('hex') };
}

describe('community catalog from the backend', () => {
  const server = 'http://community.test';
  const fake = (versions: Record<string, { bytes: Buffer; sha: string }>, latest: string, opts: { badSha?: boolean } = {}): typeof fetch => (async (url: string) => {
    if (url === `${server}/api/community`) {
      const v = versions[latest]!;
      return new Response(JSON.stringify({ games: [{ id: 'drone', title: 'Drone', note: 'n', version: latest, sha256: opts.badSha ? '0'.repeat(64) : v.sha, cover_url: `${server}/api/community/drone/cover`, download_url: `${server}/api/community/drone/${latest}/game.tar.gz`, versions: Object.keys(versions) }] }));
    }
    const m = /\/drone\/([\d.]+)\/game\.tar\.gz$/.exec(url);
    if (m && versions[m[1]!]) return new Response(new Uint8Array(versions[m[1]!]!.bytes));
    return new Response('no', { status: 404 });
  }) as typeof fetch;

  it('lists from the server, downloads and unpacks a version, records it, and offers an update', async () => {
    const dir = projects();
    const v1 = pack('1.0.0'), v2 = pack('1.1.0');
    const g = (await listCommunity({ projectsDir: dir, server, fetch: fake({ '1.0.0': v1 }, '1.0.0') }))[0]!;
    expect(g).toMatchObject({ id: 'drone', version: '1.0.0', source: 'server', cover: `${server}/api/community/drone/cover`, copy: { exists: false, version: null }, update: null });
    const o = await openCommunity({ id: 'drone', projectsDir: dir, server, fetch: fake({ '1.0.0': v1 }, '1.0.0') });
    expect(o).toMatchObject({ created: true, version: '1.0.0' });
    expect(readFileSync(join(o.root, 'src', 'main.ts'), 'utf8')).toContain('1.0.0');
    expect(JSON.parse(readFileSync(join(o.root, '.hull', 'community.json'), 'utf8'))).toMatchObject({ id: 'drone', version: '1.0.0', sha256: v1.sha });

    // A newer version: offered, not applied by a plain open; applied by update.
    const both = fake({ '1.0.0': v1, '1.1.0': v2 }, '1.1.0');
    expect((await listCommunity({ projectsDir: dir, server, fetch: both }))[0]).toMatchObject({ update: '1.1.0', copy: { exists: true, version: '1.0.0' } });
    expect(await openCommunity({ id: 'drone', projectsDir: dir, server, fetch: both })).toMatchObject({ created: false, version: '1.0.0' });
    expect(await openCommunity({ id: 'drone', projectsDir: dir, server, fetch: both, update: true })).toMatchObject({ created: true, version: '1.1.0' });
    expect(readFileSync(join(o.root, 'src', 'main.ts'), 'utf8')).toContain('1.1.0');
    expect((await listCommunity({ projectsDir: dir, server, fetch: both }))[0]!.update).toBeNull();
  });

  it('refuses a damaged download and keeps the old copy', async () => {
    const dir = projects();
    const v1 = pack('1.0.0');
    await openCommunity({ id: 'drone', projectsDir: dir, server, fetch: fake({ '1.0.0': v1 }, '1.0.0') });
    await expect(openCommunity({ id: 'drone', projectsDir: dir, server, fetch: fake({ '1.0.0': v1 }, '1.0.0', { badSha: true }), reset: true })).rejects.toThrow(/damaged/);
    expect(existsSync(join(dir, 'community', 'drone', 'hull.json'))).toBe(true);
  });

  it('falls back to the examples when the server cannot be reached', async () => {
    const down = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    const l = await listCommunity({ projectsDir: projects(), server, fetch: down });
    expect(l.some((g) => g.id === 'aott' && g.source === 'local')).toBe(true);
  });
});
