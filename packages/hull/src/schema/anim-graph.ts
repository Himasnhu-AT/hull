import Type, { type Static } from 'typebox';
import { ui } from './ui.ts';

// SCHEMAS.md section 6. `when` is a small expression over the parameters: comparisons, !, && and ||. Nothing else.
const param = Type.Object(
  {
    type: Type.Union([Type.Literal('number'), Type.Literal('boolean'), Type.Literal('trigger')], ui({ widget: 'segments' })),
    default: Type.Optional(Type.Union([Type.Number(), Type.Boolean()])),
    min: Type.Optional(Type.Number()),
    max: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

const point2 = Type.Object(
  { x: Type.Number(), y: Type.Number(), clip: Type.String({ ...ui({ help: 'Name of a clip in the anim-set.' }) }) },
  { additionalProperties: false },
);

const state = Type.Object(
  {
    clip: Type.Optional(Type.String({ ...ui({ help: 'Name of a clip in the anim-set.' }) })),
    blend: Type.Optional(
      Type.Object(
        {
          by: Type.String({ ...ui({ help: 'A number parameter.' }) }),
          points: Type.Record(Type.String({ pattern: '^-?[0-9]+(\\.[0-9]+)?$' }), Type.String(), ui({ help: 'Parameter value to clip.' })),
        },
        { additionalProperties: false },
      ),
    ),
    blend2d: Type.Optional(
      Type.Object(
        {
          x: Type.String({ ...ui({ help: 'A number parameter for the sideways axis.' }) }),
          y: Type.String({ ...ui({ help: 'A number parameter for the forward axis.' }) }),
          points: Type.Array(point2, { minItems: 1, maxItems: 24, ...ui({ help: 'Clips placed on the plane (a strafe space: idle at 0,0 and a walk in each direction). The clips are weighted by inverse distance to the parameters.' }) }),
        },
        { additionalProperties: false },
      ),
    ),
    speedFrom: Type.Optional(Type.String({ ...ui({ help: 'A number parameter (ground speed). Playback is scaled so the feet match it; the rest is foot slide.' }) })),
    speed: Type.Optional(Type.Number({ exclusiveMinimum: 0, default: 1 })),
    exit: Type.Optional(Type.String({ ...ui({ help: 'State to go to when a clip that plays once has finished.' }) })),
    exitBlend: Type.Optional(Type.Number({ minimum: 0, default: 0.1, ...ui({ unit: 's' }) })),
  },
  { additionalProperties: false },
);

const transition = Type.Object(
  {
    from: Type.String({ ...ui({ help: 'A state name, or * for any.' }) }),
    to: Type.String(),
    when: Type.Optional(Type.String()),
    blend: Type.Optional(Type.Number({ minimum: 0, default: 0.15, ...ui({ unit: 's' }) })),
    after: Type.Optional(Type.Number({ minimum: 0, ...ui({ unit: 's', help: 'Not before this long in the state.' }) })),
    sync: Type.Optional(Type.Boolean({ default: false, ...ui({ help: 'Start the new state at the same point of its cycle as the one it leaves (walk into run without the feet crossing wrongly).' }) })),
  },
  { additionalProperties: false },
);

const layer = Type.Object(
  {
    mask: Type.Optional(Type.Array(Type.String(), { ...ui({ help: 'Bones this layer moves, with everything below them.' }) })),
    additive: Type.Optional(Type.Boolean({ default: false })),
    weight: Type.Optional(Type.Number({ minimum: 0, maximum: 1, default: 1 })),
    weightFrom: Type.Optional(Type.String({ ...ui({ help: 'A number parameter (0 to 1) that scales the layer\'s weight: turn a layer on and off from the game.' }) })),
    start: Type.String(),
    states: Type.Record(Type.String({ minLength: 1 }), state),
    transitions: Type.Optional(Type.Array(transition)),
  },
  { additionalProperties: false },
);

export const animGraphSchema = Type.Object(
  {
    kind: Type.Literal('anim-graph'),
    note: Type.Optional(Type.String()),
    params: Type.Optional(Type.Record(Type.String({ minLength: 1 }), param)),
    layers: Type.Record(Type.String({ minLength: 1 }), layer),
    springs: Type.Optional(
      Type.Record(
        Type.String({ minLength: 1 }),
        Type.Object(
          {
            chain: Type.Array(Type.String(), { minItems: 1, ...ui({ help: 'Bones from the root of the chain to its tip (hair, sash, tassel). They swing from the body\'s own movement.' }) }),
            stiffness: Type.Optional(Type.Number({ exclusiveMinimum: 0, default: 120, ...ui({ unit: '1/s²', help: 'How hard the chain pulls back to its pose. The tip is softer.' }) })),
            damping: Type.Optional(Type.Number({ minimum: 0, default: 7, ...ui({ unit: '1/s', help: 'How fast the swing dies away.' }) })),
            drive: Type.Optional(Type.Number({ minimum: 0, default: 0.05, ...ui({ help: 'Radians of swing per m/s² of acceleration of the chain\'s root.' }) })),
            falloff: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1.5, default: 0.8, ...ui({ help: 'Stiffness of each bone along the chain, relative to the one before it.' }) })),
            limitDeg: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 180, default: 70, ...ui({ unit: 'deg' }) })),
          },
          { additionalProperties: false },
        ),
        ui({ help: 'Spring-driven secondary motion. Springs run on frame time and only move the picture.' }),
      ),
    ),
    hitReact: Type.Optional(
      Type.Object(
        {
          bones: Type.Optional(Type.Record(Type.String(), Type.Number({ minimum: 0 }), ui({ help: 'Bone to its share of the flinch. Default: hips, spine, chest, neck, head.' }))),
          angle: Type.Optional(Type.Number({ exclusiveMinimum: 0, default: 0.35, ...ui({ unit: 'rad', help: 'Lean of a full-strength hit, summed over the bones.' }) })),
          shift: Type.Optional(Type.Number({ minimum: 0, default: 0.05, ...ui({ unit: 'm', help: 'How far the hips are pushed along the hit.' }) })),
          stiffness: Type.Optional(Type.Number({ exclusiveMinimum: 0, default: 220 })),
          damping: Type.Optional(Type.Number({ minimum: 0, default: 16 })),
        },
        { additionalProperties: false },
      ),
    ),
    ik: Type.Optional(
      Type.Object(
        {
          grips: Type.Optional(
            Type.Record(
              Type.String(),
              Type.Object(
                {
                  socket: Type.String({ ...ui({ help: 'A socket of the character the hand holds, such as the hilt.' }) }),
                  weight: Type.Optional(Type.Number({ minimum: 0, maximum: 1, default: 1 })),
                  weightFrom: Type.Optional(Type.String({ ...ui({ help: 'A number parameter (0 to 1) that scales the weight.' }) })),
                },
                { additionalProperties: false },
              ),
              ui({ help: 'Hand bone to the socket it grips: two-bone IK puts the off-hand on the hilt whatever the clip does.' }),
            ),
          ),
          feet: Type.Optional(
            Type.Object(
              {
                enabled: Type.Boolean({ default: true }),
                maxStep: Type.Optional(Type.Number({ exclusiveMinimum: 0, default: 0.35, ...ui({ unit: 'm', help: 'Most a foot is moved to meet the ground, for a 1.78 m body; scales with height.' }) })),
              },
              { additionalProperties: false },
            ),
          ),
          look: Type.Optional(
            Type.Object(
              {
                enabled: Type.Boolean({ default: true }),
                weights: Type.Optional(Type.Record(Type.String(), Type.Number({ minimum: 0 }), ui({ help: 'Bone to its share of the turn, base to tip.' }))),
                yawDeg: Type.Optional(Type.Number({ minimum: 0, maximum: 180, default: 80 })),
                pitchDeg: Type.Optional(Type.Number({ minimum: 0, maximum: 90, default: 45 })),
                speed: Type.Optional(Type.Number({ exclusiveMinimum: 0, default: 8, ...ui({ unit: '1/s', help: 'How fast the look weight follows.' }) })),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false, title: 'Hull animation graph' },
);

export type AnimGraph = Static<typeof animGraphSchema>;
export type GraphLayerDef = Static<typeof layer>;
