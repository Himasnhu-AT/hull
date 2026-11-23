import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import type { Problem } from 'hull';
import { nodeChildEnv } from '../childEnv.ts';

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

/** The folder of a package's `@types/<name>`, searched upward from this package (the engine's own node_modules), or undefined. */
function typesRoot(): string | undefined {
  for (let d = dirname(tscPath()); ; d = dirname(d)) {
    if (existsSync(join(d, 'node_modules', '@types', 'node', 'package.json'))) return join(d, 'node_modules', '@types');
    if (dirname(d) === d) return undefined;
  }
}

/**
 * The tsconfig to check with. A project's own tsconfig leaves `*.test.ts` out (they need Node and vitest types a game
 * does not have), so a wrong import in a test passed `check` and failed in `test`. This writes a twin under .hull/cache
 * that keeps the project's options and includes the tests, with the vitest and Node types found beside the engine's tools.
 * Without those types it falls back to the project's own file.
 */
export function checkConfigPath(root: string): string {
  const own = join(resolve(root), 'tsconfig.json');
  let cfg: { compilerOptions?: Record<string, unknown>; exclude?: string[] };
  try { cfg = JSON.parse(readFileSync(own, 'utf8')) as typeof cfg; } catch { return resolve(root); }
  if (!(cfg.exclude ?? []).some((e) => e.includes('.test.'))) return resolve(root);
  const types = typesRoot();
  let vitest: string;
  try { vitest = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'dist', 'index.d.ts'); } catch { return resolve(root); }
  if (!types || !existsSync(vitest)) return resolve(root);
  const paths = { ...((cfg.compilerOptions?.['paths'] as Record<string, string[]> | undefined) ?? {}), vitest: [vitest] };
  const dir = join(resolve(root), '.hull', 'cache');
  const file = join(dir, 'tsconfig.check.json');
  const text = JSON.stringify({ extends: '../../tsconfig.json', compilerOptions: { paths, typeRoots: [types] }, include: ['../../src', '../../.hull/gen'], exclude: [] }, null, 2) + '\n';
  mkdirSync(dir, { recursive: true });
  try { if (readFileSync(file, 'utf8') === text) return file; } catch { /* first write */ }
  writeFileSync(file, text);
  return file;
}

/** `fast` keeps tsc's build info under .hull/cache, so the second run after a one-file edit re-checks only what changed. */
export function runTsc(root: string, opts: { fast?: boolean } = {}): Promise<Problem[]> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [tscPath(), '--noEmit', '--pretty', 'false', '-p', checkConfigPath(root), ...(opts.fast ? ['--incremental', '--tsBuildInfoFile', join(resolve(root), '.hull', 'cache', 'code-tools.tsbuildinfo')] : [])], { cwd: root, env: nodeChildEnv() });
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
