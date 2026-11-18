import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { Problem } from 'hull';
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

/** Turns Vitest's JSON report into problems: one per failed test, placed at its file and line. */
export function problemsFromReport(report: JsonResult, root: string): Problem[] {
  const out: Problem[] = [];
  for (const f of report.testResults) {
    const file = relative(root, f.name);
    const failed = f.assertionResults.filter((a) => a.status === 'failed');
    for (const a of failed) {
      const first = (a.failureMessages?.[0] ?? 'failed').split('\n')[0]!;
      out.push({ file, line: a.location?.line, col: a.location?.column, message: `${a.fullName}: ${first}`, rule: 'test' });
    }
    // A file that fails to load has no assertions, only a message.
    if (failed.length === 0 && f.message) out.push({ file, message: f.message.split('\n')[0]!, rule: 'test' });
  }
  return out;
}

export interface TestOutput extends ProblemOutput { total: number; passed: number }

export const test = defineTool<Record<string, never>, TestOutput>({
  name: 'test',
  summary: 'Runs the project tests (src/**/*.test.ts) in Node.',
  input: { type: 'object', properties: {}, additionalProperties: false },
  output: { type: 'object', required: ['ok', 'problems', 'total', 'passed'] },
  format: (o) => [`${o.passed}/${o.total} tests passed`],
  async run(ctx) {
    const pkg = createRequire(import.meta.url).resolve('vitest/package.json');
    const bin = join(dirname(pkg), 'vitest.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'hull-test-'));
    const outFile = join(dir, 'report.json');
    try {
      const log = await new Promise<string>((done, fail) => {
        const child = spawn(process.execPath, [bin, 'run', '--root', ctx.root, '--reporter=json', `--outputFile=${outFile}`, 'src/'], { cwd: ctx.root });
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
      return { ok: problems.length === 0, total: report.numTotalTests, passed: report.numPassedTests, problems };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
});
