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
export function standaloneTsconfig(): string {
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
  const to = resolve(opts.dir);
  if (existsSync(to) && readdirSync(to).length > 0) throw new Error(`${to} exists and is not empty`);
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true, filter: (src) => src === from || !skip.has(basename(src)) });

  let manifest = readFileSync(join(to, 'hull.json'), 'utf8');
  const set = (pointer: string, value: unknown): void => {
    const r = setJsonPointer(manifest, pointer, value);
    if (r.ok) manifest = r.text;
  };
  set('/title', opts.title);
  const id = slug(opts.title);
  if (/^[a-z0-9][a-z0-9-]*$/.test(id)) set('/id', id);
  writeFileSync(join(to, 'hull.json'), manifest);

  writeFileSync(join(to, 'tsconfig.json'), standaloneTsconfig());
  writeFileSync(join(to, 'package.json'), `${JSON.stringify({ name: id || 'game', version: '0.0.0', private: true, type: 'module' }, null, 2)}\n`);
  return { root: to };
}
