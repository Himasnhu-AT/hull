import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalog, examplesDir, listCommunity, openCommunity } from './server/community.ts';
import { communityList, communityOpen } from './tools/community.ts';

const projects = (): string => mkdtempSync(join(tmpdir(), 'hull-community-'));

describe('community catalog', () => {
  it('lists AOTT with a cover and no copy yet', () => {
    const dir = projects();
    const g = listCommunity({ projectsDir: dir }).find((x) => x.id === 'aott');
    expect(g?.title).toBe('AOTT');
    expect(g?.cover).toMatch(/^data:image\/(jpeg|webp|png);base64,/);
    expect(g?.copy).toEqual({ root: join(dir, 'community', 'aott'), exists: false });
    // a cover is a thumbnail, not an asset
    expect(Buffer.from(g!.cover!.split(',')[1]!, 'base64').length).toBeLessThan(160_000);
  });

  it('copies on first open without touching the example, reuses the copy, and resets it', () => {
    const dir = projects();
    const first = openCommunity({ id: 'aott', projectsDir: dir });
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
    expect(openCommunity({ id: 'aott', projectsDir: dir })).toEqual({ root: first.root, created: false });
    expect(existsSync(join(first.root, 'mine.txt'))).toBe(true);
    expect(listCommunity({ projectsDir: dir })[0]!.copy.exists).toBe(true);

    expect(openCommunity({ id: 'aott', projectsDir: dir, reset: true }).created).toBe(true);
    expect(existsSync(join(first.root, 'mine.txt'))).toBe(false);
    expect(existsSync(join(first.root, 'hull.json'))).toBe(true);
  });

  it('refuses an id that is not in the catalog (no path tricks)', () => {
    expect(() => openCommunity({ id: '../templates/cube', projectsDir: projects() })).toThrow(/no community game/);
    expect(catalog().every((e) => /^[a-z0-9-]+$/.test(e.id))).toBe(true);
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
