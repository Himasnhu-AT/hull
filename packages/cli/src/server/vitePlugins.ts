// Vite plugins shared by the project server (dev page) and the build.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { compileTunables } from './tsTunables.ts';
import { hullSrc } from './templates.ts';

const hullPkg = JSON.parse(readFileSync(join(hullSrc, '..', 'package.json'), 'utf8')) as { exports: Record<string, string> };

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
