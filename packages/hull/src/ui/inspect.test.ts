import { describe, expect, it } from 'vitest';
import { clickButton, readUi, uiDefault, uiFocus, uiKeyName, type UiDoc, type UiEl } from './inspect.ts';

// A tiny DOM: classes, attributes, a parent, and the three selector shapes inspect.ts uses.
class El implements UiEl {
  parent: El | null = null;
  clicks = 0;
  focused = false;
  disabled?: boolean;
  constructor(readonly classes: string[], readonly attrs: Record<string, string> = {}, readonly text = '', readonly kids: El[] = []) { for (const k of kids) k.parent = this; }
  get textContent(): string { return this.text || this.kids.map((k) => k.textContent).join(' '); }
  getAttribute(n: string): string | null { return this.attrs[n] ?? null; }
  matches(sel: string): boolean {
    return sel.split(',').some((s) => {
      const m = /^\s*\.([\w-]+)(?:\[([\w-]+)\])?\s*$/.exec(s);
      return !!m && this.classes.includes(m[1]!) && (m[2] === undefined || m[2] in this.attrs);
    }) || (/^\[([\w-]+)\]$/.test(sel) && sel.slice(1, -1) in this.attrs);
  }
  closest(sel: string): El | null { for (let e: El | null = this; e; e = e.parent) if (e.matches(sel)) return e; return null; }
  all(): El[] { return this.kids.flatMap((k) => [k, ...k.all()]); }
  querySelectorAll(sel: string): El[] { return this.all().filter((e) => e.matches(sel)); }
  click(): void { this.clicks++; }
  focus(): void { this.focused = true; }
}
const root = (...kids: El[]): { host: El; world: El } => { const host = new El(['hull-ui'], {}, '', kids); return { host, world: new El([], {}, '', [host]) }; };
const d = (r: { world: El }, active: El | null = null): UiDoc => ({ querySelectorAll: (s) => r.world.querySelectorAll(s), activeElement: active });

describe('readUi', () => {
  it('lists texts, buttons and bars top to bottom with their panel, and skips hidden things', () => {
    const start = new El(['hull-btn', 'primary'], {}, 'Start');
    const r = root(
      new El(['hull-stack'], { 'data-hull-screen': 'ui-screen/title' }, '', [
        new El(['hull-title'], {}, 'Emberwatch'),
        new El(['hull-panel'], { 'aria-label': 'Menu' }, '', [start, new El(['hull-btn'], {}, 'Quit')]),
      ]),
      new El(['hull-bar'], { 'aria-label': 'Fuel', 'aria-valuenow': '40', 'aria-valuemax': '100' }),
      new El(['hull-text', 'hull-hidden'], {}, 'secret'),
      new El(['hull-off'], {}, '', [new El(['hull-text'], {}, 'inside a hidden layer')]),
    );
    const ui = readUi(d(r, start));
    expect(ui.screens).toEqual(['ui-screen/title']);
    expect(ui.items).toEqual([
      { kind: 'text', text: 'Emberwatch' },
      { kind: 'button', text: 'Start', focused: true, panel: 'Menu' },
      { kind: 'button', text: 'Quit', panel: 'Menu' },
      { kind: 'bar', text: 'Fuel', value: 40, max: 100 },
    ]);
  });
  it('marks a disabled button and stops at 80 items', () => {
    const off = new El(['hull-btn'], {}, 'Load'); off.disabled = true;
    expect(readUi(d(root(off))).items[0]).toMatchObject({ kind: 'button', disabled: true });
    const many = Array.from({ length: 100 }, (_, i) => new El(['hull-text'], {}, `t${i}`));
    expect(readUi(d(root(...many))).items).toHaveLength(80);
  });
});

describe('clickButton', () => {
  const make = () => { const a = new El(['hull-btn'], {}, 'Start'); const b = new El(['hull-btn'], {}, 'Quit game'); const gone = new El(['hull-btn', 'hull-hidden'], {}, 'Hidden'); return { a, b, gone, r: root(a, b, gone) }; };
  it('clicks by text (any case), by a unique part of it, or by number', () => {
    const { a, b, r } = make();
    expect(clickButton(d(r), 'start')).toEqual({ clicked: 'Start', buttons: ['Start', 'Quit game'] });
    clickButton(d(r), 'QUIT');
    clickButton(d(r), 1);
    expect([a.clicks, b.clicks]).toEqual([1, 2]);
  });
  it('a miss names the buttons there are; a hidden or disabled button is not clickable', () => {
    const { b, gone, r } = make();
    expect(() => clickButton(d(r), 'Settings')).toThrow(/no button says "Settings"; the buttons showing are "Start", "Quit game"/);
    expect(() => clickButton(d(r), 5)).toThrow(/no button number 5/);
    expect(() => clickButton(d(r), 'Hidden')).toThrow(/no button says/);
    b.disabled = true;
    expect(() => clickButton(d(r), 'Quit game')).toThrow(/disabled/);
    expect(gone.clicks).toBe(0);
  });
});

describe('keys on the UI layer', () => {
  it('Enter and Space activate the focused button; Tab moves focus; other keys do nothing', () => {
    const a = new El(['hull-btn'], {}, 'A'); const b = new El(['hull-btn'], {}, 'B');
    const r = root(a, b);
    uiDefault(d(r, a), 'Enter');
    uiDefault(d(r, a), 'Space');
    expect(a.clicks).toBe(2);
    uiDefault(d(r, a), 'Tab');
    expect(b.focused).toBe(true);
    uiDefault(d(r, a), 'KeyW');
    expect(a.clicks).toBe(2);
    expect(uiKeyName('Space')).toBe(' ');
    expect(uiKeyName('KeyW')).toBeNull();
  });
  it('a focus outside the UI layer is not the UI\'s', () => {
    const outside = new El(['hull-btn'], {}, 'X');
    const r = root(new El(['hull-btn'], {}, 'A'));
    expect(uiFocus(d(r, outside))).toBeNull();
    uiDefault(d(r, outside), 'Enter');
    expect(outside.clicks).toBe(0);
  });
});
