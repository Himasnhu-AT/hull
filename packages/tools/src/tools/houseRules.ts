import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Problem } from 'hull';
import { kitBlocks, kitImports } from '../server/kitTunables.ts';
import { findTunables } from '../server/tsTunables.ts';

/** Blank out comments (and optionally strings) but keep every offset and newline, so positions stay true. */
export function mask(text: string, strings: boolean): string {
  let out = '';
  let i = 0;
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  while (i < text.length) {
    const c = text[i]!;
    const n = text[i + 1];
    if (c === '/' && n === '/') {
      const e = text.indexOf('\n', i);
      const end = e < 0 ? text.length : e;
      out += blank(text.slice(i, end));
      i = end;
    } else if (c === '/' && n === '*') {
      const e = text.indexOf('*/', i + 2);
      const end = e < 0 ? text.length : e + 2;
      out += blank(text.slice(i, end));
      i = end;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      const lit = text.slice(i, j + 1);
      out += strings ? blank(lit) : lit;
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const banned: [RegExp, string][] = [
  [/(?<![.\w$])Math\s*\.\s*random\b/g, 'Math.random is not allowed in game code: use world.random(name)'],
  [/(?<![.\w$])Date\s*\.\s*now\b/g, 'Date.now is not allowed in game code: use world.time'],
  [/(?<![.\w$])performance\s*\.\s*now\b/g, 'performance.now is not allowed in game code: use world.time'],
  [/(?<![.\w$])setTimeout\b/g, 'setTimeout is not allowed in game code: use world.after'],
  [/(?<![.\w$])setInterval\b/g, 'setInterval is not allowed in game code: use world.every'],
];
const importRe = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(['"])(three(?:\/[^'"]*)?|hull\/src\/[^'"]*)\1/g;

export function where(text: string, index: number): { line: number; col: number } {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  return { line, col: index - before.lastIndexOf('\n') };
}

/** House rules for one game source file. Pure, so it is unit-tested without a project. */
export function scanSource(file: string, text: string): Problem[] {
  const out: Problem[] = [];
  const code = mask(text, true);
  for (const [re, message] of banned) {
    for (const m of code.matchAll(re)) out.push({ file, ...where(text, m.index), message, rule: 'house-rule' });
  }
  const withStrings = mask(text, false);
  for (const m of withStrings.matchAll(importRe)) {
    const spec = m[2]!;
    const message = spec.startsWith('three')
      ? `import of '${spec}' is not allowed in game code: go through hull`
      : `import of '${spec}' reaches into hull internals: import from 'hull' or one of its subpaths`;
    out.push({ file, ...where(text, m.index + m[0].indexOf(spec) - 1), message, rule: 'house-rule' });
  }
  return out.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.col ?? 0) - (b.col ?? 0));
}

export function sourceFiles(root: string, dir = 'src'): string[] {
  let names: string[];
  try { names = readdirSync(join(root, dir)); } catch { return []; }
  return names.flatMap((n) => {
    const rel = join(dir, n);
    if (statSync(join(root, rel)).isDirectory()) return sourceFiles(root, rel);
    return /\.(ts|tsx|js|mjs)$/.test(n) && !/\.test\.(ts|tsx|js|mjs)$/.test(n) ? [rel] : [];
  });
}

/**
 * Block names in `tunables(name, ...)` must be unique across the game and the kits it imports: the runtime throws on the
 * second declaration, which only shows once the game runs. Pure over (file, text) pairs so it is unit-tested directly.
 */
export function scanTunableNames(files: { file: string; text: string }[]): Problem[] {
  const out: Problem[] = [];
  const kit = new Map<string, string>();
  for (const f of files) for (const b of kitBlocks(kitImports(f.file, f.text))) if (!kit.has(b.block)) kit.set(b.block, b.file);
  const seen = new Map<string, string>();
  for (const f of files) {
    if (!f.text.includes('tunables')) continue;
    for (const b of findTunables(f.file, f.text)) {
      const { line, col } = where(f.text, b.start);
      const clash = kit.get(b.block);
      const first = seen.get(b.block);
      if (clash) out.push({ file: f.file, line, col, message: `tunables block "${b.block}" is also declared by the kit in hull ${clash}; the game would throw at start. Rename this block (for example "game${b.block[0]!.toUpperCase()}${b.block.slice(1)}")`, rule: 'house-rule' });
      else if (first) out.push({ file: f.file, line, col, message: `tunables block "${b.block}" is already declared at ${first}; block names must be unique`, rule: 'house-rule' });
      else seen.set(b.block, `${f.file}:${line}:${col}`);
    }
  }
  return out;
}

export function checkHouseRules(root: string): Problem[] {
  const files = sourceFiles(root).map((f) => ({ file: f, text: readFileSync(join(root, f), 'utf8') }));
  return [...files.flatMap((f) => scanSource(f.file, f.text)), ...scanTunableNames(files)];
}
