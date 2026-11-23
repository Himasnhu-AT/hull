// The page that starts a game: one source of text for the dev page and for the build, so what runs in the app is what
// ships, minus the dev connection. Engine modules are imported only when they exist and the game uses them.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigSource } from 'hull';
import { hullSrc } from './templates.ts';

export interface BootOptions {
  /** Manifest entry, like 'src/main.ts'. */
  entry: string;
  /** Validated config files (and hull.json) to hand to config.load. */
  sources: ConfigSource[];
  /** The project server's ws:// URL. Present in dev, absent in a build. */
  devUrl?: string;
  features?: readonly string[];
  /** Build: wrap the start in an exported `start(element)` and run it when the page has #app. */
  build?: boolean;
}

const hasModule = (name: string): boolean => existsSync(join(hullSrc, name, 'index.ts'));
const idsOf = (sources: ConfigSource[], kind: string): string[] =>
  sources.filter((s) => s.path.startsWith(`config/${kind}/`) && s.path.endsWith('.json')).map((s) => s.path.slice('config/'.length, -'.json'.length)).sort();

/** The renderer the manifest pins (`render.backend`), or undefined for the default ('auto'). */
function pinnedBackend(sources: ConfigSource[]): string | undefined {
  const text = sources.find((s) => s.path === 'hull.json')?.text;
  if (!text) return undefined;
  try {
    const b = (JSON.parse(text) as { render?: { backend?: string } }).render?.backend;
    return b === 'webgl2' || b === 'webgpu' ? b : undefined;
  } catch {
    return undefined;
  }
}

/** True only when the manifest says "kernels": false; absent or anything else keeps the engine's default (on). */
function kernelsOff(sources: ConfigSource[]): boolean {
  const text = sources.find((s) => s.path === 'hull.json')?.text;
  if (!text) return false;
  try {
    return (JSON.parse(text) as { kernels?: unknown }).kernels === false;
  } catch {
    return false;
  }
}

export function bootSource(o: BootOptions): string {
  const features = o.features ?? [];
  const backend = pinnedBackend(o.sources);
  const maps = idsOf(o.sources, 'input-map');
  const themes = idsOf(o.sources, 'ui-theme');
  const wantAudio = hasModule('audio') && (features.includes('audio') || idsOf(o.sources, 'sound').length > 0);
  const wantUi = hasModule('ui') && (features.includes('ui') || themes.length > 0 || idsOf(o.sources, 'ui-screen').length > 0);
  // Listed in hull.json, or the project has vfx config: either way the game expects `vfx.burst` to draw.
  const wantVfx = hasModule('vfx') && (features.includes('vfx') || idsOf(o.sources, 'vfx').length > 0);
  const looks = idsOf(o.sources, 'look');
  const look = looks.includes('look/day') ? 'look/day' : looks[0];
  const wantInput = hasModule('input');

  const imports = [
    `import { startGame, config } from 'hull';`,
    `import { mountRender } from 'hull/render';`,
    ...(wantInput ? [`import { mountInput } from 'hull/input';`] : []),
    ...(wantAudio ? [`import { mountAudio } from 'hull/audio';`] : []),
    ...(wantUi ? [`import { mountUi } from 'hull/ui';`] : []),
    ...(wantVfx ? [`import { mountVfx } from 'hull/vfx';`] : []),
    ...(o.devUrl ? [`import { connectDev } from 'hull/dev';`] : []),
    `import game from ${JSON.stringify(`/${o.entry.replace(/^\.?\//, '')}`)};`,
  ];
  // A subsystem that fails to start is reported once and skipped; the game keeps running (CLAUDE.md).
  const skip = (name: string, call: string): string =>
    `try { views.${name} = ${call}; parts.push(views.${name}); } catch (e) { console.error('${name} failed to start and was skipped: ' + (e && e.message || e)); }`;
  const body = [
    `const loaded = config.load(sources);`,
    `for (const p of loaded.problems) console.error(p.file + (p.pointer ?? '') + ': ' + p.message);`,
    // The option goes through startGame only: importing hull/kernel here would put the WebAssembly in every game.
    // The dev page's ?kernels= flag wins over hull.json, so one page can be compared against the other; it never ships.
    // The flag is the page's, not the dev connection's: a dev page served without a connection honours it too.
    o.build
      ? kernelsOff(o.sources) ? `const g = await startGame(game, { kernels: 'off' });` : `const g = await startGame(game);`
      : `const kq = new URLSearchParams(location.search).get('kernels'); const g = await startGame(game, { kernels: kq === 'off' || kq === 'fail' ? kq : ${kernelsOff(o.sources) ? "'off'" : "'on'"} });`,
    `const parts = [];`,
    `const views = { game: g };`,
    `globalThis.hull = views;`,
    `const view = views.render = mountRender(g, el${look || backend ? `, { ${[look ? `look: ${JSON.stringify(look)}` : '', backend ? `backend: ${JSON.stringify(backend)}` : ''].filter(Boolean).join(', ')} }` : ''});`,
    ...(wantInput ? [skip('input', `mountInput(g, window${maps[0] ? `, ${JSON.stringify(maps[0])}` : ''})`)] : []),
    ...(wantAudio ? [skip('audio', 'mountAudio(g)')] : []),
    ...(wantUi ? [skip('ui', `mountUi(g, el${themes[0] ? `, ${JSON.stringify(themes[0])}` : ''})`)] : []),
    // mountVfx gives back the game's own view when it already mounted one, so the dispose below runs once either way.
    ...(wantVfx ? [skip('vfx', 'mountVfx(g)')] : []),
    ...(o.devUrl ? [`parts.push(connectDev(g, { url: ${JSON.stringify(o.devUrl)} }));`] : []),
    `const stop = () => { for (const p of parts) p.dispose?.(); view.dispose(); g.dispose(); };`,
  ];

  if (o.build) {
    return [
      ...imports,
      `const sources = ${JSON.stringify(o.sources)};`,
      `export async function start(el) {`,
      ...body.map((l) => `  ${l}`),
      `  views.stop = stop;
  return views;`,
      `}`,
      `const app = typeof document !== 'undefined' ? document.getElementById('app') : null;`,
      `if (app) { await start(app); }`,
    ].join('\n');
  }
  return [
    ...imports,
    `const sources = ${JSON.stringify(o.sources)};`,
    `const el = document.getElementById('app');`,
    ...body,
    `import.meta.hot?.dispose(stop);`,
  ].join('\n');
}

export const BOOT_ID = 'virtual:hull-boot';

/** The dev page. There is no index.html on disk: the manifest says where the game starts. */
export const DEV_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hull dev</title>
<style>html,body,#app{margin:0;height:100%;background:#111;overflow:hidden}</style></head>
<body><div id="app"></div><script type="module" src="/@id/${BOOT_ID}"></script></body></html>`;
