import { describe, expect, it } from 'vitest';
import type { ChangeDelta, TunableWire } from 'hull/dev/protocol';
import { configValues, tunableValues } from './valuesTable.ts';

const tun = (key: string, value: unknown, opts: Record<string, unknown> = {}): TunableWire => ({ block: 'player', key, kind: 'num', value, opts, file: 'src/player.ts', line: 1, col: 1 });
const delta = (target: string, path: string, from: unknown, to: unknown, kind: ChangeDelta['kind'] = 'tunable'): ChangeDelta => ({ file: 'f', kind, op: 'set', target, path, from, to, text: '' });

describe('tunableValues', () => {
  const list = [tun('jumpHeight', 1.6, { unit: 'm', min: 0, max: 5, step: 0.1 }), tun('runSpeed', 7), { ...tun('x', 1), block: 'other' }];
  it('names each value in words, with its unit', () => {
    const v = tunableValues('player', list, null);
    expect(v.rows.map((r) => r.name)).toEqual(['Jump height', 'Run speed']);
    expect(v.rows[0]!.value).toBe('1.6 m');
    expect(v.hasBefore).toBe(false);
    expect(v.rows[0]!.before).toBeUndefined();
  });
  it('shows what it was before, and "same" for what did not change', () => {
    const v = tunableValues('player', list, [delta('tunables:player', 'jumpHeight', 2, 1.6)]);
    expect(v.hasBefore).toBe(true);
    expect(v.rows[0]).toMatchObject({ before: '2.0 m', changed: true });
    expect(v.rows[1]).toMatchObject({ before: 'same', changed: false });
  });
  it('says new for a value the stage added', () => {
    const v = tunableValues('player', list, [{ ...delta('tunables:player', 'runSpeed', undefined, 7), op: 'add' }]);
    expect(v.rows[1]!.before).toBe('new');
  });
});

describe('configValues', () => {
  const schema = { type: 'object', properties: { kind: { const: 'tuning' }, size: { type: 'number', minimum: 10, maximum: 80 }, crateCount: { type: 'integer', minimum: 0, maximum: 60 } } };
  it('lists the fields of a config', () => {
    const v = configValues('tuning/arena', schema, { kind: 'tuning', size: 40, crateCount: 14 }, null);
    const names = v.rows.map((r) => r.name);
    expect(names).toContain('Size');
    expect(names).toContain('Crate count');
    expect(v.rows.find((r) => r.name === 'Crate count')!.value).toBe('14');
  });
  it('compares with the earlier point by pointer', () => {
    const v = configValues('tuning/arena', schema, { size: 40, crateCount: 20 }, [delta('tuning/arena', '/crateCount', 14, 20, 'json')]);
    expect(v.rows.find((r) => r.name === 'Crate count')).toMatchObject({ before: '14', changed: true });
    expect(v.rows.find((r) => r.name === 'Size')).toMatchObject({ before: 'same' });
  });
});
