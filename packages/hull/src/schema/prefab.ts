import Type, { type Static } from 'typebox';
import { ref, ui } from './ui.ts';
import { triple } from './tuples.ts';

// SCHEMAS.md section 11b. A prefab is a small thing made of shapes: what it looks like, what is solid about it, and which
// groups it joins. It names no behaviours; game code attaches those to what a level built from it. A part is a shape with a
// material, or a glTF file from assets/ (`model`), whose own materials are kept unless `material` is given.
const part = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, ...ui({ help: 'Name of the node; the shape name when left out.' }) })),
    shape: Type.Optional(Type.Union([Type.Literal('box'), Type.Literal('sphere'), Type.Literal('cylinder'), Type.Literal('capsule')], { default: 'box' })),
    model: Type.Optional(Type.String({ minLength: 1, ...ui({ help: 'A .glb or .gltf file inside assets/, like "models/crate.glb", drawn instead of the shape. `size` then scales it (1, 1, 1 keeps its own size).' }) })),
    at: triple({ default: [0, 0, 0], ...ui({ unit: 'm', help: 'Centre of the part, from the prefab origin (on the floor under it).' }) }),
    size: triple({ default: [1, 1, 1], ...ui({ unit: 'm', help: 'Full width, height and depth.' }) }),
    rotDeg: Type.Optional(triple({ ...ui({ unit: 'deg', help: 'Turn about x, y and z, in degrees.' }) })),
    material: Type.Optional(Type.String({ ...ref('material'), ...ui({ help: 'Needed by a shape. On a model it replaces the materials of the file.' }) })),
  },
  { additionalProperties: false },
);

const collider = Type.Object(
  {
    shape: Type.Union([Type.Literal('box'), Type.Literal('sphere'), Type.Literal('capsule')], { default: 'box' }),
    at: Type.Optional(triple({ ...ui({ unit: 'm', help: 'Centre of the collider, from the prefab origin.' }) })),
    size: triple({ default: [1, 1, 1], ...ui({ unit: 'm', help: 'Full extent. A sphere uses the first number as its diameter; a capsule uses the first as its diameter and the second as its height.' }) }),
  },
  { additionalProperties: false, ...ui({ help: 'The solid part, on physics layer "world", static. Leave it out for decoration that no one bumps into.' }) },
);

export const prefabSchema = Type.Object(
  {
    kind: Type.Literal('prefab'),
    note: Type.Optional(Type.String()),
    parts: Type.Array(part, { minItems: 1 }),
    collider: Type.Optional(collider),
    tags: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true, ...ui({ help: 'Groups the thing joins, so game code finds it with world.group(tag).' }) })),
  },
  { additionalProperties: false, title: 'Hull prefab' },
);

export type Prefab = Static<typeof prefabSchema>;
