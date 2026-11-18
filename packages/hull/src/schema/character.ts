import Type, { type Static } from 'typebox';
import { colorPattern, ref, ui } from './ui.ts';

// SCHEMAS.md section 6. A character is a body (bones plus shaped parts), the materials it is made of, where things
// attach (sockets), and which animation files it uses. Lengths are metres; the body faces -Z, +Y is up, +X is the
// character's right.
// TypeBox writes tuples in the draft 7 way; the schemas here are draft 2020-12, so a fixed-length array is spelled out.
export const vec3Schema = { type: 'array', prefixItems: [{ type: 'number' }, { type: 'number' }, { type: 'number' }], minItems: 3, maxItems: 3, items: false } as const;
const vec3 = Type.Unsafe<[number, number, number]>({ ...vec3Schema, ...ui({ widget: 'vec3' }) });

const proportions = Type.Object(
  {
    height: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 200, default: 1.78, ...ui({ unit: 'm', step: 0.01, help: 'Top of the head above the floor. A 15 m titan is just a bigger number.' }) })),
    shoulders: Type.Optional(Type.Number({ exclusiveMinimum: 0, ...ui({ unit: 'm', step: 0.01, help: 'Shoulder width. Default: 0.247 of the height.' }) })),
    legs: Type.Optional(Type.Number({ minimum: 0.3, maximum: 0.7, default: 0.52, ...ui({ widget: 'slider', step: 0.01, help: 'Hip height as a fraction of the height.' }) })),
    head: Type.Optional(Type.Number({ exclusiveMinimum: 0, ...ui({ unit: 'm', step: 0.01, help: 'Head height. Default: 0.129 of the height.' }) })),
    arms: Type.Optional(Type.Number({ minimum: 0.2, maximum: 0.6, default: 0.37, ...ui({ widget: 'slider', step: 0.01, help: 'Shoulder to fingertip, as a fraction of the height.' }) })),
    build: Type.Optional(Type.Number({ minimum: 0.4, maximum: 2.5, default: 1, ...ui({ widget: 'slider', step: 0.05, help: 'Thickness of the limbs and torso.' }) })),
  },
  { additionalProperties: false },
);

const bone = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    parent: Type.Optional(Type.String({ ...ui({ help: 'Name of an earlier bone. Leave out for a root.' }) })),
    offset: vec3,
  },
  { additionalProperties: false },
);

const material = Type.String({ ...ui({ help: 'A key of "materials" on this character.' }) });

// A part is drawn in its bone's space. `limb` is a tapered capsule between two points; `box` and `sphere` are
// centred, with `size` giving the full extents (a sphere with unequal sizes is an ellipsoid).
const part = Type.Object(
  {
    bone: Type.String({ minLength: 1 }),
    shape: Type.Union([Type.Literal('limb'), Type.Literal('box'), Type.Literal('sphere')], ui({ widget: 'segments' })),
    material: Type.Optional(material),
    color: Type.Optional(Type.String({ pattern: colorPattern, ...ui({ widget: 'color', help: 'Used when there is no material.' }) })),
    from: Type.Optional(vec3),
    to: Type.Optional(vec3),
    radius: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    radiusEnd: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    center: Type.Optional(vec3),
    size: Type.Optional(vec3),
  },
  { additionalProperties: false },
);

export const characterSchema = Type.Object(
  {
    kind: Type.Literal('character'),
    note: Type.Optional(Type.String()),
    body: Type.Object(
      {
        type: Type.Union([Type.Literal('generated'), Type.Literal('gltf')], { default: 'generated', ...ui({ widget: 'segments' }) }),
        recipe: Type.Optional(Type.Union([Type.Literal('humanoid'), Type.Literal('custom')], { default: 'humanoid', ...ui({ widget: 'segments', help: 'custom uses only the bones and parts listed here.' }) })),
        proportions: Type.Optional(proportions),
        bones: Type.Optional(Type.Array(bone, { ...ui({ help: 'Custom recipe: parents before children.' }) })),
        parts: Type.Optional(Type.Array(part, { ...ui({ help: 'Added to the humanoid recipe, or the whole body for custom.' }) })),
        scale: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 100, default: 1, ...ui({ help: 'Uniform multiplier on every length.' }) })),
        file: Type.Optional(Type.String({ ...ui({ help: 'gltf only.' }) })),
        joints: Type.Optional(Type.Record(Type.String(), Type.String(), ui({ help: 'gltf only: engine joint name to the model\'s.' }))),
      },
      { additionalProperties: false },
    ),
    materials: Type.Optional(
      Type.Record(Type.String(), Type.String({ ...ref('material') }), ui({ help: 'Roles used by the humanoid recipe: skin, cloth, metal, boots.' })),
    ),
    sockets: Type.Optional(
      Type.Record(Type.String(), Type.Object({ joint: Type.String(), offset: Type.Optional(vec3) }, { additionalProperties: false })),
    ),
    collider: Type.Optional(
      Type.Object(
        {
          shape: Type.Union([Type.Literal('capsule'), Type.Literal('box'), Type.Literal('sphere')]),
          radius: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
          height: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
        },
        { additionalProperties: false },
      ),
    ),
    animSet: Type.Optional(Type.String({ ...ref('anim-set') })),
    animGraph: Type.Optional(Type.String({ ...ref('anim-graph') })),
  },
  { additionalProperties: false, title: 'Hull character' },
);

export type Character = Static<typeof characterSchema>;
export type CharacterPart = Static<typeof part>;
