// Templates and new projects. A template is a folder under templates/; a project is a copy of it with its own title and
// a tsconfig that stands alone.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setJsonPointer } from './jsonEdit.ts';

const skip = new Set(['node_modules', '.hull', 'dist', 'package.json', 'tsconfig.json']);
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const templatesDir = join(repoRoot, 'templates');
/** The hull package's source folder. It is not published yet, so a project reaches it by path. */
export const hullSrc = join(repoRoot, 'packages', 'hull', 'src');

export function listTemplates(): { name: string; title: string; description: string }[] {
  let names: string[];
  try { names = readdirSync(templatesDir).sort(); } catch { return []; }
  const out: { name: string; title: string; description: string }[] = [];
  for (const name of names) {
    try {
      const m = JSON.parse(readFileSync(join(templatesDir, name, 'hull.json'), 'utf8')) as { title?: string; note?: string };
      out.push({ name, title: m.title ?? name, description: m.note ?? '' });
    } catch { /* not a template */ }
  }
  return out;
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * `hull` is resolved through `paths` in a standalone tsconfig (and a resolver in the dev server and the build), not
 * through a link or a node_modules copy: nothing is installed into the project, it cannot go stale, and when hull is
 * published the alias is deleted and a normal dependency takes its place.
 */
/** The compiler options a project may set for itself; the rest (outDir, paths, composite...) belong to the workspace. */
const OWN_OPTIONS = ['lib', 'strict', 'noUncheckedIndexedAccess', 'verbatimModuleSyntax', 'exactOptionalPropertyTypes', 'noImplicitReturns', 'noPropertyAccessFromIndexSignature'];

export function standaloneTsconfig(own: Record<string, unknown> = {}): string {
  const cfg = {
    compilerOptions: {
      target: 'ES2023',
      lib: ['ES2023', 'DOM'],
      module: 'preserve',
      moduleResolution: 'bundler',
      strict: true,
      noUncheckedIndexedAccess: true,
      noImplicitOverride: true,
      verbatimModuleSyntax: true,
      isolatedModules: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      noEmit: true,
      types: [],
      ...own,
      paths: { hull: [join(hullSrc, 'index.ts')], 'hull/*': [join(hullSrc, '*', 'index.ts'), join(hullSrc, '*.ts')] },
    },
    include: ['src', '.hull/gen'],
    exclude: ['src/**/*.test.ts'],
  };
  return `${JSON.stringify(cfg, null, 2)}\n`;
}

export async function createProject(opts: { template: string; dir: string; title: string }): Promise<{ root: string }> {
  const from = join(templatesDir, opts.template);
  if (!existsSync(join(from, 'hull.json'))) {
    throw new Error(`no template '${opts.template}' (have: ${listTemplates().map((t) => t.name).join(', ')})`);
  }
  return copyProject({ from, dir: opts.dir, title: opts.title });
}

/**
 * Copies a project folder (a template, or a shipped example) into `dir` so it works on its own: no node_modules,
 * .hull or dist, a standalone tsconfig and package.json. A `title` renames it (and sets its id); without one the
 * manifest keeps its own title and id.
 */
export function copyProject(opts: { from: string; dir: string; title?: string }): { root: string } {
  const from = opts.from;
  const to = resolve(opts.dir);
  if (existsSync(to) && readdirSync(to).length > 0) throw new Error(`${to} exists and is not empty`);
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true, filter: (src) => src === from || !skip.has(basename(src)) });

  let manifest = readFileSync(join(to, 'hull.json'), 'utf8');
  const set = (pointer: string, value: unknown): void => {
    const r = setJsonPointer(manifest, pointer, value);
    if (r.ok) manifest = r.text;
  };
  let id = (JSON.parse(manifest) as { id?: string }).id ?? '';
  if (opts.title !== undefined) {
    set('/title', opts.title);
    id = slug(opts.title);
    if (/^[a-z0-9][a-z0-9-]*$/.test(id)) set('/id', id);
  }
  writeFileSync(join(to, 'hull.json'), manifest);

  // A project's own strictness choices (AOTT turns noUncheckedIndexedAccess off) must survive the copy, or it stops type-checking.
  let own: Record<string, unknown> = {};
  try {
    const c = JSON.parse(readFileSync(join(from, 'tsconfig.json'), 'utf8')) as { compilerOptions?: Record<string, unknown> };
    own = Object.fromEntries(Object.entries(c.compilerOptions ?? {}).filter(([k]) => OWN_OPTIONS.includes(k)));
  } catch { /* no tsconfig: the defaults apply */ }
  writeFileSync(join(to, 'tsconfig.json'), standaloneTsconfig(own));
  writeFileSync(join(to, 'package.json'), `${JSON.stringify({ name: id || 'game', version: '0.0.0', private: true, type: 'module' }, null, 2)}\n`);
  return { root: to };
}
