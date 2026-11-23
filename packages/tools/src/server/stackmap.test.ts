import { describe, expect, it } from 'vitest';
import { createStackMapper } from './stackmap.ts';

const withMap = (sources: string[], mappings: string): string =>
  `export {};\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify({ version: 3, sources, names: [], mappings })).toString('base64')}\n`;

describe('stack mapping', () => {
  const fetched: string[] = [];
  const mapper = createStackMapper({
    root: '/work/game',
    origin: () => 'http://127.0.0.1:5000/',
    fetchText: async (url) => {
      fetched.push(url);
      // Generated line 3, column 4 (0-based) is original line 11, column 3 of the file next to the module.
      if (url.includes('/src/player.ts')) return withMap(['player.ts'], ';;IAUE');
      if (url.includes('/@fs/work/engine/packages/hull/src/core/world.ts')) return withMap(['world.ts'], ';;IAUE');
      return undefined;
    },
  });
  const raw = [
    '    at Player.fixedUpdate (http://localhost:9999/src/player.ts?t=17:3:5)',
    '    at World.step (http://localhost:9999/@fs/work/engine/packages/hull/src/core/world.ts:3:5)',
    '    at stepSafely (http://localhost:9999/@fs/work/engine/packages/hull/src/dev/runtime.ts:176:16)',
    '    at somewhere (http://localhost:9999/node_modules/.vite/deps/three.js?v=1:9:9)',
  ].join('\n');

  it('names the original TypeScript, project-relative for the project and engine-relative for the engine, and cuts at the dev runtime', async () => {
    const m = await mapper.map(raw);
    expect(m.frames.map((f) => f.text)).toEqual([
      'Player.fixedUpdate (src/player.ts:11:3)',
      'World.step (packages/hull/src/core/world.ts:11:3)',
    ]);
    expect(m.place).toMatchObject({ file: 'src/player.ts', line: 11, col: 3, project: true });
    // The server asks its own Vite server, whatever host the page used, and keeps the ?t= so a hot update is a new key.
    expect(fetched[0]).toBe('http://127.0.0.1:5000/src/player.ts?t=17');
  });

  it('falls back to the URL path when there is no map, and picks the first frame as the place when none is the project\'s', async () => {
    const m = await mapper.map('    at f (http://localhost:9999/src/other.ts:7:8)\n    at g (http://localhost:9999/node_modules/x/index.js:1:2)\n    at <anonymous>');
    expect(m.frames[0]).toMatchObject({ file: 'src/other.ts', line: 7, col: 8, project: true });
    const only = await mapper.map('    at g (http://localhost:9999/node_modules/x/index.js:1:2)');
    expect(only.place).toMatchObject({ file: 'node_modules/x/index.js' });
    expect((await mapper.map(undefined)).frames).toEqual([]);
  });
});
