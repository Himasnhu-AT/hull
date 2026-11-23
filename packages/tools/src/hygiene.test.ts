import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { docSources, firstSentence, hullDir, listDocs, notBuiltKinds, readDoc, readSection, searchDocs } from './create/docs.ts';
import { createMcpServer, splitImages } from './mcp/server.ts';
import { runTool } from './run.ts';
import { createProject } from './server/index.ts';
import type { ProjectLink } from './server/link.ts';
import { ownFrame } from './tools/test.ts';
import { nearest, scanConfigRefs } from './tools/refCheck.ts';
import { validateInput } from './validate.ts';

describe('validateInput', () => {
  const schema = { type: 'object', properties: { id: { type: 'string' }, pointer: { type: 'string' }, n: { type: 'number' }, mode: { enum: ['a', 'b'] }, list: { type: 'array', items: { type: 'string' } } }, required: ['id', 'pointer'], additionalProperties: false };
  it('names an unknown field and the fields there are', () => {
    expect(() => validateInput('config.set', schema, { id: 'x', path: '/a' })).toThrow('config.set: unknown field "path" (fields: id, pointer, n, mode, list)');
  });
  it('names a missing field, a wrong type, a wrong enum value and a wrong item', () => {
    expect(() => validateInput('config.set', schema, { id: 'x' })).toThrow('config.set: "pointer" is required');
    expect(() => validateInput('t', schema, { id: 'x', pointer: 1 })).toThrow('"pointer" must be string (got number)');
    expect(() => validateInput('t', schema, { id: 'x', pointer: '/', mode: 'c' })).toThrow('"mode" must be one of "a", "b"');
    expect(() => validateInput('t', schema, { id: 'x', pointer: '/', list: ['a', 2] })).toThrow('"list[1]" must be string');
    expect(() => validateInput('t', schema, { id: 'x', pointer: '/', n: 1 })).not.toThrow();
  });
  it('checks a oneOf by the branch its const names', () => {
    const op = { type: 'object', oneOf: [{ type: 'object', properties: { op: { const: 'step' }, n: { type: 'number' } }, required: ['op', 'n'] }, { type: 'object', properties: { op: { const: 'state' } }, required: ['op'] }] };
    expect(() => validateInput('game.run', { type: 'object', properties: { control: op }, required: ['control'] }, { control: { op: 'step' } })).toThrow('"control.n" is required');
    expect(() => validateInput('game.run', { type: 'object', properties: { control: op }, required: ['control'] }, { control: { op: 'state' } })).not.toThrow();
    expect(() => validateInput('game.run', { type: 'object', properties: { control: op }, required: ['control'] }, { control: { op: 'jump' } })).toThrow('matches none of the forms ("step", "state")');
  });
  it('treats undefined input as {}', () => { expect(() => validateInput('t', { type: 'object', properties: {}, additionalProperties: false }, undefined)).not.toThrow(); });
});

describe('MCP results', () => {
  const png = 'iVBORw0KGgo'.padEnd(40, 'A');
  const link = async (): Promise<ProjectLink> => ({ attached: true, url: 'ws://x', gameUrl: 'http://x', close: async () => {}, call: async () => ({ tick: 3, png, width: 2, height: 2 }) } as unknown as ProjectLink);
  it('sends a picture as an image block and compact text, lists no outputSchema, and checks input', async () => {
    const mcp = createMcpServer('/nowhere', { link });
    const list = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))!.result as { tools: Record<string, unknown>[] };
    expect(list.tools.length).toBeGreaterThan(20);
    for (const t of list.tools) expect(t['outputSchema'], String(t['name'])).toBeUndefined();
    const r = (await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'game.run', arguments: { control: { op: 'screenshot' } } } }))!.result as { content: { type: string; text?: string; data?: string; mimeType?: string }[]; structuredContent: { png: string } };
    expect(r.content[0]!.text).toBe('{"tick":3,"png":"[image]","width":2,"height":2}');
    expect(r.content[1]).toEqual({ type: 'image', data: png, mimeType: 'image/png' });
    expect(r.structuredContent.png).toBe('[image]');
    const bad = (await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'config.set', arguments: { id: 'a', path: '/x', value: 1 } } }))!.result as { isError: boolean; content: { text: string }[] };
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toBe('config.set: unknown field "path" (fields: id, pointer, value, author, exp)');
    await mcp.close();
  });
  it('splitImages takes data urls too', () => {
    const s = splitImages({ a: [{ shot: 'data:image/png;base64,AAAA' }], note: 'x' });
    expect(s.value).toEqual({ a: [{ shot: '[image]' }], note: 'x' });
    expect(s.images).toEqual([{ type: 'image', data: 'AAAA', mimeType: 'image/png' }]);
  });
});

describe('config names in code', () => {
  const ids = { material: ['material/player', 'material/gem'], sound: ['sound/thud'] };
  it('flags a missing id with the nearest real one, at file:line:col', () => {
    const p = scanConfigRefs([{ file: 'src/a.ts', text: "const a = 1;\nmesh.add(Mesh, { material: 'material/playr' });\n" }], ids);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ file: 'src/a.ts', line: 2, col: 29, rule: 'config-ref' });
    expect(p[0]!.message).toContain('did you mean "material/player"');
  });
  it('leaves real ids, prefixes, templates, has() guards, comments and non-kinds alone', () => {
    const text = [
      "a('material/player'); a('sound/' + id); a(`material/${x}`); a('sound/step-' + n);",
      "if (config.has('material/soldier-jacket')) {}",
      "// 'material/nothing'",
      "a('src/foo/bar'); a('sound/thud.mp3');",
    ].join('\n');
    expect(scanConfigRefs([{ file: 'src/a.ts', text }], ids)).toEqual([]);
  });
  it('says so when the kind has no config at all', () => {
    expect(scanConfigRefs([{ file: 'src/a.ts', text: "x('look/day')" }], {})[0]!.message).toContain('no look config at all');
  });
  it('nearest ranks by edit distance', () => { expect(nearest('sound/thudd', ['sound/shot', 'sound/thud'])[0]).toBe('sound/thud'); });
});

describe('test failures are placed in the project', () => {
  it('ownFrame picks the innermost frame inside src/', () => {
    const stack = 'AssertionError: x\n    at assert (/repo/node_modules/vitest/dist/a.js:1:1)\n    at Foo.fixedUpdate (file:///proj/src/player.ts:40:5)\n    at /proj/src/main.test.ts:9:3';
    expect(ownFrame(stack, '/proj')).toEqual({ file: 'src/player.ts', line: 40, col: 5 });
    expect(ownFrame('Error\n    at x (/other/src/a.ts:1:1)', '/proj')).toBeUndefined();
  });
});

describe('docs', () => {
  it('lists guide/engine first and the kit index names every kit folder', () => {
    const items = listDocs();
    expect(items[0]!.id).toBe('guide/engine');
    const index = docSources().find((s) => s.id === 'kit/index')!.text();
    const kits = join(hullDir(), 'src', 'kits');
    for (const n of readdirSync(kits)) if (existsSync(join(kits, n, 'README.md'))) expect(index, n).toContain('`' + n + '`');
  });
  it('every kit README starts with one sentence and ends with Use it and Wiring', () => {
    const kits = join(hullDir(), 'src', 'kits');
    for (const n of readdirSync(kits)) {
      const p = join(kits, n, 'README.md');
      if (!existsSync(p)) continue;
      const t = readFileSync(p, 'utf8');
      expect(firstSentence(t).length, n).toBeGreaterThan(10);
      expect(t, n).toContain('## Use it');
      // A section or a bullet: what else must be in the world for the kit to work.
      expect(/## Wiring|\*\*Wiring\*\*/.test(t), n).toBe(true);
    }
  });
  it('api/three is a short note, not a dump', () => {
    const t = docSources().find((s) => s.id === 'api/three')!.text();
    expect(t.length).toBeLessThan(2000);
    expect(t).toContain('SceneObject');
  });
  it('names the config kinds the schema guide describes but that are not built', () => {
    expect(notBuiltKinds()).toEqual(['strings']);
  });
  it('reads a section, reports unknown ones, and searches', () => {
    const md = '# T\nintro\n## Lifecycle\nready runs once\n### Order\nspawn order\n## State\nfields\n';
    expect(readSection(md, 'lifecycle')).toBe('## Lifecycle\nready runs once\n### Order\nspawn order\n');
    expect(readSection(md, 'nope')).toBeNull();
    expect(readDoc('guide/engine', 'How to verify')!.text).toContain('"op":"state"');
    expect(readDoc('guide/engine', 'nope')!.missing).toBe(true);
    expect(searchDocs('tunables block')[0]!.id).toBeTruthy();
    expect(searchDocs('fixedUpdate spawn order').some((h) => h.id === 'guide/engine')).toBe(true);
  });
});

describe('a new project', () => {
  it('has AGENTS.md and a CLAUDE.md that points at it, and check flags a mistyped config id', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'hull-hyg-')), 'g');
    try {
      await createProject({ template: 'arena', dir, title: 'Hyg' });
      expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n');
      expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8').split('\n').length).toBeLessThan(60);
      const f = join(dir, 'src', 'gem.ts');
      writeFileSync(f, readFileSync(f, 'utf8').replace("'material/gem'", "'material/gen'"));
      const out = (await runTool(dir, 'check', {})) as { problems: { file: string; line?: number; col?: number; message: string; rule?: string }[] };
      const p = out.problems.find((x) => x.rule === 'config-ref')!;
      expect(p).toMatchObject({ file: 'src/gem.ts', rule: 'config-ref' });
      expect(p.line).toBeGreaterThan(0);
      expect(p.message).toContain('did you mean "material/gem"');
    } finally { rmSync(join(dir, '..'), { recursive: true, force: true }); }
  }, 120_000);
});
