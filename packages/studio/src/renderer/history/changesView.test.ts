import { describe as suite, expect, it } from 'vitest';
import type { ChangeDelta } from 'hull/dev/protocol';
import { describe, groupRows, lastAuthors, show, type FieldInfo, type FieldLookup } from './changesView.ts';

const fields: Record<string, FieldInfo> = {
  'look/dawn#/sky/horizon': { pointer: '/sky/horizon', label: 'Horizon', group: 'Sky', widget: 'color', unit: '', step: 0.1 },
  'look/dawn#/fog/far': { pointer: '/fog/far', label: 'Far', group: 'Fog', widget: 'slider', unit: 'm', step: 1 },
  'look/dawn#/layers': { pointer: '/layers', label: 'Layers', group: 'Layers', widget: 'list', unit: '', step: 1 },
  'tunables:hook#range': { pointer: 'range', label: 'Range', group: 'Hook', widget: 'slider', unit: 'm', step: 1 },
};
const lookup: FieldLookup = (t, p) => fields[`${t}#${p}`];
const json = (o: Partial<ChangeDelta>): ChangeDelta => ({ file: 'config/look/dawn.json', kind: 'json', op: 'set', target: 'look/dawn', path: '/sky/horizon', text: '', ...o });

suite('config field diffs', () => {
  it('names the field with the Inspector group and label, and gives colours swatches', () => {
    const r = describe(json({ from: '#d6c1ac', to: '#5a9bff' }), lookup);
    expect(r.path).toEqual(['Sky', 'Horizon']);
    expect(r.from).toEqual({ text: '#d6c1ac', swatch: '#d6c1ac' });
    expect(r.to).toEqual({ text: '#5a9bff', swatch: '#5a9bff' });
    expect(r.revert).toEqual({ via: 'config.set', id: 'look/dawn', pointer: '/sky/horizon', value: '#d6c1ac' });
  });
  it('writes numbers with the unit and the field precision', () => {
    const r = describe(json({ path: '/fog/far', from: 1200, to: 900.5 }), lookup);
    expect(r.from?.text).toBe('1200 m');
    expect(r.to?.text).toBe('901 m');
  });
  it('shows a field the Inspector has no widget for by its words', () => {
    const r = describe(json({ path: '/post/bloomThreshold', from: 0.72, to: 0.5 }), lookup);
    expect(r.path).toEqual(['Post', 'Bloom threshold']);
    expect(r.from?.text).toBe('0.72');
  });
  it('shows array rows as added and removed, and reverts an added one by taking it out', () => {
    const add = describe(json({ path: '/layers/2', op: 'add', to: { freq: 3 } }), lookup);
    expect(add.path).toEqual(['Layers', 'row 3']);
    expect(add.note).toBe('row added');
    expect(add.from).toBeUndefined();
    expect(add.revert).toEqual({ via: 'history.revert', file: 'config/look/dawn.json', pointer: '/layers/2' });
    const rem = describe(json({ path: '/layers/1', op: 'remove', from: { freq: 1 } }), lookup);
    expect(rem.note).toBe('row removed');
    expect(rem.revert.via).toBe('config.set');
  });
  it('shows the default as the old value when the file did not set the field', () => {
    const r = describe(json({ path: '/sky/color', op: 'add', to: '#5a9bff' }), (t, p) => (p === '/sky/color' ? { pointer: p, label: 'Color', group: 'Sky', widget: 'color', unit: '', step: 1, def: '#14161b' } : undefined));
    expect(r.from).toEqual({ text: '#14161b', swatch: '#14161b' });
    expect(r.note).toBe('was default');
    expect(r.revert).toEqual({ via: 'history.revert', file: 'config/look/dawn.json', pointer: '/sky/color' });
  });
  it('knows a whole new file', () => {
    const r = describe(json({ path: '', op: 'add' }), lookup);
    expect(r.note).toBe('new file');
    expect(r.revert).toEqual({ via: 'history.revert', file: 'config/look/dawn.json' });
  });
});

suite('code diffs', () => {
  const tun = (o: Partial<ChangeDelta>): ChangeDelta => ({ file: 'src/tuning.ts', kind: 'tunable', op: 'set', target: 'tunables:hook', path: 'range', from: 115, to: 160, text: '', ...o });
  it('names the tunable: hook > Range 115 to 160, reverting through tunables.set', () => {
    const r = describe(tun({}), lookup);
    expect(r.path).toEqual(['hook', 'Range']);
    expect([r.from?.text, r.to?.text]).toEqual(['115 m', '160 m']);
    expect(r.revert).toEqual({ via: 'tunables.set', block: 'hook', key: 'range', value: 115 });
  });
  it('summarizes other code as lines and reverts the whole file', () => {
    const r = describe({ file: 'src/main.ts', kind: 'lines', op: 'set', target: 'src/main.ts', path: '', added: 3, removed: 1, text: '' }, lookup);
    expect(r.note).toBe('+3 −1 lines');
    expect(r.revert).toEqual({ via: 'history.revert', file: 'src/main.ts' });
  });
});

suite('grouping', () => {
  it('groups by file and credits the last author', () => {
    const ds = [json({ from: '#000000', to: '#ffffff' }), { file: 'src/tuning.ts', kind: 'tunable', op: 'set', target: 'tunables:hook', path: 'range', from: 1, to: 2, text: '' } as ChangeDelta];
    const g = groupRows(ds, lookup, lastAuthors([{ by: 'you', deltas: ds.slice(0, 1) }, { by: 'ai:test', deltas: ds.slice(1) }]));
    expect(g.map((x) => [x.file, x.kind, x.by])).toEqual([['config/look/dawn.json', 'config', 'you'], ['src/tuning.ts', 'code', 'ai:test']]);
    expect(g[0]!.title).toBe('look/dawn');
  });
  it('shows booleans and ranges', () => {
    expect(show(true).text).toBe('on');
    expect(show([2, 5], { pointer: '', label: '', group: '', widget: 'range', unit: 's', step: 0.5 }).text).toBe('2.0 to 5.0 s');
  });
});
