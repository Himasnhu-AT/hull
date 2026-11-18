// Every config kind as a TypeBox schema, emitted as JSON Schema into /schemas. M0 kinds: the manifest
// (hull.json, kind 'game'), tuning and material. Runs in Node and the browser.
import { inputMapSchema, type InputMap } from './input-map.ts';
import { materialSchema, type Material } from './material.ts';
import { manifestSchema, type Manifest } from './manifest.ts';
import { tuningSchema, type Tuning } from './tuning.ts';
import { uiScreenSchema, type UiScreenDef } from './ui-screen.ts';
import { uiThemeSchema, type UiTheme } from './ui-theme.ts';

export { inputMapSchema, manifestSchema, materialSchema, tuningSchema, uiScreenSchema, uiThemeSchema };
export type { InputMap, Manifest, Material, Tuning, UiScreenDef, UiTheme };
export * from './ui.ts';

/** Kinds that live under config/<kind>/. The manifest is separate: it is hull.json at the project root. */
export const kinds: Readonly<Record<string, object>> = {
  'input-map': inputMapSchema,
  material: materialSchema,
  tuning: tuningSchema,
  'ui-screen': uiScreenSchema,
  'ui-theme': uiThemeSchema,
};

/** Value types per kind, so `config.get('tuning', id)` is typed. */
declare module '../config/types.ts' {
  interface HullKinds {
    tuning: Tuning;
    material: Material;
    'input-map': InputMap;
    'ui-screen': UiScreenDef;
    'ui-theme': UiTheme;
  }
}

/** Filename to JSON text, one per kind plus the manifest, draft 2020-12. */
export function emitSchemas(): Record<string, string> {
  const out: Record<string, string> = {};
  const all: Record<string, object> = { game: manifestSchema, ...kinds };
  for (const [name, schema] of Object.entries(all)) {
    const doc = { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: `urn:hull:schema:${name}`, ...schema };
    out[`${name}.schema.json`] = `${JSON.stringify(doc, null, 2)}\n`;
  }
  return out;
}
