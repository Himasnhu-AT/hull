import { describe, expect, it } from 'vitest';
import { builderPill } from './builderState.ts';

describe('builderPill', () => {
  it('says waiting for you while a card waits, even though the run is open', () => {
    expect(builderPill({ needs: false, waiting: 1, working: true })).toEqual({ text: 'waiting for you', cls: 'warn' });
  });
  it('says working, ready and needs a key', () => {
    expect(builderPill({ needs: false, waiting: 0, working: true }).text).toBe('working');
    expect(builderPill({ needs: false, waiting: 0, working: false })).toEqual({ text: 'ready', cls: 'ok' });
    expect(builderPill({ needs: true, waiting: 2, working: true }).text).toBe('needs a key');
  });
});
