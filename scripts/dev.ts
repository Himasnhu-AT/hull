// pnpm dev: the Hull backend, then the Hull app pointed at it.
// Reads the root .env (copy .env.example), starts the backend (go run, in backend/), waits until /healthz answers, then
// starts the app with HULL_BACKEND_URL set (`--no-app`: the backend alone). The app gets none of the backend's secrets: it signs in to the backend like any
// other app. Ctrl+C, or either side ending, stops both. Dev only; never part of a ship build.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** KEY=value lines; # comments, optional quotes. Values are never printed. */
function readEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const k = line.slice(0, i).trim().replace(/^export\s+/, '');
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

const fileEnv = readEnv(join(root, '.env'));
/** The backend's own settings: never handed to the app, whether they come from .env or the shell. */
const SERVER_ONLY = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'ADDR', 'PUBLIC_URL', 'DATA_DIR', 'ALLOW_SIGNUP', 'DEFAULT_MODEL'];
if (!existsSync(join(root, '.env'))) console.log('[dev] no .env at the repo root: copy .env.example to .env and fill in ANTHROPIC_API_KEY. Starting with defaults.');
// The shell's own values win over the file, so a one-off override needs no edit.
const backendEnv: NodeJS.ProcessEnv = { ...fileEnv, ...process.env };
const addr = backendEnv['ADDR'] || '127.0.0.1:8787';
const url = (backendEnv['PUBLIC_URL'] || `http://${addr}`).replace(/\/+$/, '');

const kids: ChildProcess[] = [];
let stopping = false;
const stop = (code = 0): void => {
  if (stopping) return;
  stopping = true;
  // Each child leads its own process group: `go run` and `pnpm` start further programs that a signal to the parent alone would leave running.
  for (const k of kids) if (k.exitCode === null && k.pid) { try { process.kill(-k.pid, 'SIGTERM'); } catch { k.kill('SIGTERM'); } }
  setTimeout(() => process.exit(code), 1500).unref();
};
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

/** Runs a command with its lines prefixed, so the two logs can be told apart. */
function run(name: string, cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  const c = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const pipe = (s: NodeJS.ReadableStream, to: NodeJS.WriteStream): void => {
    let rest = '';
    s.on('data', (d: Buffer) => { const lines = (rest + d.toString('utf8')).split('\n'); rest = lines.pop() ?? ''; for (const l of lines) to.write(`[${name}] ${l}\n`); });
    s.on('end', () => { if (rest) to.write(`[${name}] ${rest}\n`); });
  };
  pipe(c.stdout!, process.stdout); pipe(c.stderr!, process.stderr);
  c.on('exit', (code, sig) => { if (!stopping) { console.log(`[dev] ${name} stopped (${sig ?? code}); stopping the rest.`); stop(code ?? 1); } });
  c.on('error', (e) => { console.log(`[dev] could not start ${name}: ${e.message}`); stop(1); });
  kids.push(c);
  return c;
}

async function healthy(timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && !stopping) {
    try { if ((await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

if (await healthy(500)) {
  console.log(`[dev] a backend is already answering at ${url}; using it.`);
} else {
  console.log(`[dev] starting the backend at ${url}`);
  run('backend', 'go', ['run', './cmd/hull-backend'], join(root, 'backend'), backendEnv);
  // The first go run compiles, which can take a while; later ones are quick.
  if (!(await healthy(180_000))) { console.log('[dev] the backend did not answer /healthz in time.'); stop(1); }
}

if (!stopping && process.argv.includes('--no-app')) {
  console.log(`[dev] backend is live at ${url} (--no-app: not starting the app). Ctrl+C stops it.`);
} else if (!stopping) {
  console.log('[dev] backend is live; starting the app');
  // Only what the app needs: the shell's environment and where the backend is. Everything the backend's settings name is
  // taken out, even when the shell exported it, so the app signs in like any other app and never holds the server's key.
  const appEnv: NodeJS.ProcessEnv = { ...process.env, HULL_BACKEND_URL: url };
  for (const k of [...Object.keys(fileEnv), ...SERVER_ONLY]) delete appEnv[k];
  appEnv['HULL_BACKEND_URL'] = url;
  run('app', 'pnpm', ['--filter', '@hull/studio', 'app'], root, appEnv);
}
