import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Problem } from 'hull';

// Runs the real command on a fixture project with one mistake of each kind M0 must catch.
const bin = join(import.meta.dirname, '..', 'bin', 'hull.js');
const fixture = join(import.meta.dirname, '..', 'fixtures', 'bad-config');

describe('hull check (e2e)', () => {
  let run: SpawnSyncReturns<string>;
  let out: { ok: boolean; problems: Problem[] };
  beforeAll(() => {
    run = spawnSync(process.execPath, [bin, 'check', '--json', '--root', fixture], { encoding: 'utf8', timeout: 120_000 });
    out = JSON.parse(run.stdout) as { ok: boolean; problems: Problem[] };
  });

  it('fails with a non-zero exit code', () => {
    expect(run.status).not.toBe(0);
    expect(out.ok).toBe(false);
  });
  it('names the manifest field that is wrong', () => {
    expect(out.problems.some((p) => p.file === 'hull.json' && p.pointer === '/step')).toBe(true);
  });
  it('names a reference to an id that does not exist (the M0 check)', () => {
    expect(out.problems.some((p) => p.file === 'hull.json' && p.pointer === '/start/level' && p.rule === 'ref')).toBe(true);
  });
  it('names the config file whose kind does not match its folder', () => {
    expect(out.problems.some((p) => p.file === 'config/tuning/wrong-kind.json' && p.pointer !== undefined)).toBe(true);
  });
});
