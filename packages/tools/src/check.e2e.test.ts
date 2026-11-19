import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Problem } from 'hull';
import { failed, runTool } from './run.ts';

// Calls the check tool on a fixture project with one mistake of each kind M0 must catch.
const fixture = join(import.meta.dirname, '..', 'fixtures', 'bad-config');

describe('check tool (e2e)', () => {
  let out: { ok: boolean; problems: Problem[] };
  beforeAll(async () => {
    out = (await runTool(fixture, 'check')) as { ok: boolean; problems: Problem[] };
  }, 120_000);

  it('fails', () => {
    expect(failed(out)).toBe(true);
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
