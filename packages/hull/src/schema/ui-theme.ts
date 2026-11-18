import Type, { type Static } from 'typebox';
import { colorPattern, ui } from './ui.ts';

// SCHEMAS.md section 7. Every field is optional: the UI kit has a default for each, so a theme only says what
// it changes. The values become CSS variables on the UI root (ui/theme.ts).
const colour = (help: string) => Type.Optional(Type.String({ pattern: colorPattern, ...ui({ widget: 'color', help }) }));

export const uiThemeSchema = Type.Object(
  {
    kind: Type.Literal('ui-theme'),
    note: Type.Optional(Type.String()),
    color: Type.Optional(
      Type.Object(
        {
          panel: colour('Background of panels and buttons.'),
          text: colour('Main text.'),
          muted: colour('Labels and hints.'),
          accent: colour('Bars, the primary button, the focus ring.'),
          danger: colour('Warnings and low bars.'),
          good: colour('Success.'),
          line: colour('Borders and bar tracks.'),
        },
        { additionalProperties: false },
      ),
    ),
    type: Type.Optional(
      Type.Object(
        {
          family: Type.Optional(Type.String({ ...ui({ help: 'A CSS font-family list.' }) })),
          size: Type.Optional(Type.Number({ minimum: 8, maximum: 72, default: 14, ...ui({ widget: 'slider', unit: 'px', step: 1 }) })),
          labelTracking: Type.Optional(Type.Number({ minimum: 0, maximum: 1, default: 0.2, ...ui({ widget: 'dial', unit: 'em', step: 0.01 }) })),
        },
        { additionalProperties: false },
      ),
    ),
    space: Type.Optional(
      Type.Object(
        {
          gutter: Type.Optional(Type.Number({ minimum: 0, maximum: 96, default: 20, ...ui({ widget: 'slider', unit: 'px', step: 1 }) })),
          radius: Type.Optional(Type.Number({ minimum: 0, maximum: 48, default: 2, ...ui({ widget: 'slider', unit: 'px', step: 1 }) })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false, title: 'Hull UI theme' },
);

export type UiTheme = Static<typeof uiThemeSchema>;
