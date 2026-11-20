// Vite plugins shared by the project server (dev page) and the build.
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { compileTunables } from './tsTunables.ts';
import { hullSrc } from './templates.ts';

const hullPkg = JSON.parse(readFileSync(join(hullSrc, '..', 'package.json'), 'utf8')) as { exports: Record<string, string> };

/** Every `hull` import and the engine file it means, as an exact-match pattern: for tools (like the test runner) that have no Vite plugin slot. */
export function hullAliases(): { pattern: string; target: string }[] {
  return Object.entries(hullPkg.exports).map(([key, target]) => ({
    pattern: key === '.' ? '^hull$' : `^hull/${key.slice(2).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`,
    target: join(hullSrc, '..', target),
  }));
}

/**
 * Finds `hull` and `hull/<module>` from the engine's package exports, wherever the project is. A project made from a
 * template has no node_modules, so a normal lookup from its folder would fail; this is the build-time twin of the
 * `paths` in the project's tsconfig.
 */
export function hullResolve(): Plugin {
  return {
    name: 'hull-resolve',
    enforce: 'pre',
    resolveId(id) {
      if (id !== 'hull' && !id.startsWith('hull/')) return undefined;
      const target = hullPkg.exports[id === 'hull' ? '.' : `./${id.slice('hull/'.length)}`];
      return target ? join(hullSrc, '..', target) : undefined;
    },
  };
}

/** Serves one generated module under a virtual id. */
export function virtualModule(id: string, source: () => string): Plugin {
  const resolved = `\0${id}`;
  return {
    name: `hull-virtual:${id}`,
    resolveId: (s) => (s === id ? resolved : undefined),
    load: (s) => (s === resolved ? source() : undefined),
  };
}

/** Build only: every fully literal tunables block becomes a frozen object of constants. */
export function tunablesToConstants(): Plugin {
  return {
    name: 'hull-tunables-constants',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]!;
      if (!file.endsWith('.ts') || file.includes('/node_modules/') || file.startsWith(hullSrc) || !code.includes('tunables(')) return undefined;
      const out = compileTunables(file, code);
      return out ? { code: out, map: null } : undefined;
    },
  };
}

/**
 * Build only: config was validated before bundling, so the registry's validator (Ajv and its code) is swapped for a
 * stub that accepts everything. The shipped game holds values, not a validator (ARCHITECTURE section 4).
 */
export function skipValidator(): Plugin {
  const id = '\0hull-validate-stub';
  return {
    name: 'hull-skip-validator',
    enforce: 'pre',
    resolveId(source, importer) {
      return source.endsWith('/validate.ts') && importer?.startsWith(join(hullSrc, 'config')) ? id : undefined;
    },
    load: (s) => (s === id
      ? 'export const validateAgainst = () => []; export const collectRefs = () => []; export const segments = () => []; export const valueAt = () => undefined;'
      : undefined),
  };
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Aliases for the engine's own dependencies (three, typebox, ajv) and for `hull` itself, as absolute paths. The
 * dependency optimiser does not run plugins and looks for packages from the project's folder, where a template copy has
 * none; an alias is the one thing it honours. Package exports are followed for ESM, wildcards included.
 */
export function engineAliases(): { find: RegExp; replacement: string }[] {
  const out: { find: RegExp; replacement: string }[] = Object.entries(hullPkg.exports).map(([key, target]) => ({
    find: new RegExp(`^hull${key === '.' ? '' : esc(key.slice(1))}$`),
    replacement: join(hullSrc, '..', target),
  }));
  for (const name of ['three', 'typebox', 'ajv']) {
    const dir = realpathSync(join(hullSrc, '..', 'node_modules', name));
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { exports?: Record<string, string | Record<string, string>>; module?: string; main?: string };
    const pick = (v: string | Record<string, string>): string => (typeof v === 'string' ? v : (v['import'] ?? v['default'] ?? ''));
    if (!pkg.exports) {
      out.push({ find: new RegExp(`^${esc(name)}$`), replacement: join(dir, pkg.main ?? 'index.js') });
      out.push({ find: new RegExp(`^${esc(name)}/(.*)$`), replacement: `${dir}/$1` });
      continue;
    }
    if (!pkg.exports['.'] && (pkg.module ?? pkg.main)) out.push({ find: new RegExp(`^${esc(name)}$`), replacement: join(dir, (pkg.module ?? pkg.main)!) });
    for (const [key, value] of Object.entries(pkg.exports)) {
      const target = pick(value);
      if (!target) continue;
      const full = name + key.slice(1);
      out.push(key.includes('*')
        ? { find: new RegExp(`^${esc(full).replace('\\*', '(.*)')}$`), replacement: `${dir}/${target.slice(2).replace('*', '$1')}` }
        : { find: new RegExp(`^${esc(full)}$`), replacement: join(dir, target) });
    }
  }
  return out;
}
