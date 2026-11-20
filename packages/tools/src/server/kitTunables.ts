// Which kit tunables a game really has, found without running it. A kit declares its numbers in engine source
// (`tunables('thirdPerson', ...)`), so the project's own `src/` scan never sees them. Chosen over asking the running
// game (`listTunables()`): the list must exist before the game loads, while no page is open (MCP, tests, an
// experiment), and with every option and range as the code wrote them. The cost is that a kit is "used" when the
// project imports one of its exports from `hull/kits` (or imports it whole), and its own imports of other kits come
// along, exactly as they would be loaded. Kits the game never imports stay out of the Inspector.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript6';
import { hullSrc } from './templates.ts';
import { findTunables, type FoundBlock, type FoundTunable } from './tsTunables.ts';

export type KitTunable = FoundTunable & {
  /** The kit's source file, relative to the engine's src/. */
  file: string;
};

interface Parsed { imports: string[]; exportsFrom: Map<string, string>; blocks: FoundBlock[] }
const parsed = new Map<string, Parsed | null>();

function parse(abs: string): Parsed | null {
  const hit = parsed.get(abs);
  if (hit !== undefined) return hit;
  let text: string;
  try { text = readFileSync(abs, 'utf8'); } catch { parsed.set(abs, null); return null; }
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  const imports: string[] = [];
  const exportsFrom = new Map<string, string>();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text.startsWith('.')) imports.push(resolve(dirname(abs), st.moduleSpecifier.text));
    if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      const file = resolve(dirname(abs), st.moduleSpecifier.text);
      if (st.exportClause && ts.isNamedExports(st.exportClause) && !st.isTypeOnly) for (const e of st.exportClause.elements) exportsFrom.set(e.name.text, file);
    }
  }
  const p: Parsed = { imports, exportsFrom, blocks: text.includes('tunables') ? findTunables(abs, text) : [] };
  parsed.set(abs, p);
  return p;
}

/** The names a project file takes from `hull/kits`; `'*'` when it takes the whole module. */
export function kitImports(file: string, text: string): string[] {
  if (!text.includes('hull/kits')) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  const out: string[] = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== 'hull/kits') continue;
    const c = st.importClause;
    if (c?.isTypeOnly) continue;
    if (!c || c.name || (c.namedBindings && ts.isNamespaceImport(c.namedBindings))) { out.push('*'); continue; }
    if (c.namedBindings && ts.isNamedImports(c.namedBindings)) for (const e of c.namedBindings.elements) if (!e.isTypeOnly) out.push((e.propertyName ?? e.name).text);
  }
  return out;
}

/** Every tunables block (even one with no literal numbers) of the kits that `imported` pulls in, with the kit file that declares it. */
export function kitBlocks(imported: Iterable<string>): { block: string; file: string }[] {
  const out: { block: string; file: string }[] = [];
  walkKits(imported, (abs, p) => { for (const b of p.blocks) out.push({ block: b.block, file: abs.slice(hullSrc.length + 1) }); });
  return out;
}

/** Every literal tunable of the kits that `imported` (names from `hull/kits`) pulls in. */
export function kitTunables(imported: Iterable<string>): KitTunable[] {
  const out: KitTunable[] = [];
  walkKits(imported, (abs, p) => { for (const b of p.blocks) for (const t of b.tunables) out.push({ ...t, file: abs.slice(hullSrc.length + 1) }); });
  return out;
}

function walkKits(imported: Iterable<string>, visit: (abs: string, p: Parsed) => void): void {
  const index = parse(join(hullSrc, 'kits', 'index.ts'));
  if (!index) return;
  const names = new Set(imported);
  const queue: string[] = [];
  for (const [name, file] of index.exportsFrom) if (names.has('*') || names.has(name)) queue.push(file);
  // Walk the kit files each used kit imports (health under spawner, and so on): the game would load them too.
  const seen = new Set<string>();
  while (queue.length) {
    const abs = queue.pop()!;
    if (seen.has(abs)) continue;
    seen.add(abs);
    const p = parse(abs);
    if (!p) continue;
    visit(abs, p);
    for (const i of p.imports) if (i.includes('/kits/')) queue.push(i);
  }
}
