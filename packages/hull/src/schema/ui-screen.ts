import Type, { type Static } from 'typebox';
import { ui } from './ui.ts';

// SCHEMAS.md section 7. A screen is a tree of nodes. A node names one widget (`panel`, `stack`, `row`, `title`,
// `text`, `bar`, `button`, `image`) and gives its props; `children` and `on` sit beside it. The tree is recursive,
// so below the root the schema stays loose and ui/screen.ts checks the shape and names the place of a mistake.
const props = Type.Object(
  {
    text: Type.Optional(Type.String({ ...ui({ help: 'Literal text, or @key for a line of the strings file.' }) })),
    bind: Type.Optional(Type.String({ ...ui({ help: 'Name of a value the game exposes, e.g. player.hp.' }) })),
    max: Type.Optional(Type.Union([Type.Number(), Type.String()], { ...ui({ help: 'bar: a number or the name of a value.' }) })),
    format: Type.Optional(Type.String({ ...ui({ help: 'text: a template, {} is the value.' }) })),
    primary: Type.Optional(Type.Boolean()),
    align: Type.Optional(
      Type.Union(
        ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'].map((a) => Type.Literal(a)),
      ),
    ),
    width: Type.Optional(Type.Number({ exclusiveMinimum: 0, ...ui({ unit: 'px' }) })),
    gap: Type.Optional(Type.Number({ minimum: 0, ...ui({ unit: 'px' }) })),
    src: Type.Optional(Type.String()),
    alt: Type.Optional(Type.String()),
    label: Type.Optional(Type.String({ ...ui({ help: 'Accessible name when there is no visible text.' }) })),
    menu: Type.Optional(Type.Boolean({ ...ui({ help: 'Arrow keys move focus between the buttons inside.' }) })),
    visible: Type.Optional(Type.String({ ...ui({ help: 'Name of a value; the node shows while it is truthy.' }) })),
  },
  { additionalProperties: false },
);

export const uiScreenSchema = Type.Object(
  {
    kind: Type.Literal('ui-screen'),
    note: Type.Optional(Type.String()),
    pausesGame: Type.Optional(Type.Boolean({ default: false })),
    root: Type.Object(
      {
        panel: Type.Optional(props),
        stack: Type.Optional(props),
        row: Type.Optional(props),
        title: Type.Optional(props),
        text: Type.Optional(props),
        bar: Type.Optional(props),
        button: Type.Optional(props),
        image: Type.Optional(props),
        on: Type.Optional(Type.Record(Type.String(), Type.String())),
        children: Type.Optional(Type.Array(Type.Unknown())),
      },
      { additionalProperties: false },
    ),
    states: Type.Optional(
      Type.Record(Type.String(), Type.Object({ mock: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }, { additionalProperties: false })),
    ),
  },
  { additionalProperties: false, title: 'Hull UI screen' },
);

export type UiScreenDef = Static<typeof uiScreenSchema>;
export type UiNodeProps = Static<typeof props>;
