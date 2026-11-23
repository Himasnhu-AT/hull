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

describe('play script arranging steps', () => {
  it('accepts teleport, set and an until near', () => {
    expect(bad([{ teleport: 'player', to: [3, 0, -4], yaw: 1.5 }, { teleport: 'player', to: [0, 0, 0] }, { set: 'player', field: 'Health.hp', value: 5 }, { until: { node: 'player', near: [3, -4], within: 1 }, max: 100 }])).toEqual([]);
  });
  it('names the place of a bad one', () => {
    const out = bad([{ teleport: 'player', to: [1, 2] }, { teleport: 'player', to: [1, 2, 3], yaw: 'left' }, { set: 'player', field: 'hp', value: 5 }, { set: 'player', field: 'Health.hp', value: {} }, { until: { node: 'player', near: [3] , within: 1 }, max: 5 }]);
    expect(out.map((l) => l.split(':')[0])).toEqual(['/steps/0/to', '/steps/1/yaw', '/steps/2/field', '/steps/3/value', '/steps/4/until']);
  });
});
