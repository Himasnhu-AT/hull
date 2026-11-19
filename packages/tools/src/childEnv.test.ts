import { describe, expect, it } from 'vitest';
import { nodeChildEnv } from './childEnv.ts';

describe('nodeChildEnv', () => {
  it('runs Electron as Node and drops the dev tsx import, keeping other options', () => {
    expect(nodeChildEnv({ NODE_OPTIONS: '--import tsx', A: '1' })).toEqual({ A: '1', ELECTRON_RUN_AS_NODE: '1' });
    expect(nodeChildEnv({ NODE_OPTIONS: '--max-old-space-size=4096 --import=tsx' })).toEqual({ NODE_OPTIONS: '--max-old-space-size=4096', ELECTRON_RUN_AS_NODE: '1' });
    expect(nodeChildEnv({ NODE_OPTIONS: '--import tsx-other' })['NODE_OPTIONS']).toBe('--import tsx-other');
  });
});
