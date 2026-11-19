import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyEdit, importersOf, listCode, resolveCodePath, searchCode } from './code.ts';

let root: string;
let outside: string;
beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'hull-code-'));
  root = join(base, 'game');
  outside = join(base, 'outside');
  mkdirSync(join(root, 'src', 'a'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.ts'), 'export const s = 1;\n');
  writeFileSync(join(root, 'src', 'main.ts'), "import { x } from './a/x.ts';\nexport * from './a/y';\nconst z = import('./a/x.js');\n");
  writeFileSync(join(root, 'src', 'a', 'x.ts'), 'export const x = 1;\n');
  writeFileSync(join(root, 'src', 'a', 'y.ts'), 'export const y = 2;\n');
  symlinkSync(outside, join(root, 'src', 'link'));
  symlinkSync(join(outside, 'secret.ts'), join(root, 'src', 'peek.ts'));
});
afterAll(() => rmSync(join(root, '..'), { recursive: true, force: true }));

describe('resolveCodePath', () => {
  it('accepts files under src/, existing or new', () => {
    expect(resolveCodePath(root, 'src/main.ts', { file: true })).toMatchObject({ ok: true, rel: 'src/main.ts' });
    expect(resolveCodePath(root, 'src/new/deep/file.ts', { file: true })).toMatchObject({ ok: true });
  });
  it.each(['../x.ts', 'src/../hull.json', 'src/a/../../hull.json', '/etc/passwd', 'config/sound/a.json', 'hull.json', 'src', 'src//a.ts', 'src/.hidden/a.ts', 'src/node_modules/a.ts', 'src\\a.ts', 'C:/a.ts', '', 'src/a.ts\0.png'])('refuses %j', (p) => {
    expect(resolveCodePath(root, p, { file: true }).ok).toBe(false);
  });
  it('refuses a symlinked folder or file that leads out of src/, existing or to be created', () => {
    expect(resolveCodePath(root, 'src/link/secret.ts', { file: true }).ok).toBe(false);
    expect(resolveCodePath(root, 'src/link/new.ts', { file: true }).ok).toBe(false);
    expect(resolveCodePath(root, 'src/peek.ts', { file: true }).ok).toBe(false);
  });
  it('refuses a file type that is not code or text', () => {
    expect(resolveCodePath(root, 'src/a.exe', { file: true }).ok).toBe(false);
    expect(resolveCodePath(root, 'src/a/', { file: true }).ok).toBe(false);
  });
});

describe('applyEdit', () => {
  it('replaces one match', () => {
    expect(applyEdit('a\nb\nc\n', 'b', 'B')).toEqual({ ok: true, text: 'a\nB\nc\n', line: 2 });
  });
  it('refuses no match, several matches (naming the lines), empty and no-op edits', () => {
    expect(applyEdit('a\nb\n', 'zz', 'y')).toMatchObject({ ok: false });
    const many = applyEdit('x\ny\nx\n', 'x', 'q');
    expect(many).toMatchObject({ ok: false });
    expect((many as { message: string }).message).toContain('2 times (lines 1, 3)');
    expect(applyEdit('abc', '', 'q').ok).toBe(false);
    expect(applyEdit('abc', 'a', 'a').ok).toBe(false);
  });
  it('replaces every copy with all', () => {
    expect(applyEdit('x\ny\nx\n', 'x', 'q', true)).toMatchObject({ ok: true, text: 'q\ny\nq\n' });
  });
  it('does not expand $ patterns in the replacement', () => {
    expect(applyEdit('a b', 'a', "$& $1 $'")).toMatchObject({ text: "$& $1 $' b" });
  });
  it('matches an LF old text in a CRLF file and keeps CRLF', () => {
    expect(applyEdit('a\r\nb\r\nc\r\n', 'a\nb', 'a\nB')).toMatchObject({ ok: true, text: 'a\r\nB\r\nc\r\n' });
  });
});

describe('listCode, searchCode, importersOf', () => {
  it('lists files with sizes', () => {
    expect(listCode(root).map((f) => f.path)).toEqual(expect.arrayContaining(['src/main.ts', 'src/a/x.ts', 'src/a/y.ts']));
  });
  it('searches literally and by regex with file:line:col', () => {
    const lit = searchCode(root, 'export const', {});
    expect('matches' in lit && lit.matches.map((m) => m.file + ':' + m.line + ':' + m.col)).toEqual(expect.arrayContaining(['src/a/x.ts:1:1']));
    const re = searchCode(root, 'const (x|y) =', { regex: true });
    expect('matches' in re && re.matches).toHaveLength(2);
    expect('matches' in searchCode(root, 'a.b', {}) && (searchCode(root, 'a.b', {}) as { matches: unknown[] }).matches).toHaveLength(0);
    expect(searchCode(root, '(', { regex: true })).toHaveProperty('error');
    const narrowed = searchCode(root, 'const', { path: 'src/a/x.ts' });
    expect('matches' in narrowed && narrowed.matches).toHaveLength(1);
  });
  it('finds importers by static, export-from and dynamic specifiers, with .js and extensionless forms', () => {
    expect(importersOf(root, 'src/a/x.ts').map((i) => i.file + ':' + i.line)).toEqual(['src/main.ts:1', 'src/main.ts:3']);
    expect(importersOf(root, 'src/a/y.ts').map((i) => i.file + ':' + i.line)).toEqual(['src/main.ts:2']);
    expect(importersOf(root, 'src/main.ts')).toEqual([]);
  });
});
