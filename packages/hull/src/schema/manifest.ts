import Type, { type Static } from 'typebox';
import { ref, ui } from './ui.ts';

// hull.json (SCHEMAS.md section 2). Its kind is 'game'; it lives at the project root, not under config/.
export const manifestSchema = Type.Object(
  {
    kind: Type.Literal('game'),
    note: Type.Optional(Type.String()),
    id: Type.String({ pattern: '^[a-z0-9][a-z0-9-]*$' }),
    title: Type.String(),
    version: Type.Optional(Type.String()),
    entry: Type.String(),
    step: Type.Optional(Type.Enum([30, 60, 120], { default: 60, ...ui({ unit: 'Hz', widget: 'segments', help: 'Fixed simulation rate.' }) })),
    features: Type.Optional(Type.Array(Type.Enum(['audio', 'anim', 'ui', 'vfx', 'physics', 'saves']))),
    start: Type.Optional(
      Type.Object(
        { screen: Type.Optional(Type.String(ref('ui-screen'))), level: Type.Optional(Type.String(ref('level'))) },
        { additionalProperties: false },
      ),
    ),
    systems: Type.Optional(Type.Array(Type.String())),
    targets: Type.Optional(
      Type.Object(
        {
          web: Type.Optional(Type.Object({ singleFile: Type.Optional(Type.Boolean()) }, { additionalProperties: false })),
          desktop: Type.Optional(
            Type.Object(
              {
                appId: Type.Optional(Type.String()),
                systems: Type.Optional(Type.Array(Type.Enum(['mac', 'win', 'linux']))),
                window: Type.Optional(
                  Type.Object(
                    { width: Type.Number({ minimum: 1 }), height: Type.Number({ minimum: 1 }) },
                    { additionalProperties: false },
                  ),
                ),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    budgets: Type.Optional(
      Type.Object(
        {
          bundleKb: Type.Optional(Type.Number({ minimum: 0 })),
          frameMsP95: Type.Optional(Type.Number({ minimum: 0 })),
          drawCalls: Type.Optional(Type.Number({ minimum: 0 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false, title: 'Hull game manifest' },
);

export type Manifest = Static<typeof manifestSchema>;
