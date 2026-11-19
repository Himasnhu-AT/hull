import Type, { type Static } from 'typebox';
import { ui } from './ui.ts';

// SCHEMAS.md section 5, buses only for now. Ducks, snapshots and the music kind come later.
const bus = Type.Object(
  {
    to: Type.Optional(Type.String({ ...ui({ widget: 'text', help: 'The bus this one feeds. Default: master.' }) })),
    level: Type.Optional(Type.Number({ minimum: -60, maximum: 12, default: 0, ...ui({ widget: 'slider', unit: 'dB', step: 0.5 }) })),
    compressor: Type.Optional(
      Type.Object(
        {
          threshold: Type.Number({ minimum: -60, maximum: 0, default: -12, ...ui({ widget: 'dial', unit: 'dB', help: 'Above this level the bus is turned down.' }) }),
          ratio: Type.Number({ minimum: 1, maximum: 20, default: 6, ...ui({ widget: 'dial', step: 0.5, help: 'How hard: 20 is almost a wall.' }) }),
          attack: Type.Optional(Type.Number({ minimum: 0, maximum: 0.2, default: 0.003, ...ui({ unit: 's', step: 0.001, help: 'How fast it clamps down on a loud hit; short keeps the front of a clash.' }) })),
          release: Type.Optional(Type.Number({ minimum: 0.01, maximum: 1, default: 0.12, ...ui({ unit: 's', step: 0.01 }) })),
        },
        { additionalProperties: false, ...ui({ help: 'Tames this bus alone, so its loud sounds can be turned up without the whole mix clipping.' }) },
      ),
    ),
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
