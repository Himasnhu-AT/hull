import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigSource, Problem } from 'hull';

/** Every `config/**\/*.json`, with paths relative to the project root and '/' separators. */
export function readConfigFiles(root: string, dir = 'config'): ConfigSource[] {
  let names: string[];
  try { names = readdirSync(join(root, dir)).sort(); } catch { return []; }
  return names.flatMap((n) => {
    const rel = `${dir}/${n}`;
    if (statSync(join(root, rel)).isDirectory()) return readConfigFiles(root, rel);
    return n.endsWith('.json') ? [{ path: rel, text: readFileSync(join(root, rel), 'utf8') }] : [];
  });
}

export function readManifest(root: string): ConfigSource | null {
  try { return { path: 'hull.json', text: readFileSync(join(root, 'hull.json'), 'utf8') }; } catch { return null; }
}

/** `.hull/gen/ids.ts`: an id list per kind, so a missing id is a compile error. Only touched when it changes. */
export function writeIds(root: string, source: string): void {
  const file = join(root, '.hull', 'gen', 'ids.ts');
  try { if (readFileSync(file, 'utf8') === source) return; } catch { /* first write */ }
  mkdirSync(join(root, '.hull', 'gen'), { recursive: true });
  writeFileSync(file, source);
}

/** The part of a manifest the CLI needs; SCHEMAS section 2 has the rest. */
export interface ManifestInfo { entry: string; step?: number; title?: string }

// config adds checkManifest to its index; until that merges, reach it through a narrow type.
type CheckManifest = (src: ConfigSource) => { value?: ManifestInfo; problems: Problem[] };

/** Validates hull.json. Returns the manifest when it is usable. */
export async function loadManifest(root: string): Promise<{ value?: ManifestInfo; problems: Problem[] }> {
  const manifest = readManifest(root);
  if (!manifest) return { problems: [{ file: 'hull.json', message: 'hull.json not found: is this a Hull project?', rule: 'parse' }] };
  const mod = (await import('hull')) as unknown as { checkManifest: CheckManifest };
  return mod.checkManifest(manifest);
}

/** Reads the project's config and manifest, validates them, and refreshes the generated ids. */
export async function checkConfig(root: string): Promise<Problem[]> {
  // Imported late so the pure parts of this package can be tested without the engine behind them.
  const { createRegistry } = await import('hull');
  const problems = [...(await loadManifest(root)).problems];
  const registry = createRegistry();
  const result = registry.load(readConfigFiles(root));
  writeIds(root, registry.idsModule());
  return [...problems, ...result.problems];
}
