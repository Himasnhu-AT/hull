// The Library groups what library.list returns by what a person thinks about, not by file kind:
// Gameplay, Characters, Audio, World, Interface, Input (the Unity Project window, sorted the way a designer asks).

import type { LibraryItem } from 'hull/dev/protocol';

export const DOMAINS = ['Gameplay', 'Characters', 'Audio', 'World', 'Interface', 'Input', 'Other'] as const;
export type Domain = (typeof DOMAINS)[number];

const BY_KIND: Record<string, Domain> = {
  tuning: 'Gameplay', game: 'Gameplay', tunables: 'Gameplay', level: 'Gameplay', rules: 'Gameplay', ai: 'Gameplay',
  character: 'Characters', animation: 'Characters', anim: 'Characters', body: 'Characters', rig: 'Characters',
  sound: 'Audio', mixer: 'Audio', music: 'Audio', bus: 'Audio',
  look: 'World', material: 'World', vfx: 'World', terrain: 'World', environment: 'World', world: 'World',
  'ui-theme': 'Interface', 'ui-screen': 'Interface', ui: 'Interface', font: 'Interface',
  'input-map': 'Input', input: 'Input',
};

export const domainOf = (kind: string): Domain => BY_KIND[kind] ?? 'Other';

export type LibraryFilter = 'all' | 'changed' | 'problems';

export type LibraryRow = { type: 'sub'; label: string } | { type: 'row'; item: LibraryItem; short: string };

export interface LibraryGroup { domain: Domain; count: number; attention: boolean; rows: LibraryRow[] }

/** 'sound/sword/hit' -> folder 'sword', short 'hit'. Code blocks have no folder. */
export function splitId(item: LibraryItem): { folder: string; short: string } {
  if (item.kind === 'tunables') return { folder: '', short: item.title };
  const parts = item.id.split('/').slice(1);
  return { folder: parts.length > 1 ? parts.slice(0, -1).join('/') : '', short: parts.at(-1) ?? item.id };
}

export function groupLibrary(items: readonly LibraryItem[], opts: { query: string; filter: LibraryFilter; changed: ReadonlySet<string> }): LibraryGroup[] {
  const q = opts.query.trim().toLowerCase();
  const by = new Map<Domain, LibraryItem[]>();
  for (const it of items) {
    if (opts.filter === 'problems' && it.problems === 0) continue;
    if (opts.filter === 'changed' && !opts.changed.has(it.id)) continue;
    if (q && !`${it.id} ${it.kind} ${it.title} ${it.note ?? ''}`.toLowerCase().includes(q)) continue;
    const d = domainOf(it.kind);
    let list = by.get(d);
    if (!list) by.set(d, (list = []));
    list.push(it);
  }
  const out: LibraryGroup[] = [];
  for (const domain of DOMAINS) {
    const list = by.get(domain);
    if (!list) continue;
    const sorted = [...list].sort((a, b) => {
      const A = splitId(a), B = splitId(b);
      return A.folder.localeCompare(B.folder) || A.short.localeCompare(B.short);
    });
    const rows: LibraryRow[] = [];
    let lastFolder = '';
    for (const item of sorted) {
      const { folder, short } = splitId(item);
      if (folder && folder !== lastFolder) rows.push({ type: 'sub', label: folder });
      lastFolder = folder;
      rows.push({ type: 'row', item, short });
    }
    out.push({ domain, count: list.length, attention: list.some((i) => i.problems > 0), rows });
  }
  return out;
}
