// The browser side of input, tested with stand-ins for the page: an iframe whose click must still give the game the
// keyboard, even though the game takes over the mouse button (the cause of "WASD does nothing in the Game view").
import { describe, expect, it } from 'vitest';
import { defineGame, startGame, type Game } from '../core/index.ts';
import { mountInput } from './dom.ts';

class FakeWin extends EventTarget {
  focused = false;
  parent: FakeWin = this;
  parentFocused = 0;
  document!: FakeDoc;
  focus(): void { this.focused = true; this.document.focus = true; if (this.parent !== this) this.parent.document.focus = false; }
}
class FakeDoc extends EventTarget {
  focus = false;
  hidden = false;
  pointerLockElement: unknown = null;
  defaultView: FakeWin;
  constructor(w: FakeWin) { super(); this.defaultView = w; w.document = this; }
  hasFocus(): boolean { return this.focus; }
}
class FakeEl extends EventTarget {
  ownerDocument: FakeDoc;
  constructor(d: FakeDoc) { super(); this.ownerDocument = d; }
}

const MAP = { kind: 'input-map', actions: { forward: { type: 'button', keys: ['W'] }, attack: { type: 'button', keys: ['Mouse0'] } } } as never;

async function page(): Promise<{ top: FakeWin; frame: FakeWin; el: FakeEl; game: Game }> {
  const top = new FakeWin(); const topDoc = new FakeDoc(top); topDoc.focus = true;
  const frame = new FakeWin(); const frameDoc = new FakeDoc(frame); frame.parent = top;
  return { top, frame, el: new FakeEl(frameDoc), game: await startGame(defineGame({ ready() {} }), { seed: 1 }) };
}
const ev = (type: string, init: Record<string, unknown> = {}): Event => Object.assign(new Event(type, { cancelable: true }), init);

import { codeOf } from './dom.ts';

describe('codeOf', () => {
  it('names a key from its key when the event has no code', () => {
    expect(codeOf({ code: 'KeyW', key: 'w' })).toBe('KeyW');
    expect(codeOf({ code: '', key: 'w' })).toBe('KeyW');
    expect(codeOf({ code: '', key: ' ' })).toBe('Space');
    expect(codeOf({ code: '', key: 'Shift' })).toBe('ShiftLeft');
    expect(codeOf({ code: '', key: 'F13' })).toBe('');
  });
});

describe('input in an embedded game', () => {
  it('a click on the game takes key focus even though the game owns the mouse button', async () => {
    const { frame, top, el, game } = await page();
    const view = mountInput(game, el as unknown as HTMLElement, MAP);
    expect(frame.document.hasFocus()).toBe(false); // the editor around the game has it
    const down = ev('mousedown', { button: 0 });
    el.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true); // Mouse0 is bound, so the browser's own focus move is cancelled...
    expect(frame.document.hasFocus()).toBe(true); // ...and the game asked for focus itself
    expect(top.document.hasFocus()).toBe(false);
    frame.dispatchEvent(ev('keydown', { code: 'KeyW' }));
    expect(view.heldSources()).toContain('KeyW'); // the key reached the game
    view.dispose();
  });

  it('losing the pointer lock gives the keyboard back to the page around the game', async () => {
    const { frame, top, el, game } = await page();
    const view = mountInput(game, el as unknown as HTMLElement, MAP);
    el.dispatchEvent(ev('mousedown', { button: 0 }));
    frame.document.pointerLockElement = el;
    frame.document.dispatchEvent(ev('pointerlockchange'));
    expect(frame.document.hasFocus()).toBe(true);
    frame.document.pointerLockElement = null; // Esc
    frame.document.dispatchEvent(ev('pointerlockchange'));
    expect(top.document.hasFocus()).toBe(true);
    expect(view.heldSources()).toEqual([]);
    view.dispose();
  });
});
