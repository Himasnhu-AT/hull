import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// core and config must run in Node and keep game time. This is the lint rule from ARCHITECTURE §1, kept as a test
// so it runs everywhere the suite runs.
const root = join(import.meta.dirname, '..', 'src');
const banned: [RegExp, string][] = [
  [/\bwindow\./, 'window'],
  [/\bdocument\./, 'document'],
  [/\bAudioContext\b/, 'AudioContext'],
  [/\bWebGL2?RenderingContext\b/, 'WebGL'],
  [/\bsetTimeout\(/, 'setTimeout'],
  [/\bsetInterval\(/, 'setInterval'],
  [/\bDate\.now\(/, 'Date.now'],
  [/\bperformance\.now\(/, 'performance.now'],
  [/\bMath\.random\(/, 'Math.random'],
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

describe('house rules', () => {
  for (const part of ['core', 'config']) {
    it(`${part} uses no browser APIs or real time`, () => {
      const hits: string[] = [];
      for (const f of files(join(root, part))) {
        readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line)) return;
          for (const [re, name] of banned) if (re.test(line)) hits.push(`${relative(root, f)}:${i + 1}: ${name}`);
        });
      }
      expect(hits).toEqual([]);
    });
  }
});
