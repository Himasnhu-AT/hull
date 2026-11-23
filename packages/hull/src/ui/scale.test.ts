import { describe, expect, it } from 'vitest';
import { FakeEl } from '../kits/fake-ui.ts';
import { layoutRoot, uiScale } from './index.ts';

describe('ui scale', () => {
  it('fits the window to 1280x720 and keeps the result between half and double', () => {
    expect(uiScale(1280, 720)).toBe(1);
    expect(uiScale(640, 360)).toBe(0.5);
    expect(uiScale(1920, 1080)).toBe(1.5);
    expect(uiScale(2560, 1440)).toBe(2);
    expect(uiScale(5000, 3000)).toBe(2);
    expect(uiScale(320, 180)).toBe(0.5);
    // The smaller of the two ratios wins, so a tall phone does not overflow sideways.
    expect(uiScale(720, 1280)).toBe(0.5625);
    expect(uiScale(0, 0)).toBe(1);
  });

  it('lays the root out at design pixels and scales it once', () => {
    const el = new FakeEl('div');
    expect(layoutRoot(el as unknown as HTMLElement, 640, 360)).toBe(0.5);
    expect(el.style['width']).toBe('1280px');
    expect(el.style['height']).toBe('720px');
    expect(el.style['transform']).toBe('scale(0.5)');
    expect(layoutRoot(el as unknown as HTMLElement, 1280, 720)).toBe(1);
    expect(el.style['transform']).toBe('');
    expect(el.style['width']).toBe('1280px');
  });
});
