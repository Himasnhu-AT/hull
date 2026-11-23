import Type, { type Static } from 'typebox';
import { ref, ui } from './ui.ts';
import { pair, triple } from './tuples.ts';

// SCHEMAS.md section 11b. A level is a ground, blocks, things made from prefabs, named markers and scatter rules. The
// Level behaviour (kits/level) builds it; every solid goes on physics layer "world".
const block = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1 })),
    shape: Type.Optional(Type.Union([Type.Literal('box'), Type.Literal('cylinder')], { default: 'box', ...ui({ help: 'A cylinder stands on its flat end; its width and depth are the two diameters.' }) })),
    at: triple({ ...ui({ unit: 'm', help: 'Centre of the block.' }) }),
    size: triple({ ...ui({ unit: 'm', help: 'Full width, height and depth (before any turn).' }) }),
    rotDeg: Type.Optional(triple({ ...ui({ unit: 'deg', help: 'Turn about x, y and z, in degrees. A ramp is a box turned about x or z.' }) })),
    material: Type.String({ ...ref('material') }),
    solid: Type.Optional(Type.Boolean({ default: true, ...ui({ help: 'false: drawn only, nothing collides with it.' }) })),
  },
  { additionalProperties: false },
);

const thing = Type.Object(
  {
    prefab: Type.String({ ...ref('prefab') }),
    at: triple({ ...ui({ unit: 'm', help: 'Where the prefab origin goes.' }) }),
    yawDeg: Type.Optional(Type.Number({ default: 0, ...ui({ unit: 'deg', step: 5 }) })),
    scale: Type.Optional(Type.Number({ exclusiveMinimum: 0, default: 1, ...ui({ step: 0.05 }) })),
  },
  { additionalProperties: false },
);

const marker = Type.Object(
  {
    at: triple({ ...ui({ unit: 'm' }) }),
    yawDeg: Type.Optional(Type.Number({ default: 0, ...ui({ unit: 'deg', step: 5, help: 'Facing, as a camera yaw: 0 looks down -z.' }) })),
  },
  { additionalProperties: false },
);

const scatter = Type.Object(
  {
    prefab: Type.String({ ...ref('prefab') }),
    count: Type.Integer({ minimum: 0, default: 5, ...ui({ widget: 'dial' }) }),
    area: Type.Object(
      {
        at: pair({ default: [0, 0], ...ui({ unit: 'm', help: 'Centre of the area on the floor: x and z.' }) }),
        size: pair({ ...ui({ unit: 'm', help: 'Width and depth of the area.' }) }),
      },
      { additionalProperties: false },
    ),
    stream: Type.String({ minLength: 1, ...ui({ help: 'Name of the world random stream the positions are drawn from, so a seed gives one layout.' }) }),
    gap: Type.Optional(Type.Number({ minimum: 0, default: 1, ...ui({ unit: 'm', help: 'Clear space kept between the new thing and everything solid.' }) })),
    avoidMarkers: Type.Optional(Type.Number({ minimum: 0, default: 3, ...ui({ unit: 'm', help: 'Distance kept from every marker, so the start and the goals stay clear.' }) })),
    randomYaw: Type.Optional(Type.Boolean({ default: true })),
  },
  { additionalProperties: false },
);

export const levelSchema = Type.Object(
  {
    kind: Type.Literal('level'),
    note: Type.Optional(Type.String()),
    look: Type.Optional(Type.String({ ...ref('look') })),
    ground: Type.Object(
      {
        size: pair({ default: [40, 40], ...ui({ unit: 'm', help: 'Width and depth, centred on the origin.' }) }),
        material: Type.String({ ...ref('material') }),
      },
      { additionalProperties: false },
    ),
    walls: Type.Optional(
      Type.Object(
        {
          height: Type.Number({ exclusiveMinimum: 0, default: 2.5, ...ui({ unit: 'm' }) }),
          thickness: Type.Optional(Type.Number({ exclusiveMinimum: 0, default: 0.6, ...ui({ unit: 'm' }) })),
          material: Type.String({ ...ref('material') }),
        },
        { additionalProperties: false, ...ui({ help: 'Four walls just outside the ground edge.' }) },
      ),
    ),
    blocks: Type.Optional(Type.Array(block)),
    things: Type.Optional(Type.Array(thing)),
    markers: Type.Optional(Type.Record(Type.String({ minLength: 1 }), marker, ui({ help: 'Named points: where the player starts, where enemies come from, the goal.' }))),
    scatter: Type.Optional(Type.Array(scatter)),
  },
  { additionalProperties: false, title: 'Hull level' },
);

export type Level = Static<typeof levelSchema>;
export type LevelBlock = Static<typeof block>;
export type LevelThing = Static<typeof thing>;
export type LevelMarker = Static<typeof marker>;
export type LevelScatter = Static<typeof scatter>;
