/// <reference types="node" />
// The titan rig is data: config/character/titan-<build>-<size>.json is rigDataOf() written down, for every build and
// size class. This test keeps the files and the code from drifting (HULL_WRITE_CHARACTERS=1 rewrites the files from the
// code), and shows that a rig built from the files has the same hit shapes as one built from the numbers, and follows an edit.
import { config } from 'hull';
import { characterHits } from 'hull/anim';
import { projectSources } from 'hull/kits/testing';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { BUILDS, getArchetype, makeDims, type BuildKey, type SizeClass } from './builder.ts';
import { buildRig, characterOf, rigConfigId, rigDataFor, rigDataOf } from './rig.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const SIZES: SizeClass[] = ['S', 'M', 'L', 'XL'];
const file = (id: string): string => `${root}config/character/${id}.json`;

describe('titan rig config', () => {
  beforeAll(() => {
    const r = config.load(projectSources(root));
    expect(r.problems).toEqual([]);
  });

  it('has a character file for every build and size, equal to what the code computes', () => {
    for (const build of Object.keys(BUILDS) as BuildKey[]) for (const size of SIZES) {
      const d = makeDims(build, size);
      const want = characterOf(d);
      const path = file(rigConfigId(d));
      if (process.env['HULL_WRITE_CHARACTERS']) writeFileSync(path, JSON.stringify(want, null, 2) + '\n');
      expect(existsSync(path), path).toBe(true);
      expect(JSON.parse(readFileSync(path, 'utf8')), rigConfigId(d)).toEqual(JSON.parse(JSON.stringify(want)));
    }
  });

  it('gives the same rig data from the files as from the numbers', () => {
    for (const build of Object.keys(BUILDS) as BuildKey[]) for (const size of SIZES) {
      const d = makeDims(build, size);
      expect(rigDataFor(d), rigConfigId(d)).toEqual(rigDataOf(d));
    }
  });

  it('has hit shapes the engine resolves against the body', () => {
    const c = config.lookup('character', 'titan-average-M');
    const hits = characterHits(c, 'character/titan-average-M');
    expect(hits.length).toBe(c.hits!.length);
    expect(hits.some((h) => h.hit.part === 'nape')).toBe(true);
  });

  it('builds a rig whose shapes and joints follow an edit of its file', () => {
    const arch = getArchetype({ build: 'average', skin: 'beige', hair: 0, expr: 'grin', size: 'M' });
    const rig = buildRig(arch, 8);
    const shapes = rig.shapes;
    const nape = (): { h: { x: number } } => shapes.find((s) => s.part === 'nape') as unknown as { h: { x: number } };
    const before = nape().h.x;
    const id = rigConfigId(arch.dims);
    const c = structuredClone(config.lookup('character', id));
    c.hits!.find((h) => h.part === 'nape')!.h = [1, 1, 1];
    c.body.bones!.find((b) => b.name === 'spine')!.offset = [0, 1.25, 0];
    const res = config.update({ path: `config/character/${id}.json`, text: JSON.stringify(c) });
    expect(res.problems).toEqual([]);
    expect(rig.shapes).toBe(shapes);
    expect(nape().h.x).not.toBe(before);
    expect(nape().h.x).toBeCloseTo(1 * (1 + 0.6 * (1 - 0.8)), 6);
    expect(rig.J.spine.position.y).toBe(1.25);
  });
});
