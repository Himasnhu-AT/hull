import { describe, expect, it } from 'vitest';
import type { TunableWire } from 'hull/dev/protocol';
import { advancedCount, buildForm, defaultFor, groupFields, humanize, itemTitle, listItemFields, mapEntryFields, tunableFields, type Field } from './schemaForm.ts';

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

const lit = (v: string) => ({ type: 'string', const: v });

describe('unions of constants', () => {
  it('draws up to four as segments, with the options, even when x-ui asked for segments', () => {
    const schema = { type: 'object', properties: { type: { anyOf: [lit('generated'), lit('gltf')], default: 'generated', 'x-ui': { widget: 'segments' } } } };
    const f = find(buildForm(schema, { type: 'gltf' }), '/type');
    expect(f).toMatchObject({ widget: 'segments', options: ['generated', 'gltf'], value: 'gltf' });
  });
  it('draws more than four as a select, and keeps number constants numbers', () => {
    const schema = { type: 'object', properties: {
      shape: { oneOf: ['a', 'b', 'c', 'd', 'e'].map(lit) },
      n: { anyOf: [{ const: 1 }, { const: 2 }] },
      e5: { enum: ['a', 'b', 'c', 'd', 'e'], 'x-ui': { widget: 'segments' } },
    } };
    const g = buildForm(schema, { shape: 'a', n: 2, e5: 'b' });
    expect(find(g, '/shape')).toMatchObject({ widget: 'select', options: ['a', 'b', 'c', 'd', 'e'] });
    expect(find(g, '/n')).toMatchObject({ widget: 'segments', options: ['1', '2'], optionValues: [1, 2] });
    expect(find(g, '/e5').widget).toBe('select');
  });
  it('never renders an unknown shape as nothing: it is a labelled JSON field', () => {
    const f = find(buildForm({ type: 'object', properties: { odd: { anyOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'boolean' }] } } }, { odd: 7 }), '/odd');
    expect(f).toMatchObject({ widget: 'json', fallback: true });
    expect(find(buildForm({ type: 'object', properties: { free: {} } }, { free: 3 }), '/free')).toMatchObject({ widget: 'json', fallback: true });
  });
});

describe('maps', () => {
  const schema = { type: 'object', properties: {
    kind: { const: 'character' },
    materials: { type: 'object', patternProperties: { '^.*$': { type: 'string', 'x-ref': 'material' } } },
    sockets: { type: 'object', patternProperties: { '^.*$': { type: 'object', required: ['joint'], properties: { joint: { type: 'string' }, scale: { type: 'number', minimum: 0, maximum: 2, default: 1 } } } } },
    tags: { type: 'object', additionalProperties: { type: 'number' } },
  } };
  const value = { kind: 'character', materials: { skin: 'material/skin' }, sockets: { hand: { joint: 'wrist' } } };
  const g = buildForm(schema, value);

  it('makes one map field for patternProperties and additionalProperties maps', () => {
    for (const p of ['/materials', '/sockets', '/tags']) expect(find(g, p).widget).toBe('map');
    expect(find(g, '/materials').valueSchema).toMatchObject({ 'x-ref': 'material' });
  });
  it('gives each entry the widget its schema says, a ref for x-ref values', () => {
    const mat = mapEntryFields(find(g, '/materials'), 'skin', 'material/skin');
    expect(mat).toHaveLength(1);
    expect(mat[0]).toMatchObject({ pointer: '/materials/skin', widget: 'ref', refKind: 'material', label: '' });
    const sock = mapEntryFields(find(g, '/sockets'), 'hand', { joint: 'wrist' });
    expect(sock.map((f) => [f.pointer, f.widget])).toEqual([['/sockets/hand/joint', 'text'], ['/sockets/hand/scale', 'slider']]);
  });
  it('escapes a key with a slash in its pointer', () => {
    expect(mapEntryFields(find(g, '/tags'), 'a/b', 3)[0]!.pointer).toBe('/tags/a~1b');
  });
  it('makes a starting value for a new entry from the schema', () => {
    const f = find(g, '/sockets');
    expect(defaultFor(f.schemaRoot!, f.valueSchema)).toEqual({ joint: '' });
    expect(defaultFor({}, { type: 'string', 'x-ref': 'material' }, ['material/a'])).toBe('material/a');
    expect(defaultFor({}, { anyOf: [lit('x'), lit('y')] })).toBe('x');
  });
});

describe('values missing from the file', () => {
  it('shows the schema default, marked unset, instead of zero', () => {
    const schema = { type: 'object', properties: {
      height: { type: 'number', minimum: 0, maximum: 5, default: 1.78 },
      nodefault: { type: 'number' },
      body: { type: 'object', properties: { legs: { type: 'number', minimum: 0, maximum: 1, default: 0.52 } } },
    } };
    const g = buildForm(schema, { nodefault: 4 });
    expect(find(g, '/height')).toMatchObject({ value: 1.78, def: 1.78, unset: true });
    expect(find(g, '/body/legs')).toMatchObject({ value: 0.52, unset: true });
    expect(find(g, '/nodefault')).toMatchObject({ value: 4, unset: false });
    expect(find(buildForm(schema, { height: 2 }), '/height')).toMatchObject({ value: 2, unset: false });
  });
  it('treats a field with neither value nor default as unset with no value', () => {
    expect(find(buildForm({ type: 'object', properties: { x: { type: 'number' } } }, {}), '/x')).toMatchObject({ unset: true, value: undefined });
  });
});

describe('lists and big optional objects', () => {
  it('draws an array of strings as a comma list', () => {
    const g = buildForm({ type: 'object', properties: { features: { type: 'array', items: { type: 'string' } } } }, { features: ['audio'] });
    expect(find(g, '/features').widget).toBe('keys');
  });
  it('hides the fields of a long optional object the file leaves out, until Show all', () => {
    const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, { type: 'string' }]));
    const schema = { type: 'object', properties: { node: { type: 'object', properties: many }, small: { type: 'object', properties: { a: { type: 'string' } } } } };
    expect(flat(buildForm(schema, {})).map((f) => f.pointer)).toEqual(['/small/a']);
    expect(flat(buildForm(schema, {}, { showAdvanced: true }))).toHaveLength(11);
    expect(flat(buildForm(schema, { node: { f0: 'x' } })).length).toBe(11);
  });
});

describe('arrays of objects and arrays of choices', () => {
  const transitions = {
    type: 'array',
    items: { type: 'object', required: ['from', 'to'], properties: {
      from: { type: 'string' }, to: { type: 'string' }, when: { type: 'string' },
      blend: { type: 'number', minimum: 0, maximum: 1, default: 0.15, 'x-ui': { unit: 's' } },
    }, additionalProperties: false },
  };
  const graph = { type: 'object', properties: { layers: { type: 'object', patternProperties: { '^.*$': { type: 'object', properties: { transitions } } } } } };
  const rows = [{ from: 'idle', to: 'walk', when: 'speed > 0.1', blend: 0.2 }, { from: '*', to: 'fall' }];

  it('draws an array of objects as a list, not as JSON', () => {
    const g = buildForm({ type: 'object', properties: { transitions } }, { transitions: rows });
    expect(find(g, '/transitions')).toMatchObject({ widget: 'list', fallback: false });
  });
  it('gives each row its own fields, with pointers below the row', () => {
    const f = find(buildForm({ type: 'object', properties: { transitions } }, { transitions: rows }), '/transitions');
    const row = listItemFields(f, 1, rows[1]);
    expect(row.map((x) => x.pointer)).toEqual(['/transitions/1/from', '/transitions/1/to', '/transitions/1/when', '/transitions/1/blend']);
    expect(row.find((x) => x.key === 'blend')).toMatchObject({ widget: 'slider', unit: 's', unset: true, value: 0.15 });
    expect(row.find((x) => x.key === 'to')).toMatchObject({ widget: 'text', value: 'fall' });
  });
  it('finds the list inside a map entry too (the transitions of an anim-graph layer)', () => {
    const layers = find(buildForm(graph, { layers: { base: { transitions: rows } } }), '/layers');
    const layer = mapEntryFields(layers, 'base', { transitions: rows });
    expect(layer.find((x) => x.pointer === '/layers/base/transitions')).toMatchObject({ widget: 'list' });
  });
  it('titles a closed row by what it says', () => {
    expect(itemTitle(rows[0], 0)).toBe('idle → walk · speed > 0.1');
    expect(itemTitle(rows[1], 1)).toBe('* → fall');
    expect(itemTitle({ name: 'hips', parent: 'x' }, 0)).toBe('hips');
    expect(itemTitle({}, 2)).toBe('3');
  });
  it('starts a new row from the schema (required fields filled)', () => {
    const f = find(buildForm({ type: 'object', properties: { transitions } }, { transitions: rows }), '/transitions');
    expect(defaultFor(f.schemaRoot ?? {}, f.valueSchema)).toEqual({ from: '', to: '' });
  });
  it('draws an array of choices as checks, with the real values behind each', () => {
    const schema = { type: 'object', properties: {
      features: { type: 'array', items: { enum: ['audio', 'anim', 'ui'] } },
      systems: { type: 'array', items: { anyOf: [{ const: 'mac' }, { const: 'win' }] } },
    } };
    const g = buildForm(schema, { features: ['anim'] });
    expect(find(g, '/features')).toMatchObject({ widget: 'checks', options: ['audio', 'anim', 'ui'], optionValues: ['audio', 'anim', 'ui'], value: ['anim'] });
    expect(find(g, '/systems')).toMatchObject({ widget: 'checks', options: ['mac', 'win'] });
  });
  it('keeps an array of plain strings a comma list, and an array of numbers a vector', () => {
    const g = buildForm({ type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } }, p: { type: 'array', items: { type: 'number' } } } }, { tags: ['a'], p: [1, 2, 3] });
    expect(find(g, '/tags').widget).toBe('keys');
    expect(find(g, '/p').widget).toBe('vec3');
  });
});
