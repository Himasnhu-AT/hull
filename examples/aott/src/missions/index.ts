// The MISSIONS screen: every mission in story order, its chapters, and which chapters the player has opened.
// A mission is a mode ('gate', 'scout') that Game (src/game.ts) starts at a chapter; finishing a chapter opens the
// next (Game.chapterDone). Progress is kept in the browser (aott.progress: { [mission]: chapters open }).
import { CAST, MISSION, PLACE } from '../brand';
import { CHAPTERS as SCOUT } from './scout';

export type MissionId = 'gate' | 'scout';

export interface Chapter {
  title: string;
  /** A short tag shown before the description (e.g. "Four acts"). */
  eps?: string;
  desc: string;
}

export interface Mission {
  id: MissionId;
  title: string;
  place: string;
  /** A short tag shown after the place on the missions screen. */
  eps: string;
  chapters: Chapter[];
}

/** One mission as the HUD's MISSIONS screen lists it. */
export interface MissionListing {
  id: MissionId;
  title: string;
  place: string;
  eps: string;
  chapters: (Chapter & { locked: boolean })[];
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export const MISSIONS: Mission[] = [
  {
    id: 'gate', title: cap(MISSION.gateBattle), place: PLACE.townLong, eps: 'Part one',
    chapters: [{ title: MISSION.gate, eps: 'One act', desc: `Guard ${CAST.shifter} while his giant hauls the boulder to the breach` }],
  },
  { id: 'scout', title: MISSION.sortie, place: `Beyond ${PLACE.innerWall}`, eps: 'Part two', chapters: SCOUT },
];

const KEY = 'aott.progress';
type Progress = Partial<Record<MissionId, number>>;

function load(): Progress {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) || '{}');
    return v && typeof v === 'object' ? (v as Progress) : {};
  } catch { return {}; }
}

/** Chapters open in a mission (the first is always open). */
export const opened = (id: MissionId): number => Math.max(1, load()[id] || 1);

/** Open chapter `ch` (0-based) of a mission, and every chapter before it. */
export function unlock(id: MissionId, ch: number): void {
  const p = load();
  p[id] = Math.max(p[id] || 1, ch + 1);
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* not kept */ }
}

/** For the HUD: the missions with each chapter's title, tag, line and whether it's still locked. */
export function missionList(): MissionListing[] {
  return MISSIONS.map((m) => {
    const n = opened(m.id);
    return { id: m.id, title: m.title, place: m.place, eps: m.eps, chapters: m.chapters.map((c, i) => ({ title: c.title, eps: c.eps, desc: c.desc, locked: i >= n })) };
  });
}
