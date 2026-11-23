import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { Problem } from 'hull';
import { hullAliases } from '../server/vitePlugins.ts';
import { defineTool, type ProblemOutput } from '../tool.ts';

interface JsonResult {
  numTotalTests: number;
  numPassedTests: number;
  testResults: {
    name: string;
    message?: string;
    assertionResults: { fullName: string; status: string; failureMessages?: string[]; location?: { line: number; column: number } }[];
  }[];
}

/**
 * The innermost frame of a stack that is in the project's own src/ (not node_modules, not the engine): where the game or its
 * test actually broke. Vitest's own `location` is where the test starts, which for an assertion deep in a helper is no help.
 */
export function ownFrame(stack: string, root: string): { file: string; line: number; col: number } | undefined {
  const base = root.replace(/\\/g, '/').replace(/\/$/, '');
  for (const l of stack.split('\n')) {
    const m = /\(?(?:file:\/\/)?([^\s()]+?):(\d+):(\d+)\)?\s*$/.exec(l.trim());
    if (!m || !/^\s*at /.test(l)) continue;
    const abs = decodeURIComponent(m[1]!).replace(/\\/g, '/');
    if (!abs.startsWith(base + '/src/') || abs.includes('/node_modules/')) continue;
    return { file: abs.slice(base.length + 1), line: Number(m[2]), col: Number(m[3]) };
  }
  return undefined;
}

/** Turns Vitest's JSON report into problems: one per failed test, placed at the deepest frame inside src/ (else the test's own line). */
export function problemsFromReport(report: JsonResult, root: string): Problem[] {
  const out: Problem[] = [];
  for (const f of report.testResults) {
    const file = relative(root, f.name);
    const failed = f.assertionResults.filter((a) => a.status === 'failed');
    for (const a of failed) {
      const raw = a.failureMessages?.[0] ?? 'failed';
      const first = raw.split('\n')[0]!;
      const at = ownFrame(raw, root);
      out.push({ file: at?.file ?? file, line: at?.line ?? a.location?.line, col: at?.col ?? a.location?.column, message: `${a.fullName}: ${first}`, rule: 'test' });
    }
    // A file that fails to load has no assertions, only a message.
    if (failed.length === 0 && f.message) out.push({ file, message: f.message.split('\n')[0]!, rule: 'test' });
  }
  return out;
}

/** What a test run may print back to the caller: about this many characters. */
export const OUTPUT_LIMIT = 4000;

/**
 * What the tests printed, taken from Vitest's default reporter log: its `stdout | file > test` and `stderr | ...` blocks, in
 * order, so the caller can read a value a test logged instead of throwing to see it. Cut to OUTPUT_LIMIT characters with a note.
 */
export function printedOutput(log: string): string | undefined {
  const lines = log.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
  const blocks: string[] = [];
  let cur: string[] | null = null;
  for (const l of lines) {
    if (/^(stdout|stderr) \| /.test(l)) { cur = [l]; blocks.push(''); }
    else if (cur && /^\s*(✓|❯|×|↓|FAIL\b|Test Files|⎯|JSON report)/.test(l)) cur = null;
    else if (cur) cur.push(l);
    if (cur) blocks[blocks.length - 1] = cur.join('\n').replace(/\n+$/, '');
  }
  const text = blocks.join('\n\n').trim();
  if (!text) return undefined;
  return text.length <= OUTPUT_LIMIT ? text : text.slice(0, OUTPUT_LIMIT) + `\n[output cut: ${text.length - OUTPUT_LIMIT} more characters not shown]`;
}

export interface TestOutput extends ProblemOutput { total: number; passed: number; output?: string }

export const test = defineTool<Record<string, never>, TestOutput>({
  name: 'test',
  summary: 'Runs the project tests (src/**/*.test.ts) in Node; `hull` and `hull/<module>` imports resolve to the engine. Whatever the tests printed (console.log, console.error) comes back in "output", per test file, cut at about 4000 characters: log a value to read it instead of throwing.',
  input: { type: 'object', properties: {}, additionalProperties: false },
  output: { type: 'object', required: ['ok', 'problems', 'total', 'passed'] },
  format: (o) => [`${o.passed}/${o.total} tests passed`, ...(o.output ? ['', 'printed by the tests:', o.output] : [])],
  async run(ctx) {
    const pkg = createRequire(import.meta.url).resolve('vitest/package.json');
    const bin = join(dirname(pkg), 'vitest.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'hull-test-'));
    const outFile = join(dir, 'report.json');
    // Vitest runs with no project config, so `hull` and `hull/<sub>` are mapped here the way the dev server maps them
    // (a project made from a template has no node_modules to find the engine in).
    const configFile = join(dir, 'vitest.config.mjs');
    writeFileSync(configFile, `export default { resolve: { alias: [${hullAliases().map((a) => `{ find: new RegExp(${JSON.stringify(a.pattern)}), replacement: ${JSON.stringify(a.target)} }`).join(', ')}] } };\n`);
    try {
      const log = await new Promise<string>((done, fail) => {
        const child = spawn(process.execPath, [bin, 'run', '--root', ctx.root, '--config', configFile, '--reporter=json', '--reporter=default', `--outputFile.json=${outFile}`, 'src/'], { cwd: ctx.root, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
        let buf = '';
        child.stdout.on('data', (d) => (buf += d));
        child.stderr.on('data', (d) => (buf += d));
        child.on('error', fail);
        child.on('close', () => done(buf));
      });
      let report: JsonResult;
      try { report = JSON.parse(readFileSync(outFile, 'utf8')) as JsonResult; } catch {
        return { ok: false, total: 0, passed: 0, problems: [{ file: 'src', message: log.trim().split('\n').slice(-5).join('\n') || 'vitest produced no report', rule: 'test' }] };
      }
      const problems = problemsFromReport(report, ctx.root);
      const output = printedOutput(log);
      return { ok: problems.length === 0, total: report.numTotalTests, passed: report.numPassedTests, problems, ...(output ? { output } : {}) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
});
