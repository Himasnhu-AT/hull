import { describe, expect, it } from 'vitest';
import { validateScript } from './run.ts';

const bad = (steps: unknown[]): string[] => validateScript('s.json', { steps }).map((p) => `${p.pointer}: ${p.message}`);

describe('play script UI steps', () => {
  it('accepts click, expectUi, ui and a sized screenshot', () => {
    expect(bad([{ click: 'Start' }, { click: 0 }, { expectUi: { text: 'Victory' } }, { expectUi: { text: 'Go', kind: 'button' } }, { ui: true }, { screenshot: 'big', width: 1280, height: 720 }, { press: 'Enter' }])).toEqual([]);
  });
  it('names the place of a bad one', () => {
    const out = bad([{ click: '' }, { expectUi: { text: 3 } }, { ui: false }, { screenshot: 'x', width: 5000 }, { screenshot: 'y', height: 7 }]);
    expect(out.map((l) => l.split(':')[0])).toEqual(['/steps/0/click', '/steps/1/expectUi', '/steps/2/ui', '/steps/3/width', '/steps/4/height']);
  });
});
