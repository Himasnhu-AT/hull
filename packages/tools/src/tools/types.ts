import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import type { Problem } from 'hull';

// tsc prints `path(line,col): error TS1234: message`. Continuation lines are indented.
const lineRe = /^(.+?)\((\d+),(\d+)\): (?:error|warning) (TS\d+): (.*)$/;

export function parseTsc(output: string, root: string): Problem[] {
  const out: Problem[] = [];
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const m = lineRe.exec(line);
    if (m) {
      const file = relative(root, resolve(root, m[1]!)) || m[1]!;
      out.push({ file, line: Number(m[2]), col: Number(m[3]), message: `${m[4]}: ${m[5]}`, rule: 'types' });
    } else if (/^\s+\S/.test(line) && out.length > 0) {
      out[out.length - 1]!.message += `\n${line.trim()}`;
    }
  }
  return out;
}

/** The tsc of the typescript package installed beside the tools, never the one on PATH. */
export function tscPath(): string {
  const pkg = createRequire(import.meta.url).resolve('typescript/package.json');
  return join(dirname(pkg), 'bin', 'tsc');
}

export function runTsc(root: string): Promise<Problem[]> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [tscPath(), '--noEmit', '--pretty', 'false', '-p', resolve(root)], { cwd: root });
    let buf = '';
    child.stdout.on('data', (d) => (buf += d));
    child.stderr.on('data', (d) => (buf += d));
    child.on('error', fail);
    child.on('close', (code) => {
      const problems = parseTsc(buf, root);
      // A failure with no parsable line (missing tsconfig, bad flag) must still be reported.
      if (code !== 0 && problems.length === 0) problems.push({ file: 'tsconfig.json', message: buf.trim() || `tsc exited ${code}`, rule: 'types' });
      done(problems);
    });
  });
}
