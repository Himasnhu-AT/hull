// The community catalog: games anyone can open to play and to try the editor on a real project. Today the catalog is
// the repository's examples/ folder; later it comes from Marl's servers. Callers go through `catalog()` only, so that
// is the one function to replace.
//
// Opening never touches the shipped game: the first open copies it into the person's projects folder
// (<projectsDir>/community/<id>), later opens reuse that copy, and `reset` replaces it with a fresh one.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { copyProject, repoRoot } from './templates.ts';

export interface CommunityGame {
  id: string;
  title: string;
  note: string;
  /** The cover as a data: URL (16:9, small), or null when the game ships none. */
  cover: string | null;
  /** Where this person's copy lives (it may not exist yet) and whether it does. */
  copy: { root: string; exists: boolean };
}

interface Entry { id: string; title: string; note: string; dir: string; coverFile: string | null }

const COVERS: [string, string][] = [['cover.webp', 'image/webp'], ['cover.jpg', 'image/jpeg'], ['cover.png', 'image/png']];
export const examplesDir = join(repoRoot, 'examples');

/** The one place the games come from. */
export function catalog(): Entry[] {
  let names: string[];
  try { names = readdirSync(examplesDir).sort(); } catch { return []; }
  const out: Entry[] = [];
  for (const id of names) {
    const dir = join(examplesDir, id);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const m = JSON.parse(readFileSync(join(dir, 'hull.json'), 'utf8')) as { kind?: string; title?: string; note?: string };
      if (m.kind !== 'game') continue;
      const cover = COVERS.find(([f]) => existsSync(join(dir, f)));
      // A game without a cover is not listed: the launcher shows a picture for every game.
      if (!cover) continue;
      out.push({ id, title: m.title ?? id, note: m.note ?? '', dir, coverFile: cover[0] });
    } catch { /* not a game */ }
  }
  return out;
}

const copyRoot = (projectsDir: string, id: string): string => join(projectsDir, 'community', id);
const isProject = (dir: string): boolean => existsSync(join(dir, 'hull.json'));

export function listCommunity(opts: { projectsDir: string }): CommunityGame[] {
  return catalog().map((e) => {
    const mime = COVERS.find(([f]) => f === e.coverFile)![1];
    const cover = `data:${mime};base64,${readFileSync(join(e.dir, e.coverFile!)).toString('base64')}`;
    const root = copyRoot(opts.projectsDir, e.id);
    return { id: e.id, title: e.title, note: e.note, cover, copy: { root, exists: isProject(root) } };
  });
}

/**
 * Makes sure the person's copy exists and returns its folder. `reset` replaces an existing copy with the original.
 * The copy is built beside the target and moved in, so a failure part way never leaves a half copy that later opens
 * would trust.
 */
export function openCommunity(opts: { id: string; projectsDir: string; reset?: boolean }): { root: string; created: boolean } {
  const entry = catalog().find((e) => e.id === opts.id);
  if (!entry) throw new Error(`no community game '${opts.id}' (have: ${catalog().map((e) => e.id).join(', ') || 'none'})`);
  const root = copyRoot(opts.projectsDir, entry.id);
  if (isProject(root) && !opts.reset) return { root, created: false };
  const parent = join(opts.projectsDir, 'community');
  mkdirSync(parent, { recursive: true });
  const staging = join(parent, `.${entry.id}.new`);
  rmSync(staging, { recursive: true, force: true });
  copyProject({ from: entry.dir, dir: staging });
  rmSync(root, { recursive: true, force: true });
  renameSync(staging, root);
  return { root, created: true };
}
