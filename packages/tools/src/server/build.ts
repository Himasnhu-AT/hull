// `build`: the project becomes dist/web/game.js (one ES module, config and assets inside, no dev code) and a
// generated index.html that starts it. The build reads no files at run time.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { ConfigSource, Problem } from 'hull';
import { build as viteBuild } from 'vite';
import { loadManifest, readConfigFiles, readManifest } from '../tools/config.ts';
import { bootSource } from './boot.ts';
import { hullResolve, skipValidator, tunablesToConstants, virtualModule } from './vitePlugins.ts';

const ENTRY = 'virtual:hull-build-entry';

export interface BuildResult {
  ok: boolean;
  problems: Problem[];
  /** Absolute path of dist/web. */
  outDir?: string;
  files?: { path: string; bytes: number; gzip: number }[];
  /** True when nothing from hull/dev reached game.js. */
  devFree?: boolean;
  /** Present when game.js carries the engine's WebAssembly module; absent when no module the game imports has one. */
  kernel?: { bytes: number };
}

/** `note` is for people reading the file; the shipped game has no use for it. */
function strip(src: ConfigSource): ConfigSource {
  try {
    const v = JSON.parse(src.text) as Record<string, unknown>;
    delete v['note'];
    return { path: src.path, text: JSON.stringify(v) };
  } catch {
    return src;
  }
}

const page = (title: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title.replace(/[<&>]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' })[c]!)}</title>
<style>html,body,#app{margin:0;height:100%;background:#111;overflow:hidden}</style></head>
<body><div id="app"></div><script type="module" src="game.js"></script></body></html>
`;

/** Bundles a project that has already passed `check`. Returns problems instead of throwing for bad input. */
export async function buildProject(root: string, log: (line: string) => void = () => {}): Promise<BuildResult> {
  root = resolve(root);
  const manifest = await loadManifest(root);
  if (!manifest.value) return { ok: false, problems: manifest.problems };
  const { createRegistry } = await import('hull');
  const files = readConfigFiles(root);
  const hullJson = readManifest(root)!;
  const checked = createRegistry().load([hullJson, ...files]);
  if (checked.problems.length) return { ok: false, problems: checked.problems };

  const sources = [hullJson, ...files].map(strip);
  const outDir = join(root, 'dist', 'web');
  log(`bundling ${manifest.value.entry}`);
  await viteBuild({
    root,
    configFile: false,
    logLevel: 'warn',
    appType: 'custom',
    cacheDir: join(root, '.hull', 'cache', 'vite'),
    plugins: [
      hullResolve(),
      virtualModule(ENTRY, () => bootSource({ entry: manifest.value!.entry, sources, features: (JSON.parse(hullJson.text) as { features?: string[] }).features, build: true })),
      skipValidator(),
      tunablesToConstants(),
    ],
    build: {
      outDir,
      emptyOutDir: true,
      target: 'es2023',
      minify: true,
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      cssCodeSplit: false,
      reportCompressedSize: false,
      // The size goes to build.json and the budget check, not to a console warning.
      chunkSizeWarningLimit: Number.MAX_SAFE_INTEGER,
      rollupOptions: { input: ENTRY, output: { format: 'es', entryFileNames: 'game.js', codeSplitting: false } },
    },
  });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.html'), page(manifest.value.title ?? 'Hull game'));
  const js = readFileSync(join(outDir, 'game.js'));
  const text = js.toString('utf8');
  // Dev code is recognisable by what it logs and by its module path; neither may appear in a ship build.
  const devFree = !/\[dev\]|dev\/runtime|connectDev|role=game|hull-client|hull-headless/.test(text);
  // Only a game that imports a module with a kernel (hull/physics) carries the module; its base64 starts with a fixed marker.
  const { KERNEL_MARKER, KERNEL_BYTES } = await import('hull/kernel');
  const kernel = text.includes(KERNEL_MARKER) ? { bytes: KERNEL_BYTES } : undefined;
  const report = [{ path: 'game.js', bytes: js.length, gzip: gzipSync(js).length }, { path: 'index.html', bytes: statSync(join(outDir, 'index.html')).size, gzip: 0 }];
  writeFileSync(join(outDir, 'build.json'), `${JSON.stringify({ files: report, devFree, ...(kernel ? { kernel } : {}) }, null, 2)}\n`);
  log(`dist/web/game.js ${(js.length / 1024).toFixed(0)} kB (${(report[0]!.gzip / 1024).toFixed(0)} kB gzip)`);
  log(kernel ? `kernel: ${(kernel.bytes / 1024).toFixed(1)} kB of WebAssembly inside game.js` : 'kernel: none (the game imports no module that has one)');
  if (!devFree) return { ok: false, outDir, files: report, devFree, kernel, problems: [{ file: 'dist/web/game.js', rule: 'house-rule', message: 'dev code reached the build' }] };
  return { ok: true, problems: [], outDir, files: report, devFree, kernel };
}
