import { describe, expect, it } from 'vitest';
import { previewOf } from './configPreview.ts';

describe('previewOf', () => {
  it('shows a theme as swatches and skips what is not a colour', () => {
    const p = previewOf('ui-theme', { kind: 'ui-theme', color: { panel: '#10141a', accent: '#35e0c2', odd: 'banana' }, type: { size: 18 } });
    expect(p).toEqual({ type: 'swatches', swatches: [{ name: 'panel', color: '#10141a' }, { name: 'accent', color: '#35e0c2' }], more: 0 });
  });
  it('cuts a long theme and says how many more', () => {
    const color = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`c${i}`, '#ffffff']));
    expect(previewOf('ui-theme', { color })).toMatchObject({ type: 'swatches', more: 3 });
  });
  it('shows the first actions of an input map with their keys', () => {
    const p = previewOf('input-map', { actions: {
      move: { type: 'axis2', keys: { up: ['W', 'ArrowUp'], down: ['S'], left: ['A'], right: ['D'] }, pad: 'stickL' },
      jump: { type: 'button', keys: ['Space'], pad: 'south' },
      a: { keys: ['E'] }, b: { keys: ['F'] }, c: { keys: ['G'] },
    } });
    expect(p).toEqual({ type: 'keys', rows: [{ action: 'move', keys: 'W A S D' }, { action: 'jump', keys: 'Space' }, { action: 'a', keys: 'E' }, { action: 'b', keys: 'F' }], more: 1 });
  });
  it('lists the states of an animation graph once, over its layers', () => {
    const p = previewOf('anim-graph', { layers: { base: { states: { idle: {}, move: {} } }, arms: { states: { idle: {}, swing: {} } } } });
    expect(p).toEqual({ type: 'names', label: 'states', names: ['idle', 'move', 'swing'], more: 0 });
  });
  it('lists the clips of an animation set', () => {
    expect(previewOf('anim-set', { clips: { idle: {}, walk: {} } })).toEqual({ type: 'names', label: 'clips', names: ['idle', 'walk'], more: 0 });
  });
  it('gives nothing for an empty file or another kind', () => {
    expect(previewOf('ui-theme', {})).toBeNull();
    expect(previewOf('sound', { x: 1 })).toBeNull();
    expect(previewOf('anim-set', null)).toBeNull();
  });
});
