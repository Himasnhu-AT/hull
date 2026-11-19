// SCHEMAS.md section 14: an explain document, the drawing the builder makes for a piece the person cannot judge by looking
// or listening (rules, enemy behaviour, the layout of the world, balance). It lives in .hull/explain/<id>.json, not under
// config/, so it is not one of the config `kinds`; the project server validates a write against this schema.
import Type, { type Static } from 'typebox';

const idPattern = '^[a-z0-9]+(-[a-z0-9]+)*$';
/** A PNG, JPEG or WebP picture inline, as a data URL. */
const dataUrl = Type.String({ pattern: '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$', maxLength: 8_000_000 });
const cell = Type.Union([Type.String({ maxLength: 400 }), Type.Number()]);
const unit = Type.Number({ minimum: 0, maximum: 1 });

const flow = Type.Object(
  {
    type: Type.Literal('flow'),
    nodes: Type.Array(
      Type.Object({ id: Type.String({ pattern: '^[A-Za-z0-9_-]+$', maxLength: 60 }), text: Type.String({ maxLength: 400 }), kind: Type.Optional(Type.Union([Type.Literal('step'), Type.Literal('ask'), Type.Literal('end')])) }, { additionalProperties: false }),
      { minItems: 1, maxItems: 80 },
    ),
    edges: Type.Array(
      Type.Object({ from: Type.String({ maxLength: 60 }), to: Type.String({ maxLength: 60 }), label: Type.Optional(Type.String({ maxLength: 120 })) }, { additionalProperties: false }),
      { maxItems: 200 },
    ),
  },
  { additionalProperties: false },
);
const map = Type.Object(
  {
    type: Type.Literal('map'),
    image: dataUrl,
    width: Type.Integer({ minimum: 1 }),
    height: Type.Integer({ minimum: 1 }),
    marks: Type.Array(Type.Object({ x: unit, y: unit, label: Type.String({ maxLength: 200 }) }, { additionalProperties: false }), { maxItems: 100 }),
  },
  { additionalProperties: false },
);
const table = Type.Object(
  {
    type: Type.Literal('table'),
    columns: Type.Array(Type.String({ maxLength: 120 }), { minItems: 1, maxItems: 20 }),
    rows: Type.Array(Type.Array(cell, { maxItems: 20 }), { maxItems: 200 }),
  },
  { additionalProperties: false },
);
const image = Type.Object({ type: Type.Literal('image'), image: dataUrl, width: Type.Integer({ minimum: 1 }), height: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });

export const explainSchema = Type.Object(
  {
    id: Type.String({ pattern: idPattern, maxLength: 80 }),
    title: Type.String({ minLength: 1, maxLength: 120 }),
    stage: Type.Union(['world', 'actors', 'animations', 'rules', 'sounds', 'effects', 'screens'].map((s) => Type.Literal(s))),
    why: Type.String({ minLength: 1, maxLength: 600 }),
    body: Type.Union([flow, map, table, image]),
    covers: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 50 })),
    by: Type.Optional(Type.String()),
    at: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type ExplainSchemaDoc = Static<typeof explainSchema>;
