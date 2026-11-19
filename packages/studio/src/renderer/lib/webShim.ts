// Stands in for window.hullApp when the renderer runs in a normal browser (web dev mode, src/web/dev.ts).
// Each call goes to the dev server, which runs the same host code Electron's main process runs.

import type { HullApp } from '../../shared/appApi.ts';
import type { AgentEvent } from '../../shared/agentApi.ts';

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
    listCommunity: () => call('listCommunity'),
    openCommunity: (id, reset) => call('openCommunity', { id, reset }),
    createProject: (o) => call('createProject', o),
    createFromIdea: (o) => call('createFromIdea', o),
    openProject: (root) => call('openProject', root),
    closeProject: () => call('closeProject'),
    recents: () => call('recents'),
    forgetRecent: (root) => call('forgetRecent', root),
    reveal: (path) => call('reveal', path),
    agentList: () => call('agentList'),
    agentStart: (id) => call('agentStart', { a: [id] }),
    agentPrompt: (sid, text, options) => call('agentPrompt', { a: [sid, text, options] }),
    agentEnsure: () => call('agentEnsure'),
    agentSettings: () => call('agentSettings'),
    setAgentSettings: (s) => call('setAgentSettings', s),
    agentCancel: (sid) => call('agentCancel', { a: [sid] }),
    agentStop: (sid) => call('agentStop', { a: [sid] }),
    agentAnswer: (sid, reqId, optionId) => call('agentAnswer', { a: [sid, reqId, optionId] }),
    claudeInfo: () => call('claudeInfo'),
    cliStatus: () => call('cliStatus'),
    cliRun: (id, action) => call('cliRun', { a: [id, action] }),
    termOpen: (cols, rows, program, prompt) => call('termOpen', { a: [cols, rows, program, prompt] }),
    termWrite: (tid, data) => call('termWrite', { a: [tid, data] }),
    termResize: (tid, cols, rows) => call('termResize', { a: [tid, cols, rows] }),
    termKill: (tid) => call('termKill', { a: [tid] }),
    onAgentEvent: (cb) => {
      const es = new EventSource('/__hull_events');
      es.onmessage = (m) => cb(JSON.parse(m.data as string) as AgentEvent);
      return () => es.close();
    },
    initialProject: () => call('initialProject'),
  };
}
