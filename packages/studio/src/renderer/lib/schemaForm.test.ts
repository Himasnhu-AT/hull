import { describe, expect, it } from 'vitest';
import type { TunableWire } from 'hull/dev/protocol';
import { advancedCount, buildForm, groupFields, humanize, tunableFields, type Field } from './schemaForm.ts';

const flat = (g: ReturnType<typeof buildForm>): Field[] => g.flatMap((x) => [...x.dials, ...x.fields]);
const find = (g: ReturnType<typeof buildForm>, ptr: string): Field => {
  const f = flat(g).find((x) => x.pointer === ptr);
  if (!f) throw new Error(`no field ${ptr}; have ${flat(g).map((x) => x.pointer).join(', ')}`);
  return f;
};

const soundSchema = {
  type: 'object',
  properties: {
    kind: { const: 'sound' },
    bus: { type: 'string', default: 'sfx', 'x-ref': 'bus' },
    level: { type: 'number', minimum: -60, maximum: 12, 'x-ui': { widget: 'slider', unit: 'dB', step: 0.5, group: 'Mix' } },
    pitch: { $ref: '#/$defs/numberOrRange', 'x-ui': { widget: 'range', min: 0.25, max: 4, group: 'Mix' } },
    loop: { type: 'boolean' },
    limit: {
      type: 'object',
      properties: {
        minGap: { type: 'number', 'x-ui': { unit: 's' } },
        voices: { type: 'integer', minimum: 1, maximum: 32 },
        over: { enum: ['steal-oldest', 'skip'] },
      },
    },
    source: { oneOf: [
      { type: 'object', properties: { type: { const: 'synth' }, length: { type: 'number', minimum: 0.05, maximum: 8 }, layers: { type: 'object' } } },
      { type: 'object', properties: { type: { const: 'sample' }, file: { type: 'string' } } },
    ] },
  },
  $defs: { numberOrRange: { oneOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }] } },
};

const soundValue = { kind: 'sound', bus: 'sfx', level: -6, pitch: [0.95, 1.05], loop: false, limit: { minGap: 0.06, voices: 4, over: 'skip' }, source: { type: 'synth', length: 0.5, layers: { ring: {} } } };

describe('humanize', () => {
  it('writes plain words', () => {
    expect(humanize('airControl')).toBe('Air control');
    expect(humanize('min_gap')).toBe('Min gap');
    expect(humanize('x')).toBe('X');
  });
});

describe('buildForm', () => {
  const groups = buildForm(soundSchema, soundValue);

  it('skips the kind field and groups by x-ui.group or the nested object', () => {
    expect(groups.map((g) => g.name)).toEqual(['General', 'Mix', 'Limit', 'Source']);
    expect(flat(groups).some((f) => f.key === 'kind')).toBe(false);
  });

  it('maps types to widgets and keeps the schema hints', () => {
    const level = find(groups, '/level');
    expect(level).toMatchObject({ widget: 'slider', min: -60, max: 12, step: 0.5, unit: 'dB', label: 'Level' });
    expect(find(groups, '/loop').widget).toBe('toggle');
    expect(find(groups, '/bus')).toMatchObject({ widget: 'ref', refKind: 'bus' });
    expect(find(groups, '/limit/over')).toMatchObject({ widget: 'segments', options: ['steal-oldest', 'skip'] });
    expect(find(groups, '/limit/voices')).toMatchObject({ widget: 'slider', step: 1 });
    expect(find(groups, '/limit/minGap')).toMatchObject({ widget: 'number', unit: 's' });
  });

  it('resolves $ref and reads the range from x-ui', () => {
    expect(find(groups, '/pitch')).toMatchObject({ widget: 'range', min: 0.25, max: 4 });
  });

  it('follows the oneOf branch that matches the value, and leaves free-form objects as json', () => {
    expect(flat(groups).some((f) => f.pointer === '/source/file')).toBe(false);
    expect(find(groups, '/source/length').widget).toBe('slider');
    expect(find(groups, '/source/layers').widget).toBe('json');
    const sample = buildForm(soundSchema, { ...soundValue, source: { type: 'sample', file: 'a.wav' } });
    expect(find(sample, '/source/file').widget).toBe('text');
  });

  it('shows a number box when one bound is missing', () => {
    const g = buildForm({ type: 'object', properties: { n: { type: 'number', minimum: 0 } } }, { n: 1 });
    expect(find(g, '/n').widget).toBe('number');
  });

  it('makes a field per key of a number map (tuning files)', () => {
    const g = buildForm({ type: 'object', properties: { kind: { const: 'tuning' }, note: { type: 'string' } }, additionalProperties: { type: 'number' } }, { kind: 'tuning', note: 'n', spin: 1.2, bob: 3 });
    expect(flat(g).map((f) => f.pointer).sort()).toEqual(['/bob', '/note', '/spin']);
    expect(find(g, '/spin').widget).toBe('number');
  });

  it('detects colours, vec3 and dials, and gathers dials apart', () => {
    const g = buildForm({ type: 'object', properties: {
      tint: { type: 'string' },
      pos: { type: 'array', items: { type: 'number' } },
      gain: { type: 'number', minimum: 0, maximum: 1, 'x-ui': { widget: 'dial', group: 'Feel' } },
      drive: { type: 'number', minimum: 0, maximum: 1, 'x-ui': { widget: 'dial', group: 'Feel' } },
      mode: { enum: ['a', 'b', 'c', 'd', 'e'] },
    } }, { tint: '#ff8800', pos: [0, 1, 2], gain: 0.2, drive: 0.5, mode: 'a' });
    expect(find(g, '/tint').widget).toBe('color');
    expect(find(g, '/pos').widget).toBe('vec3');
    expect(find(g, '/mode').widget).toBe('select');
    const feel = g.find((x) => x.name === 'Feel')!;
    expect(feel.dials.map((d) => d.key)).toEqual(['gain', 'drive']);
    expect(feel.fields).toEqual([]);
  });

  it('honours order, and hides advanced fields until asked', () => {
    const schema = { type: 'object', properties: {
      a: { type: 'number', 'x-ui': { order: 2 } },
      b: { type: 'number', 'x-ui': { order: 1 } },
      c: { type: 'number', 'x-ui': { advanced: true } },
    } };
    const g = buildForm(schema, { a: 1, b: 2, c: 3 });
    expect(g[0]!.fields.map((f) => f.key)).toEqual(['b', 'a']);
    expect(advancedCount(schema, { a: 1, b: 2, c: 3 })).toBe(1);
    expect(buildForm(schema, { a: 1, b: 2, c: 3 }, { showAdvanced: true })[0]!.fields).toHaveLength(3);
  });

  it('survives an empty or odd schema', () => {
    expect(buildForm(undefined, {})).toEqual([]);
    expect(buildForm({}, 5)).toEqual([]);
  });
});

describe('tunableFields', () => {
  const t = (kind: TunableWire['kind'], value: unknown, opts: Record<string, unknown> = {}): TunableWire => ({ block: 'player', key: 'k', kind, value, opts, file: 'src/p.ts', line: 1, col: 1 });
  it('picks widgets from kind and opts', () => {
    expect(tunableFields([t('num', 1, { min: 0, max: 10, widget: 'dial' })])[0]).toMatchObject({ widget: 'dial', group: 'Player' });
    expect(tunableFields([t('num', 1, { min: 0, max: 10 })])[0]!.widget).toBe('slider');
    expect(tunableFields([t('num', 1, {})])[0]!.widget).toBe('number');
    expect(tunableFields([t('num', 1, { widget: 'dial' })])[0]!.widget).toBe('number');
    expect(tunableFields([t('choice', 'a', { options: ['a', 'b'] })])[0]).toMatchObject({ widget: 'segments', options: ['a', 'b'] });
    expect(tunableFields([t('vec', [0, 0, 0])])[0]!.widget).toBe('vec3');
    expect(tunableFields([t('curve', [[0, 0], [1, 1]])])[0]!.widget).toBe('curve');
    expect(tunableFields([t('range', [0, 1])])[0]!.widget).toBe('range');
    expect(tunableFields([t('color', '#ffffff')])[0]!.widget).toBe('color');
    expect(tunableFields([t('bool', true)])[0]!.widget).toBe('toggle');
  });
  it('groups by opts.group or block name', () => {
    const g = groupFields(tunableFields([t('bool', true, { group: 'Feel' }), t('bool', false)]));
    expect(g.map((x) => x.name)).toEqual(['Feel', 'Player']);
  });
});
