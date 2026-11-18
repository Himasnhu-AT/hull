import Type, { type Static } from 'typebox';
import { ui } from './ui.ts';

// SCHEMAS.md section 5, buses only for now. Ducks, snapshots and the music kind come later.
const bus = Type.Object(
  {
    to: Type.Optional(Type.String({ ...ui({ widget: 'text', help: 'The bus this one feeds. Default: master.' }) })),
    level: Type.Optional(Type.Number({ minimum: -60, maximum: 12, default: 0, ...ui({ widget: 'slider', unit: 'dB', step: 0.5 }) })),
  },
  { additionalProperties: false },
);

export const mixerSchema = Type.Object(
  {
    kind: Type.Literal('mixer'),
    note: Type.Optional(Type.String()),
    buses: Type.Record(Type.String({ minLength: 1 }), bus, ui({ group: 'Buses', help: '"master" always exists; every other bus feeds master or another bus.' })),
    master: Type.Optional(
      Type.Object(
        {
          compressor: Type.Optional(
            Type.Object(
              {
                threshold: Type.Number({ minimum: -60, maximum: 0, default: -14, ...ui({ widget: 'dial', unit: 'dB' }) }),
                ratio: Type.Number({ minimum: 1, maximum: 20, default: 3, ...ui({ widget: 'dial', step: 0.5 }) }),
              },
              { additionalProperties: false },
            ),
          ),
          limiter: Type.Optional(Type.Number({ minimum: -12, maximum: 0, default: -1, ...ui({ widget: 'dial', unit: 'dB', help: 'Nothing gets louder than this.' }) })),
        },
        { additionalProperties: false, ...ui({ group: 'Master' }) },
      ),
    ),
  },
  { additionalProperties: false, title: 'Hull mixer' },
);

export type Mixer = Static<typeof mixerSchema>;
