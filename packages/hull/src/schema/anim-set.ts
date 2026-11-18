import Type, { type Static } from 'typebox';
import { vec3Schema } from './character.ts';
import { ui } from './ui.ts';

// SCHEMAS.md section 6. Rotations are Euler XYZ in radians, on top of the bone's rest pose. For a limb that hangs
// down, +x swings it forward; for a bone that points up, +x tips it backward. Offsets are metres for a 1.78 m body
// and scale with the character's height.
const key = Type.Unsafe<[number, [number, number, number]]>({
  type: 'array', prefixItems: [{ type: 'number', minimum: 0 }, vec3Schema], minItems: 2, maxItems: 2, items: false,
});

const track = Type.Object(
  {
    rotation: Type.Optional(Type.Array(key, { minItems: 1, ...ui({ help: '[time, [x, y, z]] in seconds and radians.' }) })),
    offset: Type.Optional(Type.Array(key, { minItems: 1 })),
  },
  { additionalProperties: false },
);

const clip = Type.Object(
  {
    type: Type.Union([Type.Literal('keyframes'), Type.Literal('generated'), Type.Literal('gltf')], ui({ widget: 'segments' })),
    loop: Type.Optional(Type.Boolean({ default: false })),
    length: Type.Optional(Type.Number({ exclusiveMinimum: 0, ...ui({ unit: 's', help: 'Keyframes: required. Generated: overrides the generator\'s own length.' }) })),
    speed: Type.Optional(Type.Number({ exclusiveMinimum: 0, default: 1, ...ui({ help: 'Playback multiplier.' }) })),
    travel: Type.Optional(Type.Number({ minimum: 0, ...ui({ unit: 'm/s', help: 'Ground speed the feet in this clip are authored for. Lets a graph match playback to speed and report foot slide.' }) })),
    curve: Type.Optional(Type.Union([Type.Literal('smooth'), Type.Literal('linear')], { default: 'smooth', ...ui({ widget: 'segments' }) })),
    generator: Type.Optional(Type.String({ ...ui({ help: 'humanoid/idle, humanoid/walk, humanoid/run, procedural/breathe, procedural/sway, or one registered in code.' }) })),
    knobs: Type.Optional(Type.Record(Type.String(), Type.Number())),
    tracks: Type.Optional(Type.Record(Type.String(), track, ui({ help: 'Bone name to its keyframes.' }))),
    events: Type.Optional(
      Type.Record(Type.String(), Type.Union([Type.Number({ minimum: 0 }), Type.Array(Type.Number({ minimum: 0 }), { minItems: 1 })]), ui({ help: '0 to 1 of the loop for looping clips, seconds otherwise.' })),
    ),
    clip: Type.Optional(Type.String({ ...ui({ help: 'gltf only.' }) })),
  },
  { additionalProperties: false },
);

export const animSetSchema = Type.Object(
  {
    kind: Type.Literal('anim-set'),
    note: Type.Optional(Type.String()),
    clips: Type.Record(Type.String({ minLength: 1 }), clip),
  },
  { additionalProperties: false, title: 'Hull animation set' },
);

export type AnimSet = Static<typeof animSetSchema>;
export type ClipDef = Static<typeof clip>;
