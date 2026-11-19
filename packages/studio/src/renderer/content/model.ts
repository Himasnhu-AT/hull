// The Content Browser's model: the Library's items plus the project's code files, arranged as folders. Pure, so it is tested.
// A folder is a path: 'config/sound/combat' (assets of the sound kind), 'src/player' (code), or '' for the root.
import type { LibraryItem } from 'hull/dev/protocol';

export interface Entry {
  /** The selection id shared with the Library and the Inspector: a config id, 'tunables:<block>', or 'code:<path>'. */
  key: string;
  name: string;
  kind: string;
  dir: string;
  problems: number;
  /** A config file the server can rename, move and delete: its id is the key. */
  config: boolean;
  /** Where the entry lives on disk, project-relative. */
  path: string;
}

/** Kinds shown as one chip. */
export const chipOf = (kind: string): string => (kind === 'anim-set' || kind === 'anim-graph' ? 'anim' : kind);

/** The chips the brief names first, in that order; any other kind in the project follows. */
export const CHIP_ORDER = ['sound', 'vfx', 'material', 'character', 'look', 'anim', 'input-map', 'tunables', 'code'];

const dirOf = (path: string): string => path.split('/').slice(0, -1).join('/');

export function buildEntries(items: readonly LibraryItem[], code: readonly { path: string }[]): Entry[] {
  const out: Entry[] = [];
  const tunedFiles = new Set<string>();
  for (const it of items) {
    if (it.kind === 'tunables') {
      tunedFiles.add(it.path);
      out.push({ key: it.id, name: it.title, kind: 'tunables', dir: dirOf(it.path), problems: it.problems, config: false, path: it.path });
    } else if (it.id === 'hull.json') {
      out.push({ key: it.id, name: 'hull.json', kind: 'game', dir: '', problems: it.problems, config: false, path: 'hull.json' });
    } else {
      const parts = it.id.split('/');
      out.push({ key: it.id, name: parts.at(-1)!, kind: it.kind, dir: `config/${parts.slice(0, -1).join('/')}`, problems: it.problems, config: true, path: it.path });
    }
  }
  for (const c of code) {
    if (tunedFiles.has(c.path)) continue;
    out.push({ key: `code:${c.path}`, name: c.path.split('/').at(-1)!, kind: 'code', dir: dirOf(c.path), problems: 0, config: false, path: c.path });
  }
  return out;
}

export const parentDir = (dir: string): string => {
  const up = dir.split('/').slice(0, -1).join('/');
  return up === 'config' ? '' : up;
};

/** Every folder: the ones on disk (config/ only), and every ancestor of an entry. */
export function buildFolders(configFolders: readonly string[], entries: readonly Entry[]): Set<string> {
  const all = new Set<string>();
  const add = (dir: string): void => {
    for (let d = dir; d && d !== 'config'; d = parentDir(d)) { if (all.has(d)) break; all.add(d); }
  };
  for (const f of configFolders) add(`config/${f}`);
  for (const e of entries) add(e.dir);
  return all;
}

export const childFolders = (folders: ReadonlySet<string>, dir: string): string[] => [...folders].filter((f) => parentDir(f) === dir).sort((a, b) => a.localeCompare(b));

/** 'config/sound/combat' -> sound. Anything else (the root, src/) has no asset kind. */
export const kindOfDir = (dir: string): string | null => (dir.startsWith('config/') ? dir.split('/')[1]! : null);

/** The label of a folder: its last segment. */
export const folderName = (dir: string): string => dir.split('/').at(-1) ?? '';

export const crumbs = (dir: string): { dir: string; label: string }[] => {
  const out = [{ dir: '', label: 'Content' }];
  const parts = dir.split('/');
  let at = '';
  for (let i = 0; i < parts.length && dir; i++) {
    at = at ? `${at}/${parts[i]}` : parts[i]!;
    if (at === 'config') continue;
    out.push({ dir: at, label: parts[i]! });
  }
  return out;
};

export interface Filter {
  query: string;
  kinds: ReadonlySet<string>;
  changed: boolean;
  problems: boolean;
  changedKeys: ReadonlySet<string>;
}
export const isFiltering = (f: Filter): boolean => f.query.trim() !== '' || f.kinds.size > 0 || f.changed || f.problems;

export function filterEntries(entries: readonly Entry[], f: Filter): Entry[] {
  const q = f.query.trim().toLowerCase();
  return entries.filter((e) =>
    (f.kinds.size === 0 || f.kinds.has(chipOf(e.kind))) &&
    (!f.changed || f.changedKeys.has(e.key)) &&
    (!f.problems || e.problems > 0) &&
    (!q || `${e.key} ${e.name} ${e.kind}`.toLowerCase().includes(q)));
}

/** What a folder view shows: its own entries, or with a filter on every entry at or below it. */
export function visibleEntries(entries: readonly Entry[], dir: string, deep: boolean): Entry[] {
  const list = deep ? entries.filter((e) => dir === '' || e.dir === dir || e.dir.startsWith(dir + '/')) : entries.filter((e) => e.dir === dir);
  return list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export const countIn = (entries: readonly Entry[], dir: string): number => entries.filter((e) => dir === '' || e.dir === dir || e.dir.startsWith(dir + '/')).length;

export const validName = (name: string): boolean => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name) && !name.endsWith('.');

/** The config id of a name inside a folder: 'config/sound/combat' + 'hit' -> 'sound/combat/hit'. */
export const idIn = (dir: string, name: string): string => `${dir.slice('config/'.length)}/${name}`;

export function uniqueName(entries: readonly Entry[], dir: string, base: string): string {
  const taken = new Set(entries.filter((e) => e.dir === dir).map((e) => e.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** A drop is allowed when every dragged entry is a config asset of the kind the folder holds. */
export function canDrop(dragged: readonly Entry[], dir: string): boolean {
  const kind = kindOfDir(dir);
  return kind !== null && dragged.length > 0 && dragged.every((e) => e.config && e.kind === kind && e.dir !== dir);
}

/** A dragged folder may go into another folder of its kind that is not itself or below itself. */
export const canDropFolder = (folder: string, into: string): boolean =>
  kindOfDir(folder) !== null && kindOfDir(folder) === kindOfDir(into) && folder !== into && parentDir(folder) !== into && !(into + '/').startsWith(folder + '/');

/** The kinds of a folder's chips present in a set of entries, in the brief's order then alphabetically. */
export function chipsIn(entries: readonly Entry[]): string[] {
  const present = new Set(entries.map((e) => chipOf(e.kind)));
  return [...CHIP_ORDER.filter((c) => present.has(c)), ...[...present].filter((c) => !CHIP_ORDER.includes(c)).sort()];
}
