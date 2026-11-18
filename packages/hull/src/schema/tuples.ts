import Type, { type TSchema } from 'typebox';

// TypeBox's own Tuple writes the draft-07 `items: [...]` form, which the draft 2020-12 validator rejects. These
// write `prefixItems` and keep the TypeScript tuple type.
type Opts = Record<string, unknown>;

/** [number, number] */
export function pair(opts: Opts = {}) {
  return Type.Unsafe<[number, number]>({
    type: 'array', prefixItems: [{ type: 'number' }, { type: 'number' }], minItems: 2, maxItems: 2, items: false, ...opts,
  } as TSchema);
}

/** [number, number, number] */
export function triple(opts: Opts = {}) {
  return Type.Unsafe<[number, number, number]>({
    type: 'array', prefixItems: [{ type: 'number' }, { type: 'number' }, { type: 'number' }], minItems: 3, maxItems: 3, items: false, ...opts,
  } as TSchema);
}

/** [time 0..1, value] */
export function curveKey() {
  return Type.Unsafe<[number, number]>({
    type: 'array', prefixItems: [{ type: 'number', minimum: 0, maximum: 1 }, { type: 'number' }], minItems: 2, maxItems: 2, items: false,
  } as TSchema);
}

/** [time 0..1, '#rrggbb'] */
export function colorKey(pattern: string) {
  return Type.Unsafe<[number, string]>({
    type: 'array', prefixItems: [{ type: 'number', minimum: 0, maximum: 1 }, { type: 'string', pattern }], minItems: 2, maxItems: 2, items: false,
  } as TSchema);
}
