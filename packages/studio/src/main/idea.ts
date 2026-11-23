// From one sentence of idea to what the app needs to start a project: which template is closest, and a short title.
// Pure, so the launcher's idea box behaves the same in Electron and in web mode and is tested without either.

export type TemplateName = 'fps' | 'third-person' | 'yard';

const FIRST_PERSON = /\b(first[- ]person|fps|shooter|shoot(?:ing|s)?|gun|guns|rifle|pistol|blaster|ammo|sniper|drones?)\b/i;
const THIRD_PERSON = /\b(third[- ]person|sword|swords|samurai|ninja|knight|blade|katana|melee|action|combat|fight(?:ing|s)?|brawler|adventure|swordswoman|warrior)\b/i;

/** Shooter words win over action words when both appear; anything else gets the yard (a small complete game on kits and a level file). */
export function pickTemplate(idea: string): TemplateName {
  if (/\bfirst[- ]person\b/i.test(idea)) return 'fps';
  if (/\bthird[- ]person\b/i.test(idea)) return 'third-person';
  if (FIRST_PERSON.test(idea)) return 'fps';
  if (THIRD_PERSON.test(idea)) return 'third-person';
  return 'yard';
}

const SMALL = new Set(['a', 'an', 'the', 'game', 'where', 'i', 'my', 'me', 'with', 'and', 'of', 'to', 'in', 'on', 'it', 'is', 'that', 'make', 'want', 'like', 'about', 'small', 'little']);

/** A short name for the project: the first few meaningful words, capitalised. "A third-person samurai game on a windy island." -> "Third-person Samurai Windy Island". */
export function titleFromIdea(idea: string): string {
  const words = idea.split(/[.!?\n]/)[0]!.split(/[^A-Za-z0-9'-]+/).filter(Boolean);
  const keep = words.filter((w) => !SMALL.has(w.toLowerCase())).slice(0, 4);
  const title = keep.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ').slice(0, 40).trim();
  return title || 'My Game';
}
