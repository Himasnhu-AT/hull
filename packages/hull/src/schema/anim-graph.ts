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
  },
  { additionalProperties: false },
);

const layer = Type.Object(
  {
    mask: Type.Optional(Type.Array(Type.String(), { ...ui({ help: 'Bones this layer moves, with everything below them.' }) })),
    additive: Type.Optional(Type.Boolean({ default: false })),
    weight: Type.Optional(Type.Number({ minimum: 0, maximum: 1, default: 1 })),
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
    ik: Type.Optional(
      Type.Object(
        {
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
