// Every kind in the schema can be made from nothing, and what asset.new writes passes the check tool in a fresh project.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { kinds } from 'hull/schema';
import { check } from '../tools/check.ts';
import { readConfigFiles } from '../tools/config.ts';
import { planNew, STARTERS } from './assets.ts';
import { createProject } from './templates.ts';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('asset.new starters', () => {
  it('has a starter for every kind the schema knows', () => {
    expect(Object.keys(STARTERS).sort()).toEqual(Object.keys(kinds).sort());
  });

  it('refuses a name that is not a kind, and lists the kinds', () => {
    const plan = planNew({ configs: [], code: [] }, 'sprite', 'sprite/a');
    expect(plan.ok).toBe(false);
    expect(plan.problems[0]!.message).toContain('level');
  });

  it('a level starter has a ground, walls, one block and a start marker, and no prefab', () => {
    const doc = STARTERS['level'] as { blocks: unknown[]; markers: Record<string, unknown>; things?: unknown };
    expect(doc.blocks).toHaveLength(1);
    expect(Object.keys(doc.markers)).toEqual(['start']);
    expect(doc.things).toBeUndefined();
  });

  it('one of each kind, created in a fresh project, passes check', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'hull-starters-')), 'game');
    dirs.push(join(dir, '..'));
    await createProject({ template: 'cube', dir, title: 'Starters' });
    const made: string[] = [];
    for (const kind of Object.keys(kinds)) {
      const id = `${kind}/starter-${kind}`;
      const plan = planNew({ configs: readConfigFiles(dir), code: [] }, kind, id);
      expect(plan.problems, kind).toEqual([]);
      for (const w of plan.writes) { mkdirSync(dirname(join(dir, w.path)), { recursive: true }); writeFileSync(join(dir, w.path), w.text); }
      made.push(...plan.created);
    }
    // The shared companions are made once: a second kind that needs the material finds it there.
    expect(made.filter((i) => i === 'material/starter')).toHaveLength(1);
    const out = await check.run({ root: dir, author: 'test', log: () => {}, signal: new AbortController().signal }, {});
    expect(out.problems).toEqual([]);
  }, 120_000);
});
