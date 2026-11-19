// Every config kind as a TypeBox schema, emitted as JSON Schema into /schemas. M0 kinds: the manifest
// (hull.json, kind 'game'), tuning and material. Runs in Node and the browser.
import { animGraphSchema, type AnimGraph } from './anim-graph.ts';
import { animSetSchema, type AnimSet } from './anim-set.ts';
import { characterSchema, type Character, type CharacterHit } from './character.ts';
import { lookSchema, type Look } from './look.ts';
import { inputMapSchema, type InputMap } from './input-map.ts';
import { materialSchema, type Material } from './material.ts';
import { mixerSchema, type Mixer } from './mixer.ts';
import { soundSchema, type Sound } from './sound.ts';
import { manifestSchema, type Manifest } from './manifest.ts';
import { tuningSchema, type Tuning } from './tuning.ts';
import { uiScreenSchema, type UiScreenDef } from './ui-screen.ts';
import { uiThemeSchema, type UiTheme } from './ui-theme.ts';
import { vfxSchema, type Vfx } from './vfx.ts';

export { animGraphSchema, animSetSchema, characterSchema, inputMapSchema, lookSchema, manifestSchema, materialSchema, mixerSchema, soundSchema, tuningSchema, uiScreenSchema, uiThemeSchema, vfxSchema };
export type { AnimGraph, AnimSet, Character, CharacterHit, InputMap, Look, Manifest, Material, Mixer, Sound, Tuning, UiScreenDef, UiTheme, Vfx };
export * from './ui.ts';

/** Kinds that live under config/<kind>/. The manifest is separate: it is hull.json at the project root. */
export const kinds: Readonly<Record<string, object>> = {
  'anim-graph': animGraphSchema,
  'anim-set': animSetSchema,
  character: characterSchema,
  'input-map': inputMapSchema,
  look: lookSchema,
  material: materialSchema,
  mixer: mixerSchema,
  sound: soundSchema,
  tuning: tuningSchema,
  'ui-screen': uiScreenSchema,
  'ui-theme': uiThemeSchema,
  vfx: vfxSchema,
};

/** Value types per kind, so `config.get('tuning', id)` is typed. */
declare module '../config/types.ts' {
  interface HullKinds {
    tuning: Tuning;
    material: Material;
    look: Look;
    mixer: Mixer;
    sound: Sound;
    'input-map': InputMap;
    'ui-screen': UiScreenDef;
    'ui-theme': UiTheme;
    vfx: Vfx;
    character: Character;
    'anim-set': AnimSet;
    'anim-graph': AnimGraph;
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
