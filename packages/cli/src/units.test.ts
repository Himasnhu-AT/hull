import { describe, expect, it } from 'vitest';
import { formatProblem } from './tool.ts';
import { scanSource } from './tools/houseRules.ts';
import { parseTsc } from './tools/types.ts';
import { problemsFromReport } from './tools/test.ts';
import { bootModule } from './tools/dev.ts';

describe('formatProblem', () => {
  it('prints code as file:line:col', () => {
    expect(formatProblem({ file: 'src/a.ts', line: 3, col: 7, message: 'bad', rule: 'types' })).toBe('src/a.ts:3:7: bad');
  });
  it('prints config as file#pointer (line:col)', () => {
    expect(formatProblem({ file: 'config/a.json', pointer: '/x', line: 2, col: 4, message: 'bad', rule: 'schema' })).toBe('config/a.json#/x (2:4): bad');
    expect(formatProblem({ file: 'config/a.json', pointer: '/x', message: 'bad', rule: 'ref' })).toBe('config/a.json#/x: bad');
  });
});

describe('scanSource', () => {
  it('finds banned calls with their position', () => {
    const p = scanSource('src/a.ts', 'const a = 1;\n  const r = Math.random();\n  setTimeout(f, 1);\n');
    expect(p.map((x) => [x.line, x.col, x.rule])).toEqual([[2, 13, 'house-rule'], [3, 3, 'house-rule']]);
  });
  it('ignores comments, strings and method names', () => {
    const src = ['// Math.random()', '/* Date.now() */', "const s = 'performance.now()';", 'world.setTimeout(1);', 'rng.Math.random;'].join('\n');
    expect(scanSource('src/a.ts', src)).toEqual([]);
  });
  it('rejects three and hull internals', () => {
    const p = scanSource('src/a.ts', "import * as T from 'three';\nimport { x } from 'hull/src/core/index.ts';\nimport { ok } from 'hull';\nimport r from 'hull/render';");
    expect(p.map((x) => x.line)).toEqual([1, 2]);
    expect(p[0]!.col).toBe(20);
  });
});

describe('parseTsc', () => {
  it('parses error lines and joins continuations', () => {
    const out = "src/main.ts(4,9): error TS2322: Type 'string' is not assignable to type 'number'.\n  detail line\nFound 1 error.\n";
    expect(parseTsc(out, '/p')).toEqual([{ file: 'src/main.ts', line: 4, col: 9, message: "TS2322: Type 'string' is not assignable to type 'number'.\ndetail line", rule: 'types' }]);
  });
});

describe('problemsFromReport', () => {
  it('reports failed tests at their file and line', () => {
    const p = problemsFromReport(
      { numTotalTests: 2, numPassedTests: 1, testResults: [{ name: '/p/src/a.test.ts', assertionResults: [
        { fullName: 'a ok', status: 'passed' },
        { fullName: 'a bad', status: 'failed', failureMessages: ['expected 1 to be 2\nstack'], location: { line: 5, column: 3 } },
      ] }] },
      '/p',
    );
    expect(p).toEqual([{ file: 'src/a.test.ts', line: 5, col: 3, message: 'a bad: expected 1 to be 2', rule: 'test' }]);
  });
});

describe('bootModule', () => {
  it('imports the manifest entry', () => {
    expect(bootModule('src/main.ts', [])).toContain('from "/src/main.ts"');
  });
});
