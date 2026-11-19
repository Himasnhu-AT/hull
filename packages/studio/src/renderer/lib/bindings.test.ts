import { describe, expect, it } from 'vitest';
import { PAD_AXES as HULL_AXES, PAD_BUTTONS as HULL_BUTTONS, expandSource } from '../../../../hull/src/input/keys.ts';
import { PAD_AXES, PAD_BUTTONS, captureName, clashesOf, displayName, findConflicts, keySlots, retype, sourcesOf } from './bindings.ts';

describe('captureName: what a pressed key is called in the file', () => {
  it('writes letters and digits the short way, by code so layouts do not matter', () => {
    expect(captureName({ code: 'KeyW' })).toBe('W');
    expect(captureName({ code: 'Digit4' })).toBe('4');
  });
  it('keeps the code for everything else, and tells left from right', () => {
    expect(captureName({ code: 'Space' })).toBe('Space');
    expect(captureName({ code: 'ArrowUp' })).toBe('ArrowUp');
    expect(captureName({ code: 'ShiftLeft' })).toBe('ShiftLeft');
    expect(captureName({ code: 'ShiftRight' })).toBe('ShiftRight');
    expect(captureName({ code: 'F5' })).toBe('F5');
    expect(captureName({ code: 'Numpad1' })).toBe('Numpad1');
  });
  it('refuses a key with no code', () => {
    expect(captureName({ code: '' })).toBeNull();
    expect(captureName({ code: 'Unidentified' })).toBeNull();
  });
  it('gives names the game reads', () => {
    for (const code of ['KeyW', 'Digit4', 'Space', 'ArrowUp', 'ShiftLeft', 'Tab', 'Enter', 'F5', 'Numpad1', 'Backquote']) {
      expect(expandSource(captureName({ code })!), code).not.toBeNull();
    }
  });
});

describe('displayName', () => {
  it('shows what is printed on the key', () => {
    expect(displayName('W')).toBe('W');
    expect(displayName('KeyW')).toBe('W');
    expect(displayName('w')).toBe('W');
    expect(displayName('ArrowUp')).toBe('↑');
    expect(displayName('Space')).toBe('Space');
    expect(displayName('ShiftLeft')).toBe('Shift');
    expect(displayName('ShiftRight')).toBe('Shift R');
    expect(displayName('Shift')).toBe('Shift');
    expect(displayName('Digit1')).toBe('1');
    expect(displayName('Mouse0')).toBe('Left click');
    expect(displayName('pad:south')).toBe('Pad south');
  });
});

describe('the Studio agrees with the game about names', () => {
  it('has the same pad names', () => {
    expect([...PAD_BUTTONS]).toEqual([...HULL_BUTTONS]);
    expect([...PAD_AXES]).toEqual([...HULL_AXES]);
  });
  it('expands names the same way', () => {
    for (const n of ['W', 'w', '1', 'Esc', 'Shift', 'Up', 'ArrowUp', 'Space', 'Mouse0', 'WheelUp', 'pad:south', 'pad:nope', 'nope', '']) {
      expect(sourcesOf(n), n).toEqual(expandSource(n));
    }
  });
});

describe('findConflicts', () => {
  const map = {
    forward: { type: 'button', keys: ['W', 'ArrowUp'] },
    back: { type: 'button', keys: ['S', 'ArrowDown'] },
    jump: { type: 'button', keys: ['Space'] },
    gas: { type: 'button', keys: ['ShiftLeft', 'ShiftRight'] },
    cut: { type: 'button', keys: ['K', 'Enter'] },
    confirm: { type: 'button', keys: ['Enter'], rebind: false },
    look: { type: 'axis2', mouse: 'delta' },
  };
  it('finds the same key on two actions', () => {
    expect(findConflicts(map)).toEqual([{ source: 'Enter', actions: ['cut', 'confirm'] }]);
  });
  it('sees through spellings: w and KeyW are one key, Shift covers both shift keys', () => {
    const c = findConflicts({ a: { type: 'button', keys: ['w'] }, b: { type: 'button', keys: ['KeyW', 'Shift'] }, c: { type: 'button', keys: ['ShiftRight'] } });
    expect(c).toEqual([{ source: 'KeyW', actions: ['a', 'b'] }, { source: 'ShiftRight', actions: ['b', 'c'] }]);
  });
  it('reads axis slots and pad buttons too, and ignores a key twice on one action', () => {
    const c = findConflicts({
      move: { type: 'axis', keys: { neg: ['A'], pos: ['D'] } },
      dodge: { type: 'button', keys: ['D'], pad: ['south'] },
      jump: { type: 'button', pad: 'south' },
      twice: { type: 'button', keys: ['Q', 'q'] },
    });
    expect(c).toEqual([{ source: 'KeyD', actions: ['move', 'dodge'] }, { source: 'pad:south', actions: ['dodge', 'jump'] }]);
  });
  it('is quiet when nothing clashes', () => {
    expect(findConflicts({ a: { type: 'button', keys: ['A'] }, b: { type: 'button', keys: ['B'] } })).toEqual([]);
    expect(findConflicts({})).toEqual([]);
  });
  it('says which other actions a chip clashes with', () => {
    const c = findConflicts(map);
    expect(clashesOf('Enter', 'cut', c)).toEqual(['confirm']);
    expect(clashesOf('K', 'cut', c)).toEqual([]);
    expect(clashesOf('Enter', 'jump', c)).toEqual([]);
  });
});

describe('retype', () => {
  it('moves a button list into the first slot that makes sense and back', () => {
    const b = { type: 'button', keys: ['A', 'B'], pad: 'south' };
    const axis = retype(b, 'axis');
    expect(axis['keys']).toEqual({ neg: [], pos: ['A', 'B'] });
    expect(axis['pad']).toBeUndefined();
    expect(retype(axis, 'button')['keys']).toEqual(['A', 'B']);
    expect(retype(b, 'axis2')['keys']).toEqual({ up: ['A', 'B'], down: [], left: [], right: [] });
  });
  it('keeps a mouse use only when the new type can read it', () => {
    expect(retype({ type: 'axis', mouse: 'wheel' }, 'axis2')['mouse']).toBeUndefined();
    expect(retype({ type: 'axis2', mouse: 'delta' }, 'axis')['mouse']).toBeUndefined();
    expect(retype({ type: 'axis', mouse: 'wheel', keys: {} }, 'axis')['mouse']).toBe('wheel');
  });
  it('reads keys of any shape', () => {
    expect(keySlots({ keys: ['A'] })).toEqual({ main: ['A'] });
    expect(keySlots({ keys: { neg: ['A'] } })).toEqual({ neg: ['A'] });
    expect(keySlots({})).toEqual({});
  });
});
