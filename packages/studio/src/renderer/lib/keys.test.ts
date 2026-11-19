import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { leaveBox } from './keys.ts';

describe('leaveBox', () => {
  const press = (key: string): number => { let n = 0; leaveBox({ key, currentTarget: { blur: () => { n++; } } }); return n; };
  it('leaves the box on Enter and Escape only', () => {
    expect(press('Enter')).toBe(1);
    expect(press('Escape')).toBe(1);
    expect(press('a')).toBe(0);
    expect(press('ArrowUp')).toBe(0);
  });
});

// The reset-arrow freeze: an input that blurred itself inside its onKeyDown made Chromium repeat the key forever
// (key-downs named "Unidentified"), which clicked the focused reset arrow in a loop. Blur on key-up instead (leaveBox).
describe('no blur inside a key-down handler', () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.tsx$/.test(n) ? [p] : [];
  });
  it('holds for every renderer component', () => {
    const root = new URL('..', import.meta.url).pathname;
    const bad: string[] = [];
    for (const f of files(root)) {
      const src = readFileSync(f, 'utf8');
      // The text of each onKeyDown={...} handler, up to the matching closing brace.
      for (let i = src.indexOf('onKeyDown={'); i >= 0; i = src.indexOf('onKeyDown={', i + 1)) {
        let depth = 0; let j = i + 'onKeyDown='.length;
        for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}' && --depth === 0) break; }
        if (/\.blur\(\)/.test(src.slice(i, j))) bad.push(`${f.slice(root.length)} near character ${i}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
