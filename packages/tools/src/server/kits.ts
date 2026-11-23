// The kits' config as a tool sees it: which kit ships which files, which import names belong to which kit, and which of a
// kit's files a project already has. Pure over the hull package's folder, so it is tested without a server. The project
// server applies a kit.add plan like any other write (validated, recorded in the history).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { firstSentence, hullDir } from '../create/docs.ts';

export interface KitInfo {
  kit: string;
  /** The first sentence of the kit's README. */
  summary: string;
  /** The config ids the kit ships ('material/floor'). */
  config: string[];
  /** The names the kit adds to 'hull/kits'. */
  exports: string[];
}

const kitsDir = (): string => join(hullDir(), 'src', 'kits');
const readText = (p: string): string => readFileSync(p, 'utf8');
const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** The config files a kit ships: [config id, absolute path], sorted. */
export function kitFiles(kit: string): { id: string; abs: string }[] {
  const base = join(kitsDir(), kit, 'config');
  const out: { id: string; abs: string }[] = [];
  const walk = (dir: string, rel: string): void => {
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const n of names) {
      if (isDir(join(dir, n))) walk(join(dir, n), rel ? rel + '/' + n : n);
      else if (n.endsWith('.json')) out.push({ id: (rel ? rel + '/' : '') + n.slice(0, -'.json'.length), abs: join(dir, n) });
    }
  };
  walk(base, '');
  return out;
}

/** The source of a file without its comments, so a doc comment that mentions an id does not count as using it. */
const code = (file: string): string => readText(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * Which kit and which source file each name of 'hull/kits' comes from: read from the kits' index.ts
 * (`export { A, B } from './level/level.ts'`, and `export * from './combat/index.ts'`, which is followed into that folder's own
 * index). Names from files outside a kit folder (io.ts, common.ts) belong to no kit. Type-only exports are left out.
 */
export function exportOwners(): Map<string, { kit: string; file: string }> {
  const dir = kitsDir();
  const owners = new Map<string, { kit: string; file: string }>();
  const scan = (file: string, folder: string | undefined, seen: Set<string>): void => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    for (const m of code(file).matchAll(/export\s+(type\s+)?(\{[^}]*\}|\*)\s+from\s+'([^']+)'/g)) {
      if (m[1]) continue;
      const target = resolve(dirname(file), m[3]!);
      const top = target.startsWith(dir + '/') ? target.slice(dir.length + 1).split('/')[0]! : undefined;
      const owner = folder ?? (top && isDir(join(dir, top)) ? top : undefined);
      if (m[2] === '*') { scan(target, owner, seen); continue; }
      if (!owner) continue;
      for (const spec of m[2]!.slice(1, -1).split(',')) {
        const s = spec.trim();
        if (!s || s.startsWith('type ')) continue;
        const as = /\bas\s+(\w+)$/.exec(s);
        owners.set(as ? as[1]! : s, { kit: owner, file: target });
      }
    }
  };
  scan(join(dir, 'index.ts'), undefined, new Set());
  return owners;
}

/**
 * The shipped config ids a source file (and what it imports inside its kit folder) names as string literals: what the kit
 * needs at run time when that file's code is used. A kit's example config that nothing here names is optional.
 */
export function idsUsedBy(kit: string, file: string): Set<string> {
  const base = join(kitsDir(), kit);
  const shipped = new Set(kitFiles(kit).map((f) => f.id));
  const found = new Set<string>();
  const seen = new Set<string>();
  const visit = (f: string): void => {
    if (seen.has(f) || !existsSync(f)) return;
    seen.add(f);
    const text = code(f);
    for (const m of text.matchAll(/(['"`])([A-Za-z0-9_-]+\/[A-Za-z0-9_./-]+)\1/g)) if (shipped.has(m[2]!)) found.add(m[2]!);
    for (const m of text.matchAll(/from\s+'(\.[^']+\.ts)'/g)) { const t = resolve(dirname(f), m[1]!); if (t.startsWith(base + '/')) visit(t); }
  };
  visit(file);
  return found;
}

/**
 * The input actions a kit's source reads: `input.action('name')` and `vec2('name')` calls (value undefined), and the default of a field
 * named like an action (`action = 'interact'`: value is the field's name, since a game can set it to another action). A file marked
 * `hull:optional-actions` reads actions only when the game maps them (the combat kit's lock-on and guard), so its direct reads are not listed.
 */
export function actionsUsedBy(kit: string, file: string): Map<string, string | undefined> {
  const base = join(kitsDir(), kit);
  const found = new Map<string, string | undefined>();
  const seen = new Set<string>();
  const visit = (f: string): void => {
    if (seen.has(f) || !existsSync(f)) return;
    seen.add(f);
    const text = code(f);
    if (!/hull:optional-actions/.test(readText(f))) for (const m of text.matchAll(/\binput\.(?:action|vec2|axis)\(\s*'(\w+)'/g)) found.set(m[1]!, undefined);
    for (const m of text.matchAll(/\b(\w*[aA]ction)\s*(?::\s*string\s*)?=\s*'(\w+)'/g)) if (!found.has(m[2]!)) found.set(m[2]!, m[1]!);
    for (const m of text.matchAll(/from\s+'(\.[^']+\.ts)'/g)) { const t = resolve(dirname(f), m[1]!); if (t.startsWith(base + '/')) visit(t); }
  };
  visit(file);
  return found;
}

/** The kits that ship an input map defining `action`, in kit.list order. */
export function kitsWithAction(action: string): string[] {
  return readdirSync(kitsDir()).sort().filter((kit) => kitFiles(kit).some((f) => f.id.startsWith('input-map/') && action in ((JSON.parse(readText(f.abs)) as { actions?: object }).actions ?? {})));
}

/** Every kit folder with a README: its summary, the config it ships and the names it exports. */
export function listKits(): KitInfo[] {
  const dir = kitsDir();
  const owners = exportOwners();
  const out: KitInfo[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir).sort(); } catch { return []; }
  for (const kit of names) {
    const readme = join(dir, kit, 'README.md');
    if (!isDir(join(dir, kit)) || !existsSync(readme)) continue;
    out.push({ kit, summary: firstSentence(readText(readme)), config: kitFiles(kit).map((f) => f.id), exports: [...owners].filter(([, o]) => o.kit === kit).map(([n]) => n).sort() });
  }
  return out;
}

/** The text of a kit's config file by id. */
export const kitFileText = (kit: string, id: string): string => readText(kitFiles(kit).find((f) => f.id === id)!.abs);

const sameJson = (a: string, b: string): boolean => { try { return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b)); } catch { return a === b; } };

/**
 * The project's input map plus the actions the kit's map has and it lacks (an action the project has is never touched; a new
 * action joins the kit's group of the same name, which is made if missing). Null when nothing is missing or the text is not a map.
 */
function mergeInputMap(project: string, shipped: string): { text: string; added: string[] } | null {
  let mine: { actions?: Record<string, unknown>; groups?: Record<string, string[]> };
  let theirs: { actions?: Record<string, unknown>; groups?: Record<string, string[]> };
  try { mine = JSON.parse(project); theirs = JSON.parse(shipped); } catch { return null; }
  if (!mine || typeof mine !== 'object' || !theirs?.actions) return null;
  const actions = (mine.actions ??= {});
  const added = Object.keys(theirs.actions).filter((a) => !(a in actions));
  if (added.length === 0) return null;
  for (const a of added) actions[a] = theirs.actions[a];
  for (const [group, list] of Object.entries(theirs.groups ?? {})) {
    const names = added.filter((a) => list.includes(a));
    if (names.length === 0) continue;
    const groups = (mine.groups ??= {});
    groups[group] = [...(groups[group] ?? []), ...names.filter((a) => !(groups[group] ?? []).includes(a))];
  }
  return { text: JSON.stringify(mine, null, 2) + '\n', added };
}

export interface KitAddPlan {
  ok: true;
  writes: { path: string; text: string }[];
  created: string[];
  kept: string[];
  /** Kept files whose content is not the kit's own. */
  differs: string[];
  /** Input maps that gained actions: id to the action names added. */
  merged: Record<string, string[]>;
}

/**
 * What kit.add would write: the kit's files the project lacks, and those it already has (kept; the ones that differ are
 * listed, and an input map gets the kit's actions it lacks). `read` gives the project's text of a config id.
 */
export function planKitAdd(kit: string, have: ReadonlySet<string>, read: (id: string) => string | undefined = () => undefined): KitAddPlan | { ok: false; message: string } {
  const known = listKits();
  const info = known.find((k) => k.kit === kit);
  if (!info) return { ok: false, message: `there is no kit "${kit}" (kit.list shows them: ${known.map((k) => k.kit).join(', ')})` };
  const writes: { path: string; text: string }[] = [];
  const created: string[] = [];
  const kept: string[] = [];
  const differs: string[] = [];
  const merged: Record<string, string[]> = {};
  for (const f of kitFiles(kit)) {
    if (!have.has(f.id)) {
      writes.push({ path: `config/${f.id}.json`, text: readText(f.abs) });
      created.push(f.id);
      continue;
    }
    kept.push(f.id);
    const mine = read(f.id);
    if (mine === undefined || sameJson(mine, readText(f.abs))) continue;
    differs.push(f.id);
    const m = f.id.startsWith('input-map/') ? mergeInputMap(mine, readText(f.abs)) : null;
    if (m) { writes.push({ path: `config/${f.id}.json`, text: m.text }); merged[f.id] = m.added; }
  }
  return { ok: true, writes, created, kept, differs, merged };
}

/** The kits a source text imports names of from 'hull/kits' (value imports only): the names, where the import starts, the config ids their code uses and the input actions it reads. */
export function kitImports(text: string): { kit: string; names: string[]; at: number; uses: Set<string>; actions: Map<string, string | undefined> }[] {
  const owners = exportOwners();
  const out: { kit: string; names: string[]; at: number; uses: Set<string>; actions: Map<string, string | undefined> }[] = [];
  for (const m of text.matchAll(/import\s+(?!type\b)\{([^}]*)\}\s*from\s*['"]hull\/kits['"]/g)) {
    const byKit = new Map<string, { names: string[]; uses: Set<string>; actions: Map<string, string | undefined> }>();
    for (const spec of m[1]!.split(',')) {
      const s = spec.trim();
      if (!s || s.startsWith('type ')) continue;
      const name = s.split(/\s+as\s+/)[0]!.trim();
      const o = owners.get(name);
      // A `...Tuning` function only declares tunables; the file it lives in names sounds and materials for its other classes.
      if (!o || /Tuning$/.test(name)) continue;
      const e = byKit.get(o.kit) ?? { names: [], uses: new Set<string>(), actions: new Map<string, string | undefined>() };
      e.names.push(name);
      for (const id of idsUsedBy(o.kit, o.file)) e.uses.add(id);
      for (const [a, field] of actionsUsedBy(o.kit, o.file)) e.actions.set(a, field);
      byKit.set(o.kit, e);
    }
    for (const [kit, e] of byKit) out.push({ kit, names: e.names, at: m.index, uses: e.uses, actions: e.actions });
  }
  return out;
}
