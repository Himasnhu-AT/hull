// A `ui-theme` value as CSS variables. Pure: tests read the map, the view writes it to the root element.
import type { UiTheme } from '../schema/ui-theme.ts';

/** Defaults the kit ships with, so a theme only has to say what it changes. Dark, high contrast (text on panel is > 12:1). */
export const DEFAULT_THEME: Readonly<Required<{ [K in 'color' | 'type' | 'space']: Required<NonNullable<UiTheme[K]>> }>> = {
  color: { panel: '#0e1012', text: '#e6e1d6', muted: '#9a968c', accent: '#f0a43a', danger: '#c4372b', good: '#5fae6b', line: '#2a2d31' },
  type: { family: 'system-ui, -apple-system, "Segoe UI", sans-serif', size: 14, labelTracking: 0.2 },
  space: { gutter: 20, radius: 2 },
};

/** CSS variable name to value. Every variable is always present, so removing a field from a theme resets it. */
export function themeVars(theme?: UiTheme): Record<string, string> {
  const c = { ...DEFAULT_THEME.color, ...theme?.color };
  const t = { ...DEFAULT_THEME.type, ...theme?.type };
  const s = { ...DEFAULT_THEME.space, ...theme?.space };
  return {
    '--hull-panel': c.panel,
    '--hull-text': c.text,
    '--hull-muted': c.muted,
    '--hull-accent': c.accent,
    '--hull-danger': c.danger,
    '--hull-good': c.good,
    '--hull-line': c.line,
    '--hull-font': t.family,
    '--hull-size': `${t.size}px`,
    '--hull-tracking': `${t.labelTracking}em`,
    '--hull-gutter': `${s.gutter}px`,
    '--hull-radius': `${s.radius}px`,
  };
}

/** Writes the variables that differ from `last` and returns the new state. Nothing is written when nothing changed. */
export function applyVars(
  set: (name: string, value: string) => void,
  vars: Record<string, string>,
  last: Record<string, string>,
): Record<string, string> {
  for (const name in vars) {
    if (last[name] !== vars[name]) set(name, vars[name]!);
  }
  return vars;
}
