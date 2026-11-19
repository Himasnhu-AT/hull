import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { coverOf, createHost } from './host.ts';

// The launcher's calls on recent games: covers, rename (through config.set), Trash and thumbnails. No project server runs here.
const dir = mkdtempSync(join(tmpdir(), 'hull-launch-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const game = (name: string): string => { const r = join(dir, name); mkdirSync(r, { recursive: true }); writeFileSync(join(r, 'hull.json'), JSON.stringify({ title: name })); return r; };
const recents = (roots: string[]): void => writeFileSync(join(dir, 'data', 'recents.json'), JSON.stringify(roots.map((root) => ({ root, title: 'x', openedAt: new Date(0).toISOString() }))));
mkdirSync(join(dir, 'data'), { recursive: true });

describe('launcher calls', () => {
  it('finds a cover: the game\'s own first, else the kept thumbnail, else none', async () => {
    const a = game('a'), b = game('b'), c = game('c');
    writeFileSync(join(a, 'cover.jpg'), 'JPEG'); mkdirSync(join(a, '.hull')); writeFileSync(join(a, '.hull', 'thumb.jpg'), 'THUMB');
    mkdirSync(join(b, '.hull')); writeFileSync(join(b, '.hull', 'thumb.jpg'), 'THUMB');
    expect(await coverOf(a)).toBe(`data:image/jpeg;base64,${Buffer.from('JPEG').toString('base64')}`);
    expect(await coverOf(b)).toBe(`data:image/jpeg;base64,${Buffer.from('THUMB').toString('base64')}`);
    expect(await coverOf(c)).toBeNull();
  });

  it('renames through config.set as the person, and keeps the new name in Recent', async () => {
    const g = game('renamed');
    recents([g]);
    const calls: unknown[] = [];
    const host = createHost({ dataDir: join(dir, 'data'), runTool: async (root, name, input) => { calls.push([root, name, input]); return { ok: true, problems: [] }; } });
    expect(await host.renameProject(g, '  Gem   Dash ')).toBe('Gem Dash');
    expect(calls).toEqual([[g, 'config.set', { id: 'hull.json', pointer: '/title', value: 'Gem Dash', author: 'you' }]]);
    expect((await host.recents())[0]!.title).toBe('Gem Dash');
    await expect(host.renameProject(g, '   ')).rejects.toThrow(/needs a name/);
    await expect(host.renameProject(join(dir, 'elsewhere'), 'X')).rejects.toThrow(/not in Recent/);
    const unwritten = createHost({ dataDir: join(dir, 'data'), runTool: async () => ({ ok: true, written: false, problems: [] }) });
    await expect(unwritten.renameProject(g, 'Z')).rejects.toThrow(/not kept/);
    const bad = createHost({ dataDir: join(dir, 'data'), runTool: async () => ({ ok: false, problems: [{ message: 'title must be a string' }] }) });
    await expect(bad.renameProject(g, 'Y')).rejects.toThrow('title must be a string');
  });

  it('moves only a Hull game in Recent to the Trash, and only where a Trash exists', async () => {
    const g = game('trashed');
    recents([g]);
    const trashed: string[] = [];
    await expect(createHost({ dataDir: join(dir, 'data') }).trashProject(g)).rejects.toThrow(/Hull app/);
    const host = createHost({ dataDir: join(dir, 'data'), trash: async (p) => { trashed.push(p); } });
    await expect(host.trashProject(join(dir, 'not-listed'))).rejects.toThrow(/not in Recent/);
    await host.trashProject(g);
    expect(trashed).toEqual([g]);
    expect(JSON.parse(readFileSync(join(dir, 'data', 'recents.json'), 'utf8'))).toEqual([]);
  });

  it('keeps a thumbnail only for the open game, and only a small JPEG', async () => {
    const host = createHost({ dataDir: join(dir, 'data') });
    await expect(host.saveThumb(game('t'), 'data:image/png;base64,AAAA')).rejects.toThrow(/JPEG/);
    await expect(host.saveThumb(game('t'), 'data:image/jpeg;base64,AAAA')).rejects.toThrow(/open game/);
  });
});
