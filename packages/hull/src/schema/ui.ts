// The x-ui and x-ref keywords (SCHEMAS.md section 1). JSON Schema says what is valid; these say how the Studio edits it
// and which kind of file a string points at.

export type Widget =
  | 'slider' | 'dial' | 'number' | 'toggle' | 'select' | 'segments' | 'color'
  | 'curve' | 'vec3' | 'range' | 'ref' | 'text' | 'keys';

export interface UiHints {
  widget?: Widget;
  /** Shown after the value: m, s, dB, Hz, deg, %. */
  unit?: string;
  step?: number;
  group?: string;
  order?: number;
  help?: string;
  /** false when a change needs the bench restarted. Default true. */
  live?: boolean;
  /** Hidden until "show all". */
  advanced?: boolean;
}

/** Spread into a TypeBox options object: `Type.Number({ minimum: 0, ...ui({ unit: 'm' }) })`. */
export function ui(hints: UiHints): { 'x-ui': UiHints } {
  return { 'x-ui': hints };
}

/** Options for a string field that holds the id of another config file of `kind`. */
export function ref(kind: string, hints: UiHints = {}): { 'x-ref': string; 'x-ui': UiHints } {
  return { 'x-ref': kind, 'x-ui': { widget: 'ref', ...hints } };
}

/** The colour format used everywhere: "#rrggbb". */
export const colorPattern = '^#[0-9a-fA-F]{6}$';
