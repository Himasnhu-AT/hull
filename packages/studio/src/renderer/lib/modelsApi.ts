// The character bench's project models: the bodies a game builds in code. The project server bundles the module that
// hull.json "models" names (tools/server/bench.ts) as a script that takes the Studio's own engine, so what it builds is
// drawn by the bench's renderer and reads the config the bench has loaded.

import type { BenchModelBuilder } from 'hull/anim';
import type { Engine } from '../benches/engine.ts';

export interface ProjectModels {
  /** The project's builder for a character id ("titan-average-M"), or null when it has none and the bench draws its stand-in. */
  find(id: string): BenchModelBuilder | null;
}

const none: ProjectModels = { find: () => null };

/** Loads the project's models. Resolves to an empty set when the project has no "models" module; throws the server's message when it does not bundle or run. */
export async function loadProjectModels(gameUrl: string, eng: Engine): Promise<ProjectModels> {
  const r = await fetch(new URL('__hull/bench/models.js', gameUrl));
  if (r.status === 404) return none;
  const text = await r.text();
  if (!r.ok) throw new Error(text);
  const provided: Record<string, unknown> = { hull: eng.hull, 'hull/render': eng.render, 'hull/anim': eng.anim, 'hull/vfx': eng.vfx, 'hull/three': eng.three };
  const scope = new Proxy(provided, {
    get(t, k: string) {
      if (k in t) return t[k];
      throw new Error(`the models module imports "${k}", which the character bench does not provide`);
    },
  });
  const entries: { prefix: boolean; key: string; build: BenchModelBuilder }[] = [];
  const mod = new Function('__hull', `${text}\nreturn HullBenchModels;`)(scope) as unknown;
  const register = (typeof mod === 'function' ? mod : (mod as { default?: unknown } | null)?.default) as ((reg: (match: string, build: BenchModelBuilder) => void) => void) | undefined;
  if (typeof register !== 'function') throw new Error('the models module has no default export to call');
  register((match, build) => {
    const prefix = match.endsWith('*');
    entries.push({ prefix, key: (prefix ? match.slice(0, -1) : match).replace(/^character\//, ''), build });
  });
  return {
    find(id) {
      const bare = id.replace(/^character\//, '');
      // An exact id beats a prefix; the longest prefix beats a shorter one.
      let best: { len: number; build: BenchModelBuilder } | null = null;
      for (const e of entries) {
        if (e.prefix ? bare.startsWith(e.key) : bare === e.key) {
          const len = e.prefix ? e.key.length : Infinity;
          if (!best || len > best.len) best = { len, build: e.build };
        }
      }
      return best?.build ?? null;
    },
  };
}
