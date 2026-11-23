import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Problem } from 'hull';
import { kitImports } from '../server/kits.ts';
import { checkConfigIds } from './config.ts';
import { mask, sourceFiles, where } from './houseRules.ts';

/**
 * A kit's code reads config the kit ships (materials, sounds, screens). The kit does not put it in the project by itself, so a
 * game that imports the kit and lacks the files runs, logs a warning every frame and draws nothing. Each value import from
 * 'hull/kits' of a name whose code names (as a string literal, itself or what it imports in its kit) a file its kit ships and
 * the project lacks is a problem at the import, naming the ids and the kit.add call that adds them. A pure helper (the
 * wave clock, the depot maths) names none, and a kit's example files nothing names are optional. Type-only imports are ignored. Pure over (file, text) pairs and the ids the project has.
 */
export function scanKitConfig(files: { file: string; text: string }[], have: ReadonlySet<string>): Problem[] {
  const out: Problem[] = [];
  for (const f of files) {
    for (const imp of kitImports(mask(f.text, false))) {
      const missing = [...imp.uses].sort().filter((id) => !have.has(id));
      if (missing.length === 0) continue;
      out.push({
        file: f.file, ...where(f.text, imp.at), rule: 'kit-config',
        message: `imports ${imp.names.join(', ')} from 'hull/kits', and kit "${imp.kit}" ships config this project does not have: ${missing.join(', ')}. Add it with kit.add {"kit":"${imp.kit}"} (existing files are kept).`,
      });
    }
  }
  return out;
}

export async function checkKitConfig(root: string): Promise<Problem[]> {
  const byKind = await checkConfigIds(root);
  if (!byKind) return [];
  const have = new Set<string>();
  for (const [kind, list] of Object.entries(byKind)) for (const i of list) have.add(`${kind}/${i}`);
  const files = sourceFiles(root).map((f) => ({ file: f, text: readFileSync(join(root, f), 'utf8') }));
  return scanKitConfig(files, have);
}
