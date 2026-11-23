import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateAgainst } from '../src/config/validate.ts';
import { emitSchemas, kinds, manifestSchema } from '../src/schema/index.ts';

const dir = join(import.meta.dirname, '..', '..', '..', 'schemas');

describe('schemas', () => {
  it('has the M0 kinds', () => {
    expect(Object.keys(kinds)).toEqual(expect.arrayContaining(['input-map', 'look', 'material', 'mixer', 'sound', 'tuning', 'ui-screen', 'ui-theme']));
    expect(manifestSchema).toBeTruthy();
  });

  it('carries x-ui and x-ref in the emitted JSON', () => {
    const files = emitSchemas();
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['game.schema.json', 'look.schema.json', 'sound.schema.json', 'input-map.schema.json', 'ui-theme.schema.json', 'ui-screen.schema.json']));
    const game = JSON.parse(files['game.schema.json']!);
    expect(game.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(game.properties.start.properties.level['x-ref']).toBe('level');
    expect(game.properties.step['x-ui'].widget).toBe('segments');
    expect(JSON.parse(files['material.schema.json']!).properties.texture.properties.scale['x-ui'].widget).toBe('dial');
  });

  it('lets a game pin its renderer in the manifest, and rejects an unknown one', () => {
    const base = { kind: 'game', id: 'g', title: 'G', entry: 'src/main.ts' };
    expect(validateAgainst(manifestSchema, { ...base, render: { backend: 'webgl2' } })).toEqual([]);
    expect(validateAgainst(manifestSchema, { ...base, render: { backend: 'vulkan' } }).length).toBeGreaterThan(0);
    expect(validateAgainst(manifestSchema, { ...base, render: { api: 'webgl2' } }).length).toBeGreaterThan(0);
    const game = JSON.parse(emitSchemas()['game.schema.json']!);
    expect(game.properties.render.properties.backend.default).toBe('auto');
  });

  it('lets a game turn the WebAssembly kernels off in the manifest, and rejects a non-boolean', () => {
    const base = { kind: 'game', id: 'g', title: 'G', entry: 'src/main.ts' };
    expect(validateAgainst(manifestSchema, { ...base, kernels: false })).toEqual([]);
    expect(validateAgainst(manifestSchema, { ...base, kernels: 'no' }).length).toBeGreaterThan(0);
    const game = JSON.parse(emitSchemas()['game.schema.json']!);
    expect(game.properties.kernels.default).toBe(true);
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
