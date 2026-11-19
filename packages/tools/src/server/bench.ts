// The sound bench's engine, bundled for the Studio. A sound with a `code` source names a generator the game registers
// in its own code, so the Studio's own copy of hull/audio cannot render it. The manifest's `generators` module
// registers them; this bundles that module together with hull/audio into one self-contained ES module (its own copy
// of the engine, its own registry, no imports), which the Studio loads and renders with.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build as viteBuild } from 'vite';
import { engineAliases, hullResolve } from './vitePlugins.ts';

/** The bundle's source: the engine's audio module and registry, then the project's registration. */
export function benchEntry(generators: string): string {
  return [
    `export * from 'hull/audio';`,
    `export { config } from 'hull';`,
    `import * as project from ${JSON.stringify(generators)};`,
    `if (typeof project.default === 'function') project.default();`,
  ].join('\n');
}

/** The JavaScript of the bench bundle for a project whose manifest names `generators` (a path under the root). Throws with the build's message when the module does not bundle. */
export async function buildBenchAudio(root: string, generators: string): Promise<string> {
  // The entry is a real file (library mode wants one), kept under .hull/ with the rest of what Hull keeps for itself.
  const entry = join(root, '.hull', 'cache', 'bench-audio-entry.ts');
  mkdirSync(join(root, '.hull', 'cache'), { recursive: true });
  writeFileSync(entry, benchEntry(join(root, generators)));
  const out = await viteBuild({
    root,
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    cacheDir: join(root, '.hull', 'cache', 'vite'),
    plugins: [hullResolve()],
    resolve: { alias: engineAliases() },
    build: {
      write: false,
      target: 'es2023',
      minify: false,
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      cssCodeSplit: false,
      chunkSizeWarningLimit: Number.MAX_SAFE_INTEGER,
      // Library mode, so the entry's exports (renderSound and the rest) stay in the bundle; an app build drops them.
      lib: { entry, formats: ['es'], fileName: 'bench' },
      rollupOptions: { output: { codeSplitting: false } },
    },
  });
  const outputs = (Array.isArray(out) ? out : [out]).flatMap((o) => ('output' in o ? o.output : []));
  const chunk = outputs.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('the bench bundle produced no code');
  return chunk.code;
}
