// Reading the UI layer for the control port: what a person could read on screen right now, and a click on a button by its
// text. It reads the DOM the ui module builds (class names and aria attributes, see ui/widgets.ts), so a bar or a button a game
// builds with the kit shows up with no code of its own. Dev tooling: nothing here runs per frame, and allocation is fine.
// Typed over a small slice of the DOM so a test can hand in plain objects.

/** The part of an Element this file touches. */
export interface UiEl {
  textContent: string | null;
  disabled?: boolean;
  getAttribute(name: string): string | null;
  closest(selector: string): UiEl | null;
  querySelectorAll(selector: string): ArrayLike<UiEl>;
  matches(selector: string): boolean;
  click?(): void;
}
export interface UiDoc {
  querySelectorAll(selector: string): ArrayLike<UiEl>;
  activeElement: UiEl | null;
}

export interface UiItem {
  kind: 'text' | 'button' | 'bar';
  text: string;
  value?: number;
  max?: number;
  disabled?: boolean;
  focused?: boolean;
  /** The label of the panel it sits in ("Health", "Status"), when there is one. */
  panel?: string;
}
export interface ControlUi { screens: string[]; items: UiItem[] }
export interface ControlClick { clicked: string; buttons: string[] }

export const MAX_UI_ITEMS = 80;
// A bound visibility toggles "hull-hidden"; a layer or the game hiding a widget toggles "hull-off". Both mean it is not on screen.
const HIDDEN = '.hull-hidden, .hull-off';
const PARTS = '.hull-text, .hull-title, .hull-btn, .hull-bar';

const clean = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
const num = (s: string | null): number | undefined => { if (s === null || s === '') return undefined; const n = Number(s); return Number.isFinite(n) ? n : undefined; };
const shown = (e: UiEl): boolean => e.closest(HIDDEN) === null;

/** The ids of the ui-screens showing and every text, button and bar a person could read, top to bottom, 80 at most. */
export function readUi(doc: UiDoc): ControlUi {
  const screens: string[] = [];
  for (const s of Array.from(doc.querySelectorAll('[data-hull-screen]'))) {
    const id = s.getAttribute('data-hull-screen');
    if (id && shown(s) && !screens.includes(id)) screens.push(id);
  }
  const items: UiItem[] = [];
  for (const host of Array.from(doc.querySelectorAll('.hull-ui'))) {
    if (!shown(host)) continue;
    for (const e of Array.from(host.querySelectorAll(PARTS))) {
      if (items.length >= MAX_UI_ITEMS) return { screens, items };
      if (!shown(e)) continue;
      const panel = clean(e.closest('.hull-panel[aria-label]')?.getAttribute('aria-label'));
      const it: UiItem = e.matches('.hull-bar')
        ? { kind: 'bar', text: clean(e.getAttribute('aria-label')) }
        : e.matches('.hull-btn')
          ? { kind: 'button', text: clean(e.textContent) }
          : { kind: 'text', text: clean(e.textContent) };
      if (it.kind === 'bar') {
        const v = num(e.getAttribute('aria-valuenow')); const m = num(e.getAttribute('aria-valuemax'));
        if (v !== undefined) it.value = v;
        if (m !== undefined) it.max = m;
      } else if (it.text === '') continue;
      if (it.kind === 'button') {
        if (e.disabled === true || e.matches('.disabled')) it.disabled = true;
        if (doc.activeElement === e) it.focused = true;
      }
      if (panel) it.panel = panel;
      items.push(it);
    }
  }
  return { screens, items };
}

/** The buttons a person could press now, in reading order. */
export function visibleButtons(doc: UiDoc): { el: UiEl; text: string }[] {
  const out: { el: UiEl; text: string }[] = [];
  for (const host of Array.from(doc.querySelectorAll('.hull-ui'))) {
    if (!shown(host)) continue;
    for (const e of Array.from(host.querySelectorAll('.hull-btn'))) if (shown(e)) out.push({ el: e, text: clean(e.textContent) });
  }
  return out;
}

/** Fires what a person's click fires on the button whose text is `which` (case-insensitive; a unique part of the text also works), or the nth showing (from 0). Throws, naming the buttons there are, on a miss. */
export function clickButton(doc: UiDoc, which: string | number): ControlClick {
  const all = visibleButtons(doc);
  const names = all.map((b) => b.text);
  const miss = (why: string): Error => new Error(`click: ${why}; the buttons showing are ${names.length ? names.map((n) => JSON.stringify(n)).join(', ') : 'none (the UI shows no button now)'}`);
  let hit: { el: UiEl; text: string } | undefined;
  if (typeof which === 'number') {
    hit = all[which];
    if (!Number.isInteger(which) || !hit) throw miss(`there is no button number ${String(which)} (counting from 0)`);
  } else if (typeof which === 'string' && which !== '') {
    const w = which.trim().toLowerCase();
    hit = all.find((b) => b.text.toLowerCase() === w);
    if (!hit) { const part = all.filter((b) => b.text.toLowerCase().includes(w)); if (part.length === 1) hit = part[0]; }
    if (!hit) throw miss(`no button says ${JSON.stringify(which)}`);
  } else throw new Error('click needs "button": the text of a button, or its number counting from 0');
  if (hit.el.disabled === true || hit.el.matches('.disabled')) throw miss(`the button ${JSON.stringify(hit.text)} is disabled`);
  hit.el.click?.();
  return { clicked: hit.text, buttons: names };
}

const NAV = new Set(['Enter', 'Space', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const KEY_OF: Record<string, string> = { Enter: 'Enter', Space: ' ', Escape: 'Escape', Tab: 'Tab', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight' };

/** Is this key one the UI layer handles itself (its `key` value for a KeyboardEvent, else null)? */
export const uiKeyName = (code: string): string | null => (NAV.has(code) ? KEY_OF[code]! : null);

/**
 * The UI layer's share of a key press. A real keydown lands on the focused element, where the menu panel's own handler
 * moves focus or goes back, and the browser then activates a focused button on Enter or Space and moves focus on Tab. A
 * KeyboardEvent a script makes is untrusted, so the browser does neither: this does them. Returns the element the key
 * should be dispatched on (the focused one, when it is in the UI layer), or null when the focus is elsewhere.
 */
export function uiFocus(doc: UiDoc): UiEl | null {
  const a = doc.activeElement;
  return a && a.closest('.hull-ui') && shown(a) ? a : null;
}

/** After a keydown nobody called preventDefault on: the browser's default action for it, on the focused element. */
export function uiDefault(doc: UiDoc, code: string, shift = false): void {
  const a = uiFocus(doc);
  if (!a) return;
  if ((code === 'Enter' || code === 'Space') && a.matches('.hull-btn') && a.disabled !== true) a.click?.();
  else if (code === 'Tab') {
    const list = visibleButtons(doc).filter((b) => b.el.disabled !== true).map((b) => b.el) as (UiEl & { focus?(): void })[];
    if (!list.length) return;
    const i = list.indexOf(a);
    list[(i + (shift ? -1 : 1) + list.length) % list.length]?.focus?.();
  }
}
