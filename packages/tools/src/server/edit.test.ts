import { describe, expect, it } from 'vitest';
import { setJsonPointer } from './jsonEdit.ts';
import { compileTunables, findTunables, rewriteTunable } from './tsTunables.ts';

const set = (text: string, pointer: string, value: unknown): string => {
  const r = setJsonPointer(text, pointer, value);
  if (!r.ok) throw new Error(r.message);
  return r.text;
};

describe('setJsonPointer keeps formatting', () => {
  const doc = '{\n  "kind": "tuning",\n  "note": "hi",\n  "spin": 1.2,\n  "list": [1, 2, 3],\n  "deep": {\n    "a": 1,\n    "b": [\n      4,\n      5\n    ]\n  }\n}\n';

  it('replaces a number and touches nothing else', () => {
    const out = set(doc, '/spin', 6);
    expect(out).toBe(doc.replace('1.2', '6'));
  });
  it('keeps the final newline and its absence', () => {
    expect(set('{"a":1}', '/a', 2)).toBe('{"a":2}');
    expect(set('{"a":1}\n', '/a', 2)).toBe('{"a":2}\n');
  });
  it('keeps odd spacing and key order', () => {
    const t = '{ "z" :   1 ,\n  "a":2  }';
    expect(set(t, '/z', 9)).toBe('{ "z" :   9 ,\n  "a":2  }');
    expect(Object.keys(JSON.parse(set(t, '/a', 0)) as object)).toEqual(['z', 'a']);
  });
  it('replaces strings, booleans and null', () => {
    expect(set(doc, '/note', 'a "quoted"\nline')).toContain('"note": "a \\"quoted\\"\\nline"');
    expect(set('{"a":true}', '/a', false)).toBe('{"a":false}');
    expect(set('{"a":1}', '/a', null)).toBe('{"a":null}');
  });
  it('replaces an array element and keeps an inline array inline', () => {
    expect(set(doc, '/list/1', 9)).toBe(doc.replace('[1, 2, 3]', '[1, 9, 3]'));
    expect(set(doc, '/list', [7, 8])).toBe(doc.replace('[1, 2, 3]', '[7, 8]'));
  });
  it('keeps a spread array spread, at the right indent', () => {
    const out = set(doc, '/deep/b', [1, 2, 3]);
    expect(out).toContain('"b": [\n      1,\n      2,\n      3\n    ]');
  });
  it('appends a missing key after the last member, in the file style', () => {
    const out = set(doc, '/deep/c', 3);
    expect(out).toContain('    ]\n  }\n}'.replace('    ]\n  }', '    ],\n    "c": 3\n  }'));
    expect(JSON.parse(out)).toMatchObject({ deep: { c: 3 } });
    expect(set('{"a":1}', '/b', 2)).toBe('{"a":1, "b": 2}');
  });
  it('appends to an array at the end index and with "-"', () => {
    expect(set(doc, '/list/3', 4)).toContain('[1, 2, 3, 4]');
    expect(set(doc, '/list/-', 4)).toContain('[1, 2, 3, 4]');
  });
  it('fills an empty object or array', () => {
    expect(JSON.parse(set('{}', '/a', 1))).toEqual({ a: 1 });
    expect(set('{\n  "a": {}\n}', '/a/x', 1)).toBe('{\n  "a": {\n    "x": 1\n  }\n}');
    expect(JSON.parse(set('{"a":[]}', '/a/0', 'x'))).toEqual({ a: ['x'] });
  });
  it('creates missing parents', () => {
    const out = set(doc, '/new/inner/leaf', 5);
    expect(JSON.parse(out)).toMatchObject({ new: { inner: { leaf: 5 } } });
    expect(out.startsWith('{\n  "kind"')).toBe(true);
  });
  it('uses tabs when the file does', () => {
    expect(set('{\n\t"a": {\n\t\t"b": 1\n\t}\n}', '/a/c', 2)).toBe('{\n\t"a": {\n\t\t"b": 1,\n\t\t"c": 2\n\t}\n}');
  });
  it('keeps CRLF line endings', () => {
    const out = set('{\r\n  "a": 1\r\n}\r\n', '/b', { x: [1, { y: 2 }] });
    expect(out).not.toMatch(/[^\r]\n/);
    expect(JSON.parse(out)).toEqual({ a: 1, b: { x: [1, { y: 2 }] } });
  });
  it('writes a nested value in the file style', () => {
    const out = set(doc, '/deep/a', { p: 1, q: { r: 2 } });
    expect(JSON.parse(out).deep.a).toEqual({ p: 1, q: { r: 2 } });
    expect(out).toContain('"a": {\n      "p": 1,\n      "q": {\n        "r": 2\n      }\n    }');
  });
  it('escapes pointer characters', () => {
    const t = '{"a/b":1,"c~d":2}';
    expect(set(t, '/a~1b', 5)).toBe('{"a/b":5,"c~d":2}');
    expect(set(t, '/c~0d', 5)).toBe('{"a/b":1,"c~d":5}');
  });
  it('replaces the root', () => {
    expect(set('{"a":1}\n', '', [1])).toBe('[1]\n');
  });
  it('handles negatives, exponents and unicode', () => {
    expect(set('{"a":-1.5e3,"s":"é"}', '/a', -2)).toBe('{"a":-2,"s":"é"}');
    expect(set('{"s":"日本"}', '/s', 'ü')).toBe('{"s":"ü"}');
  });
  it('refuses what cannot be done, with a sentence', () => {
    expect(setJsonPointer('{"a":1}', '/a/b', 1)).toMatchObject({ ok: false });
    expect(setJsonPointer('{"a":[1]}', '/a/5', 1)).toMatchObject({ ok: false });
    expect(setJsonPointer('{"a":[1]}', '/a/x', 1)).toMatchObject({ ok: false });
    expect(setJsonPointer('{"a":1}', '/a', undefined)).toMatchObject({ ok: false });
    expect(setJsonPointer('{"a":', '/a', 1)).toMatchObject({ ok: false });
  });
});

const src = (body: string): string => `import { num, bool, color, vec, choice, range, curve, tunables } from 'hull';\n${body}\n`;

describe('findTunables', () => {
  const text = src(`export const p = tunables('player', {
  // how fast
  runSpeed: num(12.5, { min: 0, max: 30, unit: 'm/s' }), // fast
  drift: num(-0.5, { min: -1, max: 1 }),
  /* the trail */ trail: color('#f0a43a'),
  on: bool(false),
  pos: vec([0, -1, 2.5], { min: -5, max: 5 }),
  mode: choice('walk', ['walk', 'run'] as const),
  r: range([1, 2]),
  c: curve([[0, 0], [1, 1]]),
});`);
  it('reports kind, value, opts and the literal position', () => {
    const [b] = findTunables('src/p.ts', text);
    expect(b!.block).toBe('player');
    expect(b!.complete).toBe(true);
    const by = Object.fromEntries(b!.tunables.map((t) => [t.key, t]));
    expect(by['runSpeed']).toMatchObject({ kind: 'num', value: 12.5, opts: { min: 0, max: 30, unit: 'm/s' }, line: 4, col: 17 });
    expect(by['drift']!.value).toBe(-0.5);
    expect(by['drift']!.opts).toEqual({ min: -1, max: 1 });
    expect(by['trail']!.value).toBe('#f0a43a');
    expect(by['on']!.value).toBe(false);
    expect(by['pos']!.value).toEqual([0, -1, 2.5]);
    expect(by['mode']).toMatchObject({ kind: 'choice', value: 'walk', opts: { options: ['walk', 'run'] } });
    expect(by['r']!.value).toEqual([1, 2]);
    expect(by['c']!.value).toEqual([[0, 0], [1, 1]]);
  });
  it('points line:col at the literal itself', () => {
    const t = findTunables('f.ts', text)[0]!.tunables[0]!;
    const lines = text.split('\n');
    expect(lines[t.line - 1]!.slice(t.col - 1, t.col - 1 + 4)).toBe('12.5');
  });
  it('ignores calls that are not direct tunables literals', () => {
    const t = src(`const speed = 3;\nexport const q = tunables('q', { a: num(speed), b: num(1) });\nconst other = num(4);`);
    const [b] = findTunables('f.ts', t);
    expect(b!.tunables.map((x) => x.key)).toEqual(['b']);
    expect(b!.complete).toBe(false);
  });
  it('does not see strings or comments that look like calls', () => {
    expect(findTunables('f.ts', src(`// tunables('x', { a: num(1) })\nconst s = "tunables('y', { a: num(1) })";`))).toEqual([]);
  });
});

describe('rewriteTunable', () => {
  const text = src(`export const p = tunables('player', {
  // speed, in m/s: keep below 30
  runSpeed: num(12.5, { min: 0, max: 30 }), // note
  drift: num(-0.5, { min: -1, max: 1 }),
  trail: color("#f0a43a"),
  on: bool(false),
  pos: vec([0, /* y */ -1, 2.5], { min: -5, max: 5 }),
  mode: choice('walk', ['walk', 'run']),
  r: range([1, 2]),
  c: curve([[0, 0], [1, 1]]),
});`);
  const ok = (key: string, value: unknown): string => {
    const r = rewriteTunable('f.ts', text, 'player', key, value);
    if (!r.ok) throw new Error(r.message);
    return r.text;
  };

  it('changes only the literal characters', () => {
    expect(ok('runSpeed', 6)).toBe(text.replace('num(12.5,', 'num(6,'));
  });
  it('writes negative numbers and over a negative literal', () => {
    expect(ok('drift', -1)).toBe(text.replace('num(-0.5,', 'num(-1,'));
    expect(ok('drift', 0.25)).toBe(text.replace('num(-0.5,', 'num(0.25,'));
    expect(ok('runSpeed', 0)).toContain('num(0,');
  });
  it('keeps the quote style of colours and choices', () => {
    expect(ok('trail', '#112233')).toContain('color("#112233")');
    expect(ok('mode', 'run')).toContain("choice('run', ['walk', 'run'])");
  });
  it('rewrites bools', () => {
    expect(ok('on', true)).toContain('bool(true)');
  });
  it('rewrites vec element by element, keeping comments', () => {
    expect(ok('pos', [1, 2, 3])).toContain('vec([1, /* y */ 2, 3],');
    expect(ok('pos', [1, -2, 3])).toContain('vec([1, /* y */ -2, 3],');
  });
  it('rewrites range and curve', () => {
    expect(ok('r', [0.5, 3])).toContain('range([0.5, 3])');
    expect(ok('c', [[0, 1], [0.5, 0.2], [1, 0]])).toContain('curve([[0, 1], [0.5, 0.2], [1, 0]])');
  });
  it('keeps nearby comments and other lines byte for byte', () => {
    const out = ok('runSpeed', 7);
    expect(out).toContain('// speed, in m/s: keep below 30');
    expect(out).toContain('// note');
  });
  it('reports the new literal position', () => {
    const r = rewriteTunable('f.ts', text, 'player', 'runSpeed', 6);
    expect(r).toMatchObject({ ok: true, line: 4 });
  });

  describe('rejects', () => {
    const bad = (key: string, value: unknown): string => {
      const r = rewriteTunable('f.ts', text, 'player', key, value);
      if (r.ok) throw new Error('expected a rejection');
      return r.message;
    };
    it('out of range', () => {
      expect(bad('runSpeed', 31)).toMatch(/at most 30/);
      expect(bad('runSpeed', -1)).toMatch(/at least 0/);
    });
    it('wrong type', () => {
      expect(bad('runSpeed', '6')).toMatch(/must be a number/);
      expect(bad('runSpeed', NaN)).toMatch(/must be a number/);
      expect(bad('on', 1)).toMatch(/true or false/);
      expect(bad('trail', 'red')).toMatch(/#rrggbb/);
      expect(bad('mode', 'fly')).toMatch(/one of walk, run/);
      expect(bad('pos', [1, 2])).toMatch(/three numbers/);
      expect(bad('pos', [1, 2, 9])).toMatch(/at most 5/);
      expect(bad('r', [3, 1])).toMatch(/min no larger/);
      expect(bad('c', [[2, 0]])).toMatch(/between 0 and 1/);
    });
    it('unknown block or key', () => {
      expect(rewriteTunable('f.ts', text, 'nope', 'a', 1)).toMatchObject({ ok: false });
      expect(rewriteTunable('f.ts', text, 'player', 'nope', 1)).toMatchObject({ ok: false });
    });
    it('never writes a file that would not parse', () => {
      // A string with a quote and a backslash must be escaped, not break the file.
      const t = src(`export const p = tunables('p', { m: choice('a', ["a", 'it\\'s']) });`);
      const r = rewriteTunable('f.ts', t, 'p', 'm', "it's");
      expect(r).toMatchObject({ ok: true });
      if (r.ok) expect(findTunables('f.ts', r.text)[0]!.tunables[0]!.value).toBe("it's");
    });
  });
});

describe('compileTunables', () => {
  it('turns complete blocks into frozen constants and leaves others alone', () => {
    const t = src(`export const a = tunables('a', { x: num(1.5, { min: 0 }), c: color('#ffffff') });\nconst n = 3;\nexport const b = tunables('b', { y: num(n) });`);
    const out = compileTunables('f.ts', t)!;
    expect(out).toContain('Object.freeze({ "x": 1.5, "c": "#ffffff" })');
    expect(out).toContain("tunables('b', { y: num(n) })");
  });
  it('returns null when there is nothing to compile', () => {
    expect(compileTunables('f.ts', 'export const a = 1;')).toBeNull();
  });
});
