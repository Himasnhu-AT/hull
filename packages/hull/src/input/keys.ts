// Names for the things a player can press. Everything inside the input module is a "source" string:
//   keyboard   KeyEvent.code: 'KeyW', 'Space', 'ArrowUp', 'Digit1'
//   mouse      'Mouse0'..'Mouse4', and 'WheelUp' / 'WheelDown' (a notch counts as a tap)
//   gamepad    'pad:south', 'pad:triggerR' ...
// Config files may write the short forms ('W', '1', 'Esc', 'Shift'); `expandSource` turns them into sources.

/** Standard-mapping button order of the browser Gamepad API. */
export const PAD_BUTTONS = [
  'south', 'east', 'west', 'north', 'bumperL', 'bumperR', 'triggerL', 'triggerR',
  'select', 'start', 'stickLPress', 'stickRPress', 'dpadUp', 'dpadDown', 'dpadLeft', 'dpadRight', 'home',
] as const;
/** Standard-mapping axes: left stick x/y, right stick x/y. */
export const PAD_AXES = ['stickLX', 'stickLY', 'stickRX', 'stickRY'] as const;

/** 'pad:south' for each button, built once so sampling never makes strings. */
export const PAD_SOURCES: readonly string[] = PAD_BUTTONS.map((b) => `pad:${b}`);

const ALIASES: Record<string, readonly string[]> = {
  Esc: ['Escape'],
  Return: ['Enter'],
  ' ': ['Space'],
  Shift: ['ShiftLeft', 'ShiftRight'],
  Ctrl: ['ControlLeft', 'ControlRight'],
  Control: ['ControlLeft', 'ControlRight'],
  Alt: ['AltLeft', 'AltRight'],
  Meta: ['MetaLeft', 'MetaRight'],
  Up: ['ArrowUp'],
  Down: ['ArrowDown'],
  Left: ['ArrowLeft'],
  Right: ['ArrowRight'],
};

const SOURCE = /^(?:[A-Z][A-Za-z0-9]*|Mouse[0-4]|pad:[A-Za-z]+)$/;

/** The sources a written name stands for, or null if it is not a name Hull knows how to read. */
export function expandSource(name: string): readonly string[] | null {
  const alias = ALIASES[name];
  if (alias) return alias;
  if (/^[a-zA-Z]$/.test(name)) return [`Key${name.toUpperCase()}`];
  if (/^[0-9]$/.test(name)) return [`Digit${name}`];
  if (name.startsWith('pad:')) return (PAD_BUTTONS as readonly string[]).includes(name.slice(4)) ? [name] : null;
  return SOURCE.test(name) ? [name] : null;
}

const LABELS: Record<string, string> = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Space: 'Space', Escape: 'Esc', Enter: 'Enter', ShiftLeft: 'Shift', ShiftRight: 'Shift (R)',
  ControlLeft: 'Ctrl', ControlRight: 'Ctrl (R)', AltLeft: 'Alt', AltRight: 'Alt (R)',
  Mouse0: 'Left click', Mouse1: 'Middle click', Mouse2: 'Right click', Mouse3: 'Mouse 4', Mouse4: 'Mouse 5',
  WheelUp: 'Wheel up', WheelDown: 'Wheel down',
  Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", Minus: '-', Equal: '=',
  BracketLeft: '[', BracketRight: ']', Backquote: '`', Backslash: '\\',
};

/** What to show on a key cap in the key-binding screen. */
export function sourceLabel(source: string): string {
  const known = LABELS[source];
  if (known) return known;
  if (source.startsWith('Key') && source.length === 4) return source.slice(3);
  if (source.startsWith('Digit') && source.length === 6) return source.slice(5);
  if (source.startsWith('pad:')) return `Pad ${source.slice(4)}`;
  return source;
}
