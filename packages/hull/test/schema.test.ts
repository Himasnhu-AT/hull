import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emitSchemas, kinds, manifestSchema } from '../src/schema/index.ts';

const dir = join(import.meta.dirname, '..', '..', '..', 'schemas');

describe('schemas', () => {
  it('has the M0 kinds', () => {
    expect(Object.keys(kinds).sort()).toEqual(['look', 'material', 'tuning']);
    expect(manifestSchema).toBeTruthy();
  });

  it('carries x-ui and x-ref in the emitted JSON', () => {
    const files = emitSchemas();
    expect(Object.keys(files).sort()).toEqual(['game.schema.json', 'look.schema.json', 'material.schema.json', 'tuning.schema.json']);
    const game = JSON.parse(files['game.schema.json']!);
    expect(game.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(game.properties.start.properties.level['x-ref']).toBe('level');
    expect(game.properties.step['x-ui'].widget).toBe('segments');
    expect(JSON.parse(files['material.schema.json']!).properties.texture.properties.scale['x-ui'].widget).toBe('dial');
  });

  // Run with HULL_WRITE_SCHEMAS=1 to rewrite /schemas after changing a schema.
  it('matches the files in /schemas (run with HULL_WRITE_SCHEMAS=1 to update them)', () => {
    const files = emitSchemas();
    if (process.env['HULL_WRITE_SCHEMAS']) {
      mkdirSync(dir, { recursive: true });
      for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    }
    for (const [name, text] of Object.entries(files)) {
      expect(readFileSync(join(dir, name), 'utf8'), `${name} is stale`).toBe(text);
    }
  });
});
