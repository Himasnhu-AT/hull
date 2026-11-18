import Type, { type Static } from 'typebox';
import { colorPattern, ui } from './ui.ts';
import { colorKey, curveKey, pair, triple } from './tuples.ts';

// SCHEMAS.md section 10: a particle effect. `emit` says how many particles and where they start, `particle` how
// each one lives, `budget` how many may be alive at once.
const range = (def: [number, number], help: string, unit?: string) =>
  pair({ default: def, ...ui({ widget: 'range', help, ...(unit ? { unit } : {}) }) });
const vec3 = triple();
const curve = (help: string) => Type.Array(curveKey(), { minItems: 1, ...ui({ widget: 'curve', help }) });
const colorCurve = Type.Array(
  colorKey(colorPattern),
  { minItems: 1, ...ui({ widget: 'curve', help: 'Colour over the particle\'s life: [[0, "#ffffff"], [1, "#888888"]]. Time runs 0 (born) to 1 (gone).' }) },
);

export const vfxSchema = Type.Object(
  {
    kind: Type.Literal('vfx'),
    note: Type.Optional(Type.String()),
    emit: Type.Object(
      {
        count: Type.Optional(range([10, 10], 'Particles per burst, a whole number picked from this range.')),
        over: Type.Optional(Type.Number({ minimum: 0, ...ui({ unit: 's', help: 'Spread the burst over this long instead of at once.' }) })),
        rate: Type.Optional(Type.Number({ minimum: 0, ...ui({ unit: '/s', help: 'For trails: particles per second, laid along the path the node took.' }) })),
        shape: Type.Optional(
          Type.Union(
            [
              Type.Literal('point'),
              Type.Object({ sphere: Type.Number({ minimum: 0 }) }, { additionalProperties: false }),
              Type.Object({ disc: Type.Number({ minimum: 0 }) }, { additionalProperties: false }),
              Type.Object({ box: vec3 }, { additionalProperties: false }),
            ],
            { default: 'point', description: 'Where particles start: a point, a sphere or flat disc of this radius, or a box of these sizes.' },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    particle: Type.Object(
      {
        life: range([0.5, 1], 'Seconds a particle lives.', 's'),
        speed: Type.Optional(range([1, 2], 'Start speed.', 'm/s')),
        direction: Type.Optional(
          Type.Union(
            [
              Type.Object({ cone: vec3, angleDeg: Type.Number({ minimum: 0, maximum: 180 }) }, { additionalProperties: false }),
              Type.Object({ outward: Type.Literal(true) }, { additionalProperties: false }),
            ],
            { description: 'A cone around an axis (a burst call may aim it), or straight out from the emitter centre.' },
          ),
        ),
        gravity: Type.Optional(Type.Number({ default: 0, ...ui({ unit: 'm/s2', help: 'Acceleration along Y: negative falls, positive rises.' }) })),
        drag: Type.Optional(Type.Number({ minimum: 0, default: 0, ...ui({ unit: '1/s', help: 'Fraction of speed lost per second.' }) })),
        size: Type.Optional(curve('Size over life, in metres.')),
        sizeScale: Type.Optional(range([1, 1], 'Each particle multiplies its size curve by a number from this range.')),
        color: Type.Optional(colorCurve),
        alpha: Type.Optional(curve('Opacity over life, 0 to 1.')),
        glow: Type.Optional(Type.Number({ minimum: 0, default: 1, ...ui({ step: 0.1, help: 'Multiplies the colour. Above 1 makes it brighter than white so bloom picks it up.' }) })),
        spin: Type.Optional(range([0, 0], 'Turn speed of the sprite.', 'rad/s')),
        stretch: Type.Optional(Type.Number({ minimum: 0, default: 0, ...ui({ step: 0.01, help: 'Seconds of travel the sprite is stretched along its velocity. 0 keeps it round.' }) })),
        sprite: Type.Optional(Type.Union([Type.Literal('soft'), Type.Literal('smoke'), Type.Literal('hard'), Type.Literal('spark')], { default: 'soft', ...ui({ widget: 'select' }) })),
        blend: Type.Optional(Type.Union([Type.Literal('alpha'), Type.Literal('additive')], { default: 'alpha', ...ui({ widget: 'select' }) })),
      },
      { additionalProperties: false },
    ),
    budget: Type.Optional(
      Type.Object(
        {
          max: Type.Optional(Type.Integer({ minimum: 1, default: 400, ...ui({ help: 'Most particles alive at once. When full, new ones are skipped.' }) })),
          fadeNear: Type.Optional(Type.Number({ minimum: 0, default: 0, ...ui({ unit: 'm', help: 'Particles fade out when closer to the camera than this, so none fill the screen.' }) })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false, title: 'Hull vfx' },
);

export type Vfx = Static<typeof vfxSchema>;
