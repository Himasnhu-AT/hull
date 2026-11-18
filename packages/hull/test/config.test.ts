import { describe, expect, it, vi } from 'vitest';
import { checkManifest, createRegistry } from '../src/config/index.ts';
import '../src/schema/index.ts';

const tuning = (body: string) => ({ path: 'config/tuning/jump.json', text: body });
const goodTuning = tuning('{\n  "kind": "tuning",\n  "height": 2.4,\n  "coyote": 0.1\n}\n');
const goodMaterial = { path: 'config/material/steel.json', text: '{ "kind": "material", "color": "#9aa0a8", "roughness": 0.35 }' };
const manifest = (extra = '') => ({ path: 'hull.json', text: `{\n  "kind": "game",\n  "id": "demo",\n  "title": "Demo",\n  "entry": "src/main.ts"${extra}\n}` });

describe('load', () => {
  it('loads valid files and hands out frozen values', () => {
    const r = createRegistry();
    const res = r.load([goodTuning, goodMaterial, manifest()]);
    expect(res.problems).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.ids).toEqual({ look: [], material: ['steel'], tuning: ['jump'] });
    const t = r.get('tuning', 'jump');
    expect(t['height']).toBe(2.4);
    expect(Object.isFrozen(t)).toBe(true);
    expect(r.get('material', 'steel').color).toBe('#9aa0a8');
    expect(r.has('tuning/jump')).toBe(true);
    expect(r.has('tuning/nope')).toBe(false);
    expect(r.ids('material')).toEqual(['steel']);
    expect(r.manifest()?.entry).toBe('src/main.ts');
  });

  it('reports a schema problem with file, pointer, line and col', () => {
    const r = createRegistry();
    const res = r.load([{ path: 'config/material/bad.json', text: '{\n  "kind": "material",\n  "color": "#fff",\n  "roughness": 3\n}' }]);
    expect(res.ok).toBe(false);
    expect(res.problems).toContainEqual({ file: 'config/material/bad.json', pointer: '/roughness', line: 4, col: 16, rule: 'schema', message: 'roughness must be at most 1, got 3' });
    expect(res.problems).toContainEqual(expect.objectContaining({ pointer: '/color', line: 3, col: 12, message: 'color must be a colour like #rrggbb, got "#fff"' }));
  });

  it('names unknown and missing fields', () => {
    const r = createRegistry();
    const res = r.load([{ path: 'config/material/x.json', text: '{\n  "kind": "material",\n  "shiny": true\n}' }]);
    expect(res.problems).toContainEqual(expect.objectContaining({ pointer: '/shiny', line: 3, col: 3, message: 'unknown field "shiny"' }));
    expect(res.problems).toContainEqual(expect.objectContaining({ pointer: '/color', line: 1, col: 1, message: 'missing required field "color"' }));
  });

  it('reports a kind that does not match the folder', () => {
    const res = createRegistry().load([{ path: 'config/tuning/jump.json', text: '{\n  "kind": "material"\n}' }]);
    expect(res.problems).toEqual([
      { file: 'config/tuning/jump.json', pointer: '/kind', line: 2, col: 11, rule: 'kind-mismatch', message: 'kind is "material" but the file is in config/tuning/, so it must be "tuning"' },
    ]);
  });

  it('reports a parse error with line and col', () => {
    const res = createRegistry().load([tuning('{\n  "kind": "tuning",\n  "height": ,\n}')]);
    expect(res.problems).toHaveLength(1);
    expect(res.problems[0]).toMatchObject({ file: 'config/tuning/jump.json', rule: 'parse', line: 3, col: 13 });
    expect(res.problems[0]?.message).toContain("expected a value but found ','");
  });

  it('reports an unknown kind folder', () => {
    const res = createRegistry().load([{ path: 'config/sound/hit.json', text: '{"kind":"sound"}' }]);
    expect(res.problems[0]).toMatchObject({ file: 'config/sound/hit.json', rule: 'schema' });
  });

  it('M0 check: a wrong config id fails with file and field', () => {
    const res = createRegistry().load([manifest(',\n  "start": { "level": "level/yrad" }')]);
    expect(res.ok).toBe(false);
    expect(res.problems).toEqual([
      { file: 'hull.json', pointer: '/start/level', line: 6, col: 23, rule: 'ref', message: 'level refers to "level/yrad", but there is no such level (expected config/level/yrad.json)' },
    ]);
  });

  it('checkManifest validates on its own', () => {
    const ok = checkManifest(manifest());
    expect(ok.value?.title).toBe('Demo');
    const bad = checkManifest({ path: 'hull.json', text: '{ "kind": "game", "id": "Bad Id", "title": "x", "entry": "e", "step": 45 }' });
    expect(bad.value).toBeUndefined();
    expect(bad.problems.map((p) => p.message)).toEqual(['id must be text matching ^[a-z0-9][a-z0-9-]*$, got "Bad Id"', 'step must be one of 30, 60, 120, got 45']);
  });
});

describe('update and watch', () => {
  it('replaces a valid edit and calls watchers', () => {
    const r = createRegistry();
    r.load([goodTuning]);
    const seen = vi.fn();
    const off = r.watch('tuning/jump', seen);
    const res = r.update(tuning('{ "kind": "tuning", "height": 3 }'));
    expect(res.ok).toBe(true);
    expect(r.get('tuning', 'jump')['height']).toBe(3);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0]?.[0]).toMatchObject({ height: 3 });
    off();
    r.update(tuning('{ "kind": "tuning", "height": 4 }'));
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('keeps the old value and does not call watchers when an edit is rejected', () => {
    const r = createRegistry();
    r.load([goodTuning]);
    const seen = vi.fn();
    r.watch('tuning/jump', seen);
    const res = r.update(tuning('{ "kind": "tuning", "height": "tall" }'));
    expect(res.ok).toBe(false);
    expect(res.problems[0]).toMatchObject({ file: 'config/tuning/jump.json', pointer: '/height', message: 'height must be a number, got "tall"' });
    expect(r.get('tuning', 'jump')['height']).toBe(2.4);
    expect(seen).not.toHaveBeenCalled();
  });

  it('adds a new file and removes one', () => {
    const r = createRegistry();
    r.load([goodTuning]);
    r.update({ path: 'config/tuning/run.json', text: '{ "kind": "tuning", "speed": 5 }' });
    expect(r.ids('tuning')).toEqual(['jump', 'run']);
    r.remove('config/tuning/run.json');
    expect(r.ids('tuning')).toEqual(['jump']);
  });

  it('throws a clear error for a missing id', () => {
    expect(() => createRegistry().get('tuning', 'nope')).toThrow('config tuning/nope does not exist');
  });
});

describe('idsModule', () => {
  it('writes a module that augments HullIds', () => {
    const r = createRegistry();
    r.load([goodTuning, { path: 'config/tuning/run.json', text: '{ "kind": "tuning" }' }, goodMaterial]);
    expect(r.idsModule()).toBe(
      [
        '// Generated by hull from config/. Do not edit: it is rewritten by `hull check` and `hull dev`.',
        'export {};',
        '',
        "declare module 'hull' {",
        '  interface HullIds {',
        '    look: never;',
        "    material: 'steel';",
        "    tuning: 'jump' | 'run';",
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('uses never for a kind with no files', () => {
    expect(createRegistry().idsModule()).toContain('material: never;');
  });
});
