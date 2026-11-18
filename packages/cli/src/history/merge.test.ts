import { describe, expect, it } from 'vitest';
import type { FileMap } from './diff.ts';
import { mergeFiles, mergeJson } from './merge.ts';

const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, Buffer.from(v)]));
const json = (v: unknown): string => `${JSON.stringify({ kind: 'tuning', ...(v as object) }, null, 2)}\n`;
const tun = (run: number, jump: number): string => `import { num, tunables } from 'hull';\nexport const player = tunables('player', {\n  runSpeed: num(${run}, { min: 0, max: 99 }),\n  jump: num(${jump}, { min: 0, max: 99 }),\n});\n`;

describe('three-way merge by path', () => {
  it('combines different values changed in the same file', () => {
    const base = { a: 1, b: 2, nest: { x: 1 } };
    const r = mergeJson(base, { ...base, a: 10 }, { ...base, nest: { x: 5 } });
    expect(r.conflicts).toEqual([]);
    expect(r.value).toEqual({ a: 10, b: 2, nest: { x: 5 } });
  });

  it('reports the same value changed twice, with both values', () => {
    const r = mergeJson({ a: 1 }, { a: 2 }, { a: 3 });
    expect(r.conflicts).toEqual([{ path: '/a', base: 1, ours: 2, theirs: 3 }]);
    expect(r.value).toEqual({ a: 2 });
    expect(mergeJson({ a: 1 }, { a: 2 }, { a: 3 }, () => 'theirs').value).toEqual({ a: 3 });
  });

  it('keeps a different item in the same list from conflicting', () => {
    const base = { layers: [{ f: 1 }, { f: 2 }, { f: 3 }] };
    const ours = { layers: [{ f: 10 }, { f: 2 }, { f: 3 }] };
    const theirs = { layers: [{ f: 1 }, { f: 2 }, { f: 30 }] };
    const r = mergeJson(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(r.value).toEqual({ layers: [{ f: 10 }, { f: 2 }, { f: 30 }] });
    // The same item changed twice still conflicts, by index.
    expect(mergeJson(base, ours, { layers: [{ f: 11 }, { f: 2 }, { f: 3 }] }).conflicts[0]!.path).toBe('/layers/0/f');
  });

  it('merges files: config text keeps its formatting, tunables merge by name', () => {
    const base = files({ 'config/tuning/t.json': json({ a: 1, b: 2 }), 'src/p.ts': tun(1, 2), 'src/notes.ts': 'x\ny\nz\n' });
    const ours = files({ 'config/tuning/t.json': json({ a: 5, b: 2 }), 'src/p.ts': tun(9, 2), 'src/notes.ts': 'X\ny\nz\n' });
    const theirs = files({ 'config/tuning/t.json': json({ a: 1, b: 7 }), 'src/p.ts': tun(1, 8), 'src/notes.ts': 'x\ny\nZ\n' });
    const r = mergeFiles(base, ours, theirs);
    expect(r.conflicts).toEqual([]);
    expect(JSON.parse(r.files.get('config/tuning/t.json')!.toString())).toMatchObject({ a: 5, b: 7 });
    expect(r.files.get('src/p.ts')!.toString()).toBe(tun(9, 8));
    expect(r.files.get('src/notes.ts')!.toString()).toBe('X\ny\nZ\n');
  });

  it('names a tunable conflict by block and key, and honours a decision', () => {
    const base = files({ 'src/p.ts': tun(1, 2) });
    const ours = files({ 'src/p.ts': tun(5, 2) });
    const theirs = files({ 'src/p.ts': tun(6, 2) });
    const r = mergeFiles(base, ours, theirs);
    expect(r.conflicts).toEqual([{ file: 'src/p.ts', kind: 'tunable', target: 'tunables:player', path: 'runSpeed', base: 1, ours: 5, theirs: 6 }]);
    expect(r.files.get('src/p.ts')!.toString()).toBe(tun(5, 2));
    const t = mergeFiles(base, ours, theirs, { 'tunables:player#runSpeed': 'theirs' });
    expect(t.conflicts).toEqual([]);
    expect(t.files.get('src/p.ts')!.toString()).toBe(tun(6, 2));
  });

  it('reports conflicting lines in other code', () => {
    const r = mergeFiles(files({ 'src/a.ts': 'a\nb\nc\n' }), files({ 'src/a.ts': 'a\nB1\nc\n' }), files({ 'src/a.ts': 'a\nB2\nc\n' }));
    expect(r.conflicts[0]).toMatchObject({ file: 'src/a.ts', kind: 'lines', ours: 'B1', theirs: 'B2' });
  });
});
