// The code tools' pure parts: which paths an agent may touch, the exact-string edit, search, and who imports a file.
// Nothing here writes; the project server applies the result (atomic write, history, reload). Tested without a server.
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const CODE_EXT = /\.(ts|tsx|js|mjs|json|css|glsl|wgsl|txt|md)$/;
/** A file bigger than this is neither read whole by the tools nor written by them: it is data, not code. */
export const MAX_BYTES = 512 * 1024;

/** A path under config/ is not code: say which calls make and change it. */
function configHint(rel: string): string {
  const m = /^config\/(([A-Za-z0-9_-]+)\/[A-Za-z0-9_./-]*?)(\.json)?$/.exec(rel);
  if (!m) return 'config/ goes through the asset tools (asset.new, then config.set)';
  return `create it with asset.new {"kind":"${m[2]}","id":"${m[1]}"} (a starter that passes check), then set its fields with config.set; config.read shows an existing file`;
}

export interface CodeFile { path: string; bytes: number }

/**
 * A path the code tools accept: 'src/...' under the project, no '..', no absolute path, no hidden or node_modules segment,
 * and (for a file that exists or has an existing parent) no symlink that leads out of src/. Returns the absolute path.
 */
export function resolveCodePath(root: string, rel: unknown, opts: { file?: boolean } = {}): { ok: true; abs: string; rel: string } | { ok: false; message: string } {
  if (typeof rel !== 'string' || rel === '') return { ok: false, message: 'a path under src/ is required, like src/main.ts' };
  if (rel.includes('\0') || rel.includes('\\') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return { ok: false, message: `"${rel}" is not a project path: use 'src/...' with forward slashes` };
  const parts = rel.split('/');
  if (parts[0] !== 'src') return { ok: false, message: `"${rel}" is outside src/: code tools only reach src/. ${configHint(rel)}` };
  if (parts.some((p) => p === '..' || p === '.' || p === '')) return { ok: false, message: `"${rel}" must be a plain path under src/ (no '..', '.' or empty parts)` };
  if (parts.some((p, i) => i > 0 && (p.startsWith('.') || p === 'node_modules'))) return { ok: false, message: `"${rel}" goes through a hidden or node_modules folder` };
  if (opts.file && !CODE_EXT.test(rel)) return { ok: false, message: `"${rel}" must be a code or text file (.ts .tsx .js .mjs .json .css .glsl .wgsl .txt .md)` };
  let realRoot: string;
  try { realRoot = realpathSync(join(root, 'src')); } catch { realRoot = resolve(root, 'src'); }
  const abs = resolve(root, rel);
  // Resolve the deepest part that exists: a symlinked folder or file must still land inside src/.
  let probe = abs;
  while (!existsSync(probe) && !isLink(probe)) { const up = dirname(probe); if (up === probe) break; probe = up; }
  let real: string;
  try { real = realpathSync(probe); } catch { return { ok: false, message: `"${rel}" is a dangling link` }; }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return { ok: false, message: `"${rel}" leaves src/ through a symlink` };
  return { ok: true, abs, rel };
}

function isLink(p: string): boolean { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }

/** Every file under src/, sorted, with its size. */
export function listCode(root: string): CodeFile[] {
  const out: CodeFile[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const n of names) {
      if (n === 'node_modules' || n.startsWith('.')) continue;
      const p = join(dir, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p); else out.push({ path: relative(root, p).split(sep).join('/'), bytes: st.size });
    }
  };
  walk(join(root, 'src'));
  return out;
}

export type EditResult = { ok: true; text: string; line: number } | { ok: false; message: string };

const lineOf = (text: string, at: number): number => { let n = 1; for (let i = 0; i < at; i++) if (text.charCodeAt(i) === 10) n++; return n; };

/**
 * Exact-string replace with must-match-once semantics: `old` has to occur exactly once (or `all` is set), so an edit can
 * never land on the wrong copy. The refusal says where the copies are. A file with CRLF line ends takes an LF `old` as is.
 */
export function applyEdit(text: string, old: string, next: string, all = false): EditResult {
  if (old === '') return { ok: false, message: 'old is empty: give the exact text to replace (to create or replace a whole file use code_write)' };
  if (old === next) return { ok: false, message: 'old and new are the same text: nothing to change' };
  if (text.includes('\r\n') && !old.includes('\r')) { old = old.replace(/\n/g, '\r\n'); next = next.replace(/\n/g, '\r\n'); }
  const at: number[] = [];
  for (let i = text.indexOf(old); i >= 0; i = text.indexOf(old, i + old.length)) at.push(i);
  if (at.length === 0) return { ok: false, message: 'old text not found: it must match the file exactly, whitespace included. Read the lines again with code_read.' };
  if (at.length > 1 && !all) return { ok: false, message: `old text found ${at.length} times (lines ${at.slice(0, 8).map((i) => lineOf(text, i)).join(', ')}): add surrounding lines so it matches once, or set all to replace every copy` };
  let out = '';
  let from = 0;
  for (const i of at) { out += text.slice(from, i) + next; from = i + old.length; }
  return { ok: true, text: out + text.slice(from), line: lineOf(text, at[0]!) };
}

export interface CodeMatch { file: string; line: number; col: number; text: string }

export function searchCode(root: string, pattern: string, o: { regex?: boolean; ignoreCase?: boolean; path?: string; limit?: number } = {}): { matches: CodeMatch[]; truncated: boolean } | { error: string } {
  let re: RegExp;
  try { re = new RegExp(o.regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), o.ignoreCase ? 'gi' : 'g'); } catch (e) { return { error: `bad pattern: ${(e as Error).message}` }; }
  const limit = Math.max(1, Math.min(o.limit ?? 100, 500));
  const matches: CodeMatch[] = [];
  let truncated = false;
  for (const f of listCode(root)) {
    if (o.path && !(f.path === o.path || f.path.startsWith(o.path.replace(/\/$/, '') + '/'))) continue;
    if (f.bytes > MAX_BYTES) continue;
    const text = readFileSync(join(root, f.path), 'utf8');
    if (text.includes('\0')) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      const m = re.exec(lines[i]!);
      if (!m) continue;
      if (matches.length >= limit) { truncated = true; return { matches, truncated }; }
      matches.push({ file: f.path, line: i + 1, col: m.index + 1, text: lines[i]!.replace(/\r$/, '').slice(0, 300) });
    }
  }
  return { matches, truncated };
}

export interface Importer { file: string; line: number; col: number; specifier: string }

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g;

/** The files of src/ whose relative import specifiers resolve to `target` (a project path like src/a/b.ts). */
export function importersOf(root: string, target: string): Importer[] {
  const out: Importer[] = [];
  const want = new Set([target]);
  for (const f of listCode(root)) {
    if (f.path === target || !/\.(ts|tsx|js|mjs)$/.test(f.path) || f.bytes > MAX_BYTES) continue;
    const text = readFileSync(join(root, f.path), 'utf8');
    IMPORT_RE.lastIndex = 0;
    for (let m = IMPORT_RE.exec(text); m; m = IMPORT_RE.exec(text)) {
      const spec = m[2]!;
      if (!spec.startsWith('.')) continue;
      const base = join(dirname(f.path), spec).split(sep).join('/');
      const stem = base.replace(/\.(js|mjs)$/, '');
      const candidates = [base, stem + '.ts', stem + '.tsx', base + '.ts', base + '.tsx', base + '.js', base + '/index.ts', base + '/index.tsx'];
      if (candidates.some((c) => want.has(c))) {
        const at = m.index + m[0].indexOf(m[1]!);
        const line = lineOf(text, at);
        out.push({ file: f.path, line, col: at - text.lastIndexOf('\n', at - 1), specifier: spec });
      }
    }
  }
  return out;
}
