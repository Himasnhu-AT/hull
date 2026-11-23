// What a schema cannot say: a cancel that names no move, a block with no volume, a model file that is not in assets/.
// The kits own these rules (hull/kits/checks); this runs them on every config file whose schema check passed and gives
// each finding its file, pointer, line and column like every other problem.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Problem } from 'hull';
import { readConfigFiles, readManifest } from './config.ts';

/** 'config/sound/sword/hit.json' is kind 'sound', id 'sword/hit'. */
function kindAndId(path: string): { kind: string; id: string } | null {
  const m = /^config\/([^/]+)\/(.+)\.json$/.exec(path);
  return m ? { kind: m[1]!, id: m[2]! } : null;
}

export async function checkConfigMeaning(root: string): Promise<Problem[]> {
  const manifest = readManifest(root);
  if (!manifest) return [];
  const { createRegistry, scanJson } = await import('hull');
  const { meaningChecks } = await import('hull/kits/checks');
  const sources = readConfigFiles(root);
  const registry = createRegistry();
  const loaded = registry.load([manifest, ...sources]);
  // A file that failed its schema is not what the checkers were written to read: fix that first.
  const broken = new Set(loaded.problems.map((p) => p.file));
  const ctx = {
    lookup: (kind: string, id: string): unknown => { try { return registry.lookup(kind as never, id as never); } catch { return undefined; } },
    hasAsset: (file: string): boolean => existsSync(join(root, 'assets', file.replace(/^(\.?\/)+/, '').replace(/^assets\//, ''))),
  };
  const out: Problem[] = [];
  for (const s of sources) {
    const k = kindAndId(s.path);
    const run = k ? meaningChecks[k.kind] : undefined;
    if (!k || !run || broken.has(s.path)) continue;
    const def = ctx.lookup(k.kind, k.id);
    if (def === undefined) continue;
    const found = run(def, `${k.kind}/${k.id}`, ctx);
    if (found.length === 0) continue;
    const scanned = scanJson(s.text);
    for (const sentence of found) {
      // "<kind>/<id>#/pointer: message"
      const hash = sentence.indexOf('#');
      const colon = sentence.indexOf(': ', hash);
      const pointer = hash >= 0 && colon > hash ? sentence.slice(hash + 1, colon) : '';
      const message = colon > 0 ? sentence.slice(colon + 2) : sentence;
      let pos: { line: number; col: number } | undefined;
      if (scanned.ok) { try { pos = scanned.locate(pointer); } catch { pos = undefined; } }
      out.push({ file: s.path, pointer, ...(pos ? { line: pos.line, col: pos.col } : {}), message, rule: 'meaning' });
    }
  }
  return out;
}
