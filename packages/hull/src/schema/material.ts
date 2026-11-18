import Type, { type Static } from 'typebox';
import { colorPattern, ui } from './ui.ts';

// SCHEMAS.md section 11.
export const materialSchema = Type.Object(
  {
    kind: Type.Literal('material'),
    note: Type.Optional(Type.String()),
    color: Type.String({ pattern: colorPattern, default: '#ffffff', ...ui({ widget: 'color' }) }),
    roughness: Type.Optional(Type.Number({ minimum: 0, maximum: 1, default: 0.5, ...ui({ widget: 'slider', step: 0.01 }) })),
    metalness: Type.Optional(Type.Number({ minimum: 0, maximum: 1, default: 0, ...ui({ widget: 'slider', step: 0.01 }) })),
    texture: Type.Optional(
      Type.Object(
        {
          recipe: Type.String({ ...ui({ help: 'Name of a procedural texture recipe.' }) }),
          scale: Type.Optional(Type.Number({ exclusiveMinimum: 0, default: 1, ...ui({ widget: 'dial', step: 0.1 }) })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false, title: 'Hull material' },
);

export type Material = Static<typeof materialSchema>;
