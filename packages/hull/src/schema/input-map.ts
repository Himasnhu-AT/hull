import Type, { type Static } from 'typebox';
import { ui } from './ui.ts';

// SCHEMAS.md section 8. Source names: keys by `code` with the letter and digit shorthands ('W', '1'), mouse buttons
// 'Mouse0'..'Mouse4', 'WheelUp' / 'WheelDown', and gamepad buttons 'pad:south' (the `pad` field takes them without
// the prefix). The names are checked when the map is compiled, in input/map.ts.
const sourceList = Type.Array(Type.String(), { ...ui({ widget: 'keys' }) });

export const actionSchema = Type.Object(
  {
    type: Type.Union([Type.Literal('button'), Type.Literal('axis'), Type.Literal('axis2')], {
      ...ui({ widget: 'segments', help: 'button: held or not. axis: -1 to 1. axis2: two axes, like a stick.' }),
    }),
    keys: Type.Optional(
      Type.Union([sourceList, Type.Record(Type.String(), sourceList)], {
        ...ui({ help: 'button: a list. axis: { neg, pos }. axis2: { up, down, left, right }.' }),
      }),
    ),
    mouse: Type.Optional(
      Type.Union([Type.Literal('delta'), Type.Literal('deltaX'), Type.Literal('deltaY'), Type.Literal('wheel')], {
        ...ui({ help: 'Mouse movement or wheel. Movement counts only while the pointer is locked.' }),
      }),
    ),
    pad: Type.Optional(
      Type.Union([Type.String(), Type.Array(Type.String())], {
        ...ui({ help: 'button: button names (south, triggerR...). axis: stickLX, stickLY, stickRX, stickRY. axis2: stickL or stickR.' }),
      }),
    ),
    deadzone: Type.Optional(Type.Number({ minimum: 0, maximum: 0.95, default: 0.15, ...ui({ widget: 'slider', step: 0.01 }) })),
    sensitivity: Type.Optional(Type.Number({ exclusiveMinimum: 0, default: 1, ...ui({ widget: 'dial', step: 0.05, help: 'Multiplies mouse movement.' }) })),
    invertY: Type.Optional(Type.Boolean({ default: false, ...ui({ widget: 'toggle' }) })),
    rebind: Type.Optional(Type.Boolean({ default: true, ...ui({ widget: 'toggle', help: 'false keeps this action out of the key-binding screen.' }) })),
  },
  { additionalProperties: false },
);

export const inputMapSchema = Type.Object(
  {
    kind: Type.Literal('input-map'),
    note: Type.Optional(Type.String()),
    actions: Type.Record(Type.String(), actionSchema, {
      ...ui({ widget: 'bindings', help: 'One row per action: its type, its keys, mouse and gamepad. A key on two actions is flagged.' }),
    }),
    groups: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()), { ...ui({ help: 'Sections of the key-binding screen.' }) })),
  },
  { additionalProperties: false, title: 'Hull input map' },
);

export type InputMap = Static<typeof inputMapSchema>;
export type InputActionDef = Static<typeof actionSchema>;
