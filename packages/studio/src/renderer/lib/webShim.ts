// Stands in for window.hullApp when the renderer runs in a normal browser (web dev mode, src/web/dev.ts).
// Each call goes to the dev server, which runs the same host code Electron's main process runs.

import type { HullApp } from '../../shared/appApi.ts';

async function call<T>(name: string, arg?: unknown): Promise<T> {
  const r = await fetch(`/__hull/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(arg ?? null) });
  const body = (await r.json()) as { result?: T; error?: string };
  if (!r.ok || body.error) throw new Error(body.error ?? `${name} failed`);
  return body.result as T;
}

export function webShim(): HullApp {
  return {
    platform: 'web',
    listTemplates: () => call('listTemplates'),
    // A browser cannot show a folder dialog that returns a path, so the dev server answers: a scratch folder to create in,
    // and for "open" a typed path.
    pickFolder: async (purpose) => (purpose === 'location' ? call<string>('scratchDir') : (window.prompt('Path of the project folder') || null)),
    createProject: (o) => call('createProject', o),
    openProject: (root) => call('openProject', root),
    closeProject: () => call('closeProject'),
    recents: () => call('recents'),
    forgetRecent: (root) => call('forgetRecent', root),
    reveal: (path) => call('reveal', path),
    initialProject: () => call('initialProject'),
  };
}
