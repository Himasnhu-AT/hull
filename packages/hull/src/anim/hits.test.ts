import { describe, expect, it } from 'vitest';
import { createRegistry } from '../config/index.ts';
import type { Character } from '../schema/character.ts';
import { characterHits } from './index.ts';
import { exampleSources } from './examples/load.ts';

const base = (): Character => ({
  kind: 'character',
  body: { type: 'generated', recipe: 'custom', bones: [{ name: 'root', offset: [0, 1, 0] }, { name: 'head', parent: 'root', offset: [0, 1, 0] }] },
  hits: [
    { bone: 'head', shape: 'sphere', part: 'head', group: 'body', c: [0, 0.2, 0], r: 0.3 },
    { bone: 'root', shape: 'capsule', part: 'leg', group: 'body', a: [0, 0, 0], b: [0, -1, 0], r: 0.2, collide: false },
  ],
});

describe('character hits', () => {
  it('resolve to the bones they follow', () => {
    const hits = characterHits(base());
    expect(hits.map((h) => h.bone)).toEqual([1, 0]);
    expect(hits[1]!.hit.collide).toBe(false);
  });

  it('name the place when a shape has no such bone or lacks its numbers', () => {
    const noBone = base();
    noBone.hits![0]!.bone = 'tail';
    expect(() => characterHits(noBone, 'character/x')).toThrow('character/x#/hits/0/bone: "tail" is not a bone');
    const noRadius = base();
    delete noRadius.hits![1]!.r;
    expect(() => characterHits(noRadius, 'character/x')).toThrow('character/x#/hits/1: a capsule needs a, b and r');
  });

  it('are checked by the schema, and the shipped examples still validate', () => {
    const reg = createRegistry();
    expect(reg.load(exampleSources()).ok).toBe(true);
    const bad = reg.update({ path: 'config/character/bad.json', text: JSON.stringify({ ...base(), hits: [{ bone: 'head', shape: 'cone', part: 'x', group: 'y' }] }) });
    expect(bad.ok).toBe(false);
    expect(bad.problems[0]!.file).toContain('character/bad');
  });
});
