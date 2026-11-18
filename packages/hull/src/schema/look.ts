import Type, { type Static } from 'typebox';
import { colorPattern, ui } from './ui.ts';
import { triple } from './tuples.ts';

const color = (def: string, help?: string) =>
  Type.String({ pattern: colorPattern, default: def, ...ui({ widget: 'color', ...(help ? { help } : {}) }) });

// SCHEMAS.md section 9: sky, fog, ambient (a hemisphere when `ground` is set), an environment map baked from the
// sky, sun, exposure, tone mapping and the post chain. `speedBlur` is accepted but not drawn yet.
const rgb = (def: [number, number, number], help: string) => triple({ default: def, ...ui({ help }) });
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
          skyBlend: Type.Optional(Type.Number({ minimum: 0, maximum: 1, default: 0.35, ...ui({ widget: 'slider', step: 0.05, help: 'How high the fog colour climbs into the sky (0 none, 1 to the zenith).' }) })),
        },
        { additionalProperties: false },
      ),
    ),
    ambient: Type.Optional(
      Type.Object(
        {
          color: Type.Optional(color('#ffffff')),
          intensity: Type.Optional(Type.Number({ minimum: 0, default: 0.6, ...ui({ widget: 'slider', step: 0.05 }) })),
          ground: Type.Optional(color('#3a3631', 'Light from below. With it, ambient is a hemisphere: `color` from above, this from below.')),
        },
        { additionalProperties: false },
      ),
    ),
    environment: Type.Optional(
      Type.Object(
        {
          intensity: Type.Optional(
            Type.Number({ minimum: 0, default: 0.4, ...ui({ widget: 'slider', step: 0.05, help: 'Light and reflections from the sky, so metals are not black. Defaults to 0.4 with a gradient sky and 0 with a flat one.' }) }),
          ),
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
          bloom: Type.Optional(Type.Number({ minimum: 0, ...ui({ widget: 'slider', step: 0.05, help: 'Glow strength. 0 turns bloom off.' }) })),
          bloomThreshold: Type.Optional(Type.Number({ minimum: 0, default: 1, ...ui({ step: 0.05, help: 'Brightness (linear, before tone mapping) where glow starts.' }) })),
          contrast: Type.Optional(Type.Number({ minimum: 0, ...ui({ widget: 'slider', step: 0.01 }) })),
          saturation: Type.Optional(Type.Number({ minimum: 0, ...ui({ widget: 'slider', step: 0.01 }) })),
          lift: Type.Optional(rgb([0, 0, 0], 'Added to the shadows, per channel (red, green, blue).')),
          gamma: Type.Optional(rgb([1, 1, 1], 'Bends the mid tones, per channel. Above 1 brightens.')),
          gain: Type.Optional(rgb([1, 1, 1], 'Multiplies the highlights, per channel.')),
          vignette: Type.Optional(Type.Number({ minimum: 0, ...ui({ widget: 'slider', step: 0.01 }) })),
          grain: Type.Optional(Type.Number({ minimum: 0, ...ui({ widget: 'slider', step: 0.005 }) })),
          aa: Type.Optional(Type.Union([Type.Literal('none'), Type.Literal('fxaa')], { default: 'none', ...ui({ widget: 'select', help: 'Edge smoothing after the grade. The scene itself is multisampled on medium and high.' }) })),
          speedBlur: Type.Optional(Type.Number({ minimum: 0, description: 'Not drawn yet.' })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false, title: 'Hull look' },
);

export type Look = Static<typeof lookSchema>;
