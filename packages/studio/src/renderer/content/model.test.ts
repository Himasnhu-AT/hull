import { describe, expect, it } from 'vitest';
import type { LibraryItem } from 'hull/dev/protocol';
import { buildEntries, buildFolders, canDrop, canDropFolder, childFolders, chipsIn, crumbs, filterEntries, idIn, kindOfDir, parentDir, uniqueName, validName, visibleEntries, type Filter } from './model.ts';

const item = (id: string, kind: string, problems = 0): LibraryItem => ({ id, kind, path: `config/${id}.json`, title: id, problems });
const items: LibraryItem[] = [
  item('sound/combat/hit', 'sound'), item('sound/combat/miss', 'sound', 1), item('sound/ui', 'sound'), item('material/jacket', 'material'), item('anim-set/humanoid', 'anim-set'), item('hull.json', 'game'),
  { id: 'tunables:player', kind: 'tunables', path: 'src/player/tuning.ts', title: 'player', problems: 0 },
];
const code = [{ path: 'src/main.ts' }, { path: 'src/player/tuning.ts' }, { path: 'src/player/move.ts' }];
const entries = buildEntries(items, code);
const none: Filter = { query: '', kinds: new Set(), changed: false, problems: false, changedKeys: new Set() };

describe('entries and folders', () => {
  it('puts config assets in their kind folder, tunables and code under src, and hides the code file a tunables block already stands for', () => {
    expect(entries.find((e) => e.key === 'sound/combat/hit')).toMatchObject({ dir: 'config/sound/combat', name: 'hit', config: true });
    expect(entries.find((e) => e.key === 'tunables:player')).toMatchObject({ dir: 'src/player', kind: 'tunables', config: false });
    expect(entries.filter((e) => e.kind === 'code').map((e) => e.key)).toEqual(['code:src/main.ts', 'code:src/player/move.ts']);
    expect(entries.find((e) => e.key === 'hull.json')!.dir).toBe('');
  });
  it('builds the tree from disk folders and entries', () => {
    const f = buildFolders(['sound', 'sound/empty', 'material'], entries);
    expect(childFolders(f, '')).toEqual(['config/anim-set', 'config/material', 'config/sound', 'src']);
    expect(childFolders(f, 'config/sound')).toEqual(['config/sound/combat', 'config/sound/empty']);
    expect(childFolders(f, 'src')).toEqual(['src/player']);
    expect(parentDir('config/sound')).toBe('');
    expect(kindOfDir('config/sound/combat')).toBe('sound');
    expect(kindOfDir('src')).toBeNull();
    expect(crumbs('config/sound/combat').map((c) => c.label)).toEqual(['Content', 'sound', 'combat']);
  });
  it('lists a folder shallowly, or deeply under a filter', () => {
    expect(visibleEntries(entries, 'config/sound', false).map((e) => e.name)).toEqual(['ui']);
    expect(visibleEntries(entries, 'config/sound', true).map((e) => e.name)).toEqual(['hit', 'miss', 'ui']);
  });
});

describe('filters', () => {
  it('filters by chip (anim groups its kinds), changed, problems and text', () => {
    expect(filterEntries(entries, { ...none, kinds: new Set(['anim']) }).map((e) => e.key)).toEqual(['anim-set/humanoid']);
    expect(filterEntries(entries, { ...none, problems: true }).map((e) => e.key)).toEqual(['sound/combat/miss']);
    expect(filterEntries(entries, { ...none, changed: true, changedKeys: new Set(['material/jacket']) }).map((e) => e.key)).toEqual(['material/jacket']);
    expect(filterEntries(entries, { ...none, query: 'COMBAT' }).map((e) => e.key)).toEqual(['sound/combat/hit', 'sound/combat/miss']);
  });
  it('orders the chips as the brief does', () => {
    expect(chipsIn(entries)).toEqual(['sound', 'material', 'anim', 'tunables', 'code', 'game']);
  });
});

describe('organising', () => {
  it('names and ids', () => {
    expect(idIn('config/sound/combat', 'hit')).toBe('sound/combat/hit');
    expect(validName('hit-2.v1')).toBe(true);
    expect(validName('a b')).toBe(false);
    expect(validName('')).toBe(false);
    expect(uniqueName(entries, 'config/sound/combat', 'hit')).toBe('hit-2');
    expect(uniqueName(entries, 'config/sound/combat', 'clash')).toBe('clash');
  });
  it('allows a drop only inside the same kind, and never onto the folder it is in', () => {
    const hit = entries.find((e) => e.key === 'sound/combat/hit')!;
    const jacket = entries.find((e) => e.key === 'material/jacket')!;
    expect(canDrop([hit], 'config/sound')).toBe(true);
    expect(canDrop([hit], 'config/sound/combat')).toBe(false);
    expect(canDrop([hit, jacket], 'config/sound')).toBe(false);
    expect(canDrop([hit], 'config/material')).toBe(false);
    expect(canDrop([hit], 'src')).toBe(false);
    expect(canDropFolder('config/sound/combat', 'config/sound/ui')).toBe(true);
    expect(canDropFolder('config/sound/combat', 'config/sound/combat/deeper')).toBe(false);
  });
});
