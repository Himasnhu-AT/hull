import { afterEach, describe, expect, it } from 'vitest';
import { kitIO } from './io.ts';

describe('kitIO.play', () => {
  afterEach(() => { kitIO.sink = null; });
  it('passes the spatial options audio.play takes, with no cast', () => {
    const heard: unknown[] = [];
    kitIO.sink = (id, opts) => { heard.push([id, opts]); };
    kitIO.play('sound/shot', { volume: 0.5, at: [1, 2, 3], spatial: { ref: 2, max: 40 } });
    expect(heard).toEqual([['sound/shot', { volume: 0.5, at: [1, 2, 3], spatial: { ref: 2, max: 40 } }]]);
  });
});
