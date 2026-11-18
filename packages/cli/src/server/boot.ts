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

export function bootSource(o: BootOptions): string {
  const features = o.features ?? [];
  const maps = idsOf(o.sources, 'input-map');
  const themes = idsOf(o.sources, 'ui-theme');
  const wantAudio = hasModule('audio') && (features.includes('audio') || idsOf(o.sources, 'sound').length > 0);
  const wantUi = hasModule('ui') && (features.includes('ui') || themes.length > 0 || idsOf(o.sources, 'ui-screen').length > 0);
  const looks = idsOf(o.sources, 'look');
  const look = looks.includes('look/day') ? 'look/day' : looks[0];
  const wantInput = hasModule('input');

  const imports = [
    `import { startGame, config } from 'hull';`,
    `import { mountRender } from 'hull/render';`,
    ...(wantInput ? [`import { mountInput } from 'hull/input';`] : []),
    ...(wantAudio ? [`import { mountAudio } from 'hull/audio';`] : []),
    ...(wantUi ? [`import { mountUi } from 'hull/ui';`] : []),
    ...(o.devUrl ? [`import { connectDev } from 'hull/dev';`] : []),
    `import game from ${JSON.stringify(`/${o.entry.replace(/^\.?\//, '')}`)};`,
  ];
  // A subsystem that fails to start is reported once and skipped; the game keeps running (CLAUDE.md).
  const skip = (name: string, call: string): string =>
    `try { views.${name} = ${call}; parts.push(views.${name}); } catch (e) { console.error('${name} failed to start and was skipped: ' + (e && e.message || e)); }`;
  const body = [
    `const loaded = config.load(sources);`,
    `for (const p of loaded.problems) console.error(p.file + (p.pointer ?? '') + ': ' + p.message);`,
    `const g = await startGame(game);`,
    `const parts = [];`,
    `const views = { game: g };`,
    `globalThis.hull = views;`,
    `const view = views.render = mountRender(g, el${look ? `, { look: ${JSON.stringify(look)} }` : ''});`,
    ...(wantInput ? [skip('input', `mountInput(g, window${maps[0] ? `, ${JSON.stringify(maps[0])}` : ''})`)] : []),
    ...(wantAudio ? [skip('audio', 'mountAudio(g)')] : []),
    ...(wantUi ? [skip('ui', `mountUi(g, el${themes[0] ? `, ${JSON.stringify(themes[0])}` : ''})`)] : []),
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
