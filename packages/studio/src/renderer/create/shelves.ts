// Everything: the project's pieces grouped on shelves, named in plain words, tagged by what the person has done with them.
// No React here, so it is unit-tested in Node.

import type { LibraryItem, ReviewEntry } from 'hull/dev/protocol';
import { words } from '../history/plain.ts';

export type ShelfId = 'actors' | 'animations' | 'sounds' | 'world' | 'effects' | 'screens' | 'rules' | 'other';

export interface ShelfDef { id: ShelfId; title: string; kinds: string[] }

/** In the order they are shown. Kinds not listed fall to the nearest shelf (see shelfOf) or to Other. */
export const SHELVES: ShelfDef[] = [
  { id: 'actors', title: 'Actors', kinds: ['character', 'enemy'] },
  { id: 'animations', title: 'Animations', kinds: ['anim-set', 'anim-graph', 'move-set'] },
  { id: 'sounds', title: 'Sounds', kinds: ['sound', 'mixer'] },
  { id: 'world', title: 'World', kinds: ['look', 'material', 'level'] },
  { id: 'effects', title: 'Effects', kinds: ['vfx'] },
  { id: 'screens', title: 'Screens', kinds: ['ui-screen', 'ui-theme', 'input-map'] },
  { id: 'rules', title: 'Rules', kinds: ['tuning', 'tunables', 'game'] },
  { id: 'other', title: 'Other', kinds: [] },
];

/** Kinds the table does not name go to the nearest shelf by their name. */
export function shelfOf(kind: string): ShelfId {
  for (const s of SHELVES) if (s.kinds.includes(kind)) return s.id;
  if (/char|enem|npc|player|actor/.test(kind)) return 'actors';
  if (/anim|move|clip|rig/.test(kind)) return 'animations';
  if (/sound|audio|music|mix/.test(kind)) return 'sounds';
  if (/look|material|level|world|sky|terrain|texture|mesh|model|scene/.test(kind)) return 'world';
  if (/vfx|effect|particle/.test(kind)) return 'effects';
  if (/ui|screen|theme|input|hud/.test(kind)) return 'screens';
  if (/tun|rule|balance|game|config/.test(kind)) return 'rules';
  return 'other';
}

/** A name in plain words: the item's own title when it has one that reads like words, else the last part of its id. */
export function plainName(item: Pick<LibraryItem, 'id' | 'kind' | 'title'>): string {
  const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
  if (item.kind === 'tunables') return cap(words(item.title.replace(/^tunables:/, '')));
  const t = item.title.trim();
  // A title that is only the id, or a path, is not a name.
  const idLike = !t || t === item.id || t.includes('/') || t.includes('.');
  if (!idLike) return t;
  const last = item.id.slice(item.id.lastIndexOf('/') + 1).replace(/^tunables:/, '');
  return cap(words(last)) || item.id;
}

/** What the card says about the piece: the tag the person sees. */
export type CardTag = 'new' | 'approved' | 'note';
export const TAG_TEXT: Record<CardTag, string> = { new: 'New', approved: 'Approved', note: 'Note sent' };

export function tagOf(entry: ReviewEntry | undefined): CardTag {
  // A piece that changed after it was reviewed is new again.
  if (!entry || entry.stale) return 'new';
  return entry.state === 'approved' ? 'approved' : entry.state === 'needs-change' ? 'note' : 'new';
}

export interface Card {
  /** Config id or 'tunables:<block>': also the review key. */
  key: string;
  kind: string;
  name: string;
  note: string;
  tag: CardTag;
  problems: number;
  item: LibraryItem;
}

export interface Shelf { id: ShelfId; title: string; cards: Card[] }

/** A kind in words for the small label on a card: 'anim-set' -> 'animation set'. */
export const kindWords = (kind: string): string => (kind === 'tunables' ? 'numbers' : kind === 'game' ? 'game' : words(kind));

export function buildShelves(items: readonly LibraryItem[], reviews: readonly ReviewEntry[]): Shelf[] {
  const byKey = new Map(reviews.map((r) => [r.key, r] as const));
  const out = new Map<ShelfId, Shelf>(SHELVES.map((s) => [s.id, { id: s.id, title: s.title, cards: [] }]));
  for (const item of items) {
    out.get(shelfOf(item.kind))!.cards.push({
      key: item.id, kind: item.kind, name: plainName(item), note: item.note ?? '', tag: tagOf(byKey.get(item.id)), problems: item.problems, item,
    });
  }
  for (const s of out.values()) s.cards.sort((a, b) => a.name.localeCompare(b.name));
  return SHELVES.map((s) => out.get(s.id)!).filter((s) => s.cards.length > 0);
}

/** How many pieces are still new: the count the Everything tab shows. */
export const countNew = (shelves: readonly Shelf[]): number => shelves.reduce((n, s) => n + s.cards.filter((c) => c.tag === 'new').length, 0);
