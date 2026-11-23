import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Problem } from 'hull';
import { kitImports, kitsWithAction } from '../server/kits.ts';
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

/**
 * A kit's code reads input actions (`kitIO.input.action('interact')`, a field default like `Interactor.action`). If no input map in
 * the project defines one, the kit shows its prompt and the key does nothing, with no error. Each value import of a kit whose code
 * reads an action that no map defines, and that a kit's own input map does define, is a problem at the import, naming the action
 * and the kit.add call that adds it. Pure over (file, text) pairs and the action names the project's input maps define.
 */
export function scanKitActions(files: { file: string; text: string }[], defined: ReadonlySet<string>): Problem[] {
  const out: Problem[] = [];
  for (const f of files) {
    for (const imp of kitImports(mask(f.text, false))) {
      for (const [action, field] of [...imp.actions].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (defined.has(action)) continue;
        // A field default the game sets to something else (Weapon.action: 'attack') is not read as the default.
        if (field && files.some((x) => new RegExp(`\\b${field}\\s*[:=]\\s*['"\`]`).test(x.text))) continue;
        // An action no kit's map ships is a game's own (a field default it overrides); only the ones kit.add can supply are named.
        const kits = kitsWithAction(action);
        if (kits.length === 0) continue;
        const pick = kits.includes(imp.kit) ? imp.kit : kits[0]!;
        out.push({
          file: f.file, ...where(f.text, imp.at), rule: 'kit-input',
          message: `imports ${imp.names.join(', ')} from 'hull/kits', which reads the input action "${action}", and no input-map in this project defines it (the key would do nothing). Add it with kit.add {"kit":"${pick}"} (an input map you have keeps its actions and gains the missing ones), or define "${action}" in your input-map.`,
        });
      }
    }
  }
  return out;
}

/** The action names every input-map file under config/ defines. */
function projectActions(root: string): Set<string> {
  const dir = join(root, 'config', 'input-map');
  const out = new Set<string>();
  if (!existsSync(dir)) return out;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) { walk(join(d, e.name)); continue; }
      if (!e.name.endsWith('.json')) continue;
      try { for (const a of Object.keys(JSON.parse(readFileSync(join(d, e.name), 'utf8')).actions ?? {})) out.add(a); } catch { /* the schema check reports a broken file */ }
    }
  };
  walk(dir);
  return out;
}

export async function checkKitConfig(root: string): Promise<Problem[]> {
  const byKind = await checkConfigIds(root);
  if (!byKind) return [];
  const have = new Set<string>();
  for (const [kind, list] of Object.entries(byKind)) for (const i of list) have.add(`${kind}/${i}`);
  const files = sourceFiles(root).map((f) => ({ file: f, text: readFileSync(join(root, f), 'utf8') }));
  return [...scanKitConfig(files, have), ...scanKitActions(files, projectActions(root))];
}
