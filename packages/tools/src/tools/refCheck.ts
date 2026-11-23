import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Problem } from 'hull';
import { kinds } from 'hull/schema';
import { checkConfigIds } from './config.ts';
import { mask, sourceFiles, where } from './houseRules.ts';

/** Edit distance, for suggesting the id the author meant. Ids are short, so the plain table is fine. */
export function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length]!;
}

/** The ids of `kind` closest to `id` (all full ids like material/player), best first, only those near enough to be a typo. */
export function nearest(id: string, all: readonly string[], max = 3): string[] {
  const limit = Math.max(3, Math.ceil(id.length / 3));
  return all.map((c) => ({ c, d: distance(id, c) })).filter((x) => x.d <= limit).sort((a, b) => a.d - b.d || a.c.localeCompare(b.c)).slice(0, max).map((x) => x.c);
}

const kindNames = Object.keys(kinds);

/**
 * A string literal in code of the form "<kind>/<id>" where <kind> is a config kind and no such config exists is a typo
 * the type system cannot see (a Mesh's material, a sound name passed to audio.play). `ids` maps each kind to its full
 * ids ('material/player'). Pure over (file, text) pairs so it is unit-tested directly.
 *
 * Not flagged, because the text is not the whole id or does not claim to be one: a literal that continues into an
 * expression ('sound/' + name, 'sound/step-' + n), one that ends in a separator, a template with ${}, and the argument of
 * `has(` / `watch(` (asking whether a config exists is how code-backed and optional config is handled).
 */
export function scanConfigRefs(files: { file: string; text: string }[], ids: Readonly<Record<string, readonly string[]>>): Problem[] {
  const out: Problem[] = [];
  const re = new RegExp(`(['"\`])((?:${kindNames.join('|')})/[A-Za-z0-9][A-Za-z0-9/_-]*)\\1`, 'g');
  for (const f of files) {
    const code = mask(f.text, false);
    for (const m of code.matchAll(re)) {
      const lit = m[2]!;
      if (/[-_/]$/.test(lit)) continue;
      const end = m.index + m[0].length;
      if (/^\s*\+/.test(code.slice(end, end + 12))) continue;
      const before = code.slice(Math.max(0, m.index - 12), m.index);
      if (/\b(has|watch)\s*\(\s*$/.test(before)) continue;
      const kind = lit.slice(0, lit.indexOf('/'));
      const known = ids[kind] ?? [];
      if (known.includes(lit)) continue;
      const near = nearest(lit, known);
      const hint = near.length ? `; did you mean ${near.map((n) => `"${n}"`).join(' or ')}?` : known.length ? `; the ${kind} configs are: ${known.slice(0, 6).join(', ')}${known.length > 6 ? ', ...' : ''}` : `; the project has no ${kind} config at all`;
      out.push({ file: f.file, ...where(f.text, m.index + 1), message: `"${lit}" names a ${kind} config that does not exist${hint}`, rule: 'config-ref' });
    }
  }
  return out;
}

export async function checkConfigRefs(root: string): Promise<Problem[]> {
  const byKind = await checkConfigIds(root);
  if (!byKind) return [];
  const full: Record<string, string[]> = {};
  for (const [k, list] of Object.entries(byKind)) full[k] = list.map((i) => `${k}/${i}`);
  const files = sourceFiles(root).map((f) => ({ file: f, text: readFileSync(join(root, f), 'utf8') }));
  return scanConfigRefs(files, full);
}
