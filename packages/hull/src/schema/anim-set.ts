import Type, { type Static } from 'typebox';
import { vec3Schema } from './character.ts';
import { ui } from './ui.ts';

// SCHEMAS.md section 6. Rotations are Euler XYZ in radians, on top of the bone's rest pose. For a limb that hangs
// down, +x swings it forward; for a bone that points up, +x tips it backward. Offsets are metres for a 1.78 m body
// and scale with the character's height.
// A key may name how the curve travels from it to the next key (the "ease"): `smooth` (the clip's default Catmull-Rom
// curve through the keys), `linear`, `in` (slow, then fast: a strike that lands), `out` (fast, then slow: a wind-up
// that settles), `inOut`, `snap` (almost all of the move in the first moments, then a recoil) or `hold` (stays put
// until the next key, then jumps).
export const EASES = ['smooth', 'linear', 'in', 'out', 'inOut', 'snap', 'hold'] as const;
export type Ease = (typeof EASES)[number];
const key = Type.Unsafe<[number, [number, number, number]] | [number, [number, number, number], Ease]>({
  anyOf: [
    { type: 'array', prefixItems: [{ type: 'number', minimum: 0 }, vec3Schema], minItems: 2, maxItems: 2, items: false },
    { type: 'array', prefixItems: [{ type: 'number', minimum: 0 }, vec3Schema, { enum: [...EASES] }], minItems: 3, maxItems: 3, items: false },
  ],
});

// A time range inside a clip with a name the game reads (`hit`, `parry`, `iframe`, `cancel`, `trace`): [start, end].
const range = Type.Unsafe<[number, number]>({ type: 'array', prefixItems: [{ type: 'number', minimum: 0 }, { type: 'number', minimum: 0 }], minItems: 2, maxItems: 2, items: false });

const rootMotion = Type.Object(
  {
    bone: Type.Optional(Type.String({ default: 'hips', ...ui({ help: 'The bone whose travel is the character\'s travel.' }) })),
    axes: Type.Optional(Type.Union([Type.Literal('xz'), Type.Literal('xyz'), Type.Literal('y')], { default: 'xz', ...ui({ widget: 'segments', help: 'Which offset axes of the bone move the node. The rest stay in the pose.' }) })),
    turn: Type.Optional(Type.Boolean({ default: false, ...ui({ help: 'The bone\'s rotation about Y turns the node too.' }) })),
  },
  { additionalProperties: false },
);

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
    windows: Type.Optional(
      Type.Record(Type.String(), Type.Union([range, Type.Array(range, { minItems: 1 })]), ui({ help: 'Named time ranges [start, end] the game reads with animator.inWindow(name): hit, parry, iframe, cancel, trace. 0 to 1 of the loop for looping clips, seconds otherwise.' })),
    ),
    rootMotion: Type.Optional(Type.Union([Type.Boolean(), rootMotion], ui({ help: 'The root bone\'s travel moves the node (when the Animator has applyRootMotion) instead of the body inside it. true = hips, x and z.' }))),
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
export type RootMotionDef = Static<typeof rootMotion>;
