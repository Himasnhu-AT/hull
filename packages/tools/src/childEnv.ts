// The environment for a child that runs this same program as Node: `spawn(process.execPath, [script])`.
// Inside the desktop app process.execPath is Electron, which runs as plain Node only with ELECTRON_RUN_AS_NODE=1; without
// it a second app starts. And the dev launcher puts "--import tsx" in NODE_OPTIONS, which a child resolves from its own
// working folder (a game's folder, where tsx is not installed) and dies on before it runs a line. The scripts Hull starts
// this way (tsc, hull-agent, hull-mcp) need neither: the bins register tsx themselves.

export function nodeChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' };
  const opts = (env['NODE_OPTIONS'] ?? '').replace(/--import(?:=|\s+)tsx(?=\s|$)/g, '').replace(/\s+/g, ' ').trim();
  if (opts) out['NODE_OPTIONS'] = opts; else delete out['NODE_OPTIONS'];
  return out;
}
