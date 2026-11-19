// The four lessons, in the order the rail shows them. Each is a whiteboard lesson in JSON (see ../lesson.ts).
// They are read as text and parsed, which keeps the JSON files out of the TypeScript project's file list.
import type { Lesson } from '../lesson.ts';

const files = import.meta.glob('./*.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;

const ORDER = ['what-is-hull', 'every-change-is-safe', 'play-and-fix', 'who-builds'] as const;

export const LESSONS: readonly Lesson[] = ORDER.map((name) => {
  const text = files['./' + name + '.json'];
  if (text === undefined) throw new Error('lesson file missing: ' + name + '.json');
  return JSON.parse(text) as Lesson;
});
