import Type, { type Static } from 'typebox';
import { colorPattern, ui } from './ui.ts';

const color = (def: string, help?: string) =>
  Type.String({ pattern: colorPattern, default: def, ...ui({ widget: 'color', ...(help ? { help } : {}) }) });

// SCHEMAS.md section 9. The subset drawn today: sky, fog, ambient, sun, exposure and tone mapping.
// `post` is accepted and kept so files written for later milestones validate, but nothing draws it yet.
export const lookSchema = Type.Object(
  {
    kind: Type.Literal('look'),
    note: Type.Optional(Type.String()),
    sky: Type.Optional(
      Type.Object(
        {
          color: Type.Optional(color('#14161b', 'A flat sky. Leave out when the three gradient colours below are set.')),
          horizon: Type.Optional(color('#a9c6dc')),
          mid: Type.Optional(color('#8fb2d6')),
          zenith: Type.Optional(color('#3d6aa8')),
        },
        { additionalProperties: false },
      ),
    ),
    fog: Type.Optional(
      Type.Object(
        {
          color: color('#a9c6dc'),
          near: Type.Optional(Type.Number({ minimum: 0, ...ui({ unit: 'm', help: 'Linear fog starts here. Use near and far, or density.' }) })),
          far: Type.Optional(Type.Number({ exclusiveMinimum: 0, ...ui({ unit: 'm' }) })),
          density: Type.Optional(Type.Number({ minimum: 0, ...ui({ step: 0.0005, help: 'Exponential fog. Wins over near and far when set.' }) })),
        },
        { additionalProperties: false },
      ),
    ),
    ambient: Type.Optional(
      Type.Object(
        {
          color: Type.Optional(color('#ffffff')),
          intensity: Type.Optional(Type.Number({ minimum: 0, default: 0.6, ...ui({ widget: 'slider', step: 0.05 }) })),
        },
        { additionalProperties: false },
      ),
    ),
    sun: Type.Optional(
      Type.Object(
        {
          color: Type.Optional(color('#ffffff')),
          strength: Type.Optional(Type.Number({ minimum: 0, default: 2.2, ...ui({ widget: 'slider', step: 0.05 }) })),
          elevationDeg: Type.Optional(Type.Number({ minimum: -90, maximum: 90, default: 45, ...ui({ widget: 'dial', unit: 'deg' }) })),
          azimuthDeg: Type.Optional(
            Type.Number({ minimum: 0, maximum: 360, default: 143, ...ui({ widget: 'dial', unit: 'deg', help: 'Compass bearing of the sun: 0 is -Z, 90 is +X.' }) }),
          ),
          shadows: Type.Optional(Type.Boolean({ default: false })),
          shadowRange: Type.Optional(Type.Number({ exclusiveMinimum: 0, default: 40, ...ui({ unit: 'm', help: 'Half the width of the shadowed area around the camera.' }) })),
        },
        { additionalProperties: false },
      ),
    ),
    exposure: Type.Optional(Type.Number({ minimum: 0, default: 1, ...ui({ widget: 'slider', step: 0.05 }) })),
    toneMapping: Type.Optional(Type.Union(
        [Type.Literal('none'), Type.Literal('linear'), Type.Literal('reinhard'), Type.Literal('cineon'), Type.Literal('aces'), Type.Literal('agx'), Type.Literal('neutral')],
        { default: 'none', ...ui({ widget: 'select' }) },
      )),
    post: Type.Optional(
      Type.Object(
        {
          bloom: Type.Optional(Type.Number({ minimum: 0 })),
          contrast: Type.Optional(Type.Number({ minimum: 0 })),
          saturation: Type.Optional(Type.Number({ minimum: 0 })),
          vignette: Type.Optional(Type.Number({ minimum: 0 })),
          grain: Type.Optional(Type.Number({ minimum: 0 })),
          speedBlur: Type.Optional(Type.Number({ minimum: 0 })),
        },
        { additionalProperties: false, description: 'Not drawn yet.' },
      ),
    ),
  },
  { additionalProperties: false, title: 'Hull look' },
);

export type Look = Static<typeof lookSchema>;
