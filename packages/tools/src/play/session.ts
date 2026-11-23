// Headless browser sessions a tool opens (agent-browser): closing them when the process that opened them goes away, however
// it goes, and reaping the ones a dead process left behind. A session outlives its opener otherwise, and keeps a page
// rendering (and the GPU busy) for nobody.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Session names carry the pid of the process that opened them: hull-link-<pid> (game.run) and hull-play<pid>x<n> (play). */
const OURS = /^hull-(?:link-|play)(\d+)(?:x\d+)?$/;

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** Closes every hull session whose opener is gone. Never throws: a missing browser tool just means nothing to reap. */
export async function reapDeadSessions(browser: string): Promise<string[]> {
  const reaped: string[] = [];
  try {
    const { stdout } = await exec(browser, ['session', 'list'], { timeout: 15_000 });
    for (const name of new Set(stdout.split(/\s+/))) {
      const m = OURS.exec(name);
      if (!m || alive(Number(m[1]))) continue;
      await exec(browser, ['--session', name, 'close'], { timeout: 20_000 }).catch(() => {});
      reaped.push(name);
    }
  } catch { /* nothing to reap */ }
  return reaped;
}

export interface SessionGuard {
  /** Closes the session now (once) and stops guarding. */
  close(): void;
}

/**
 * Guards one session: when this process exits for any reason (normal exit, SIGINT, SIGTERM, a closed stdin that ends the
 * process), the session is closed with a synchronous call, because nothing async runs once the process is going.
 */
export function closeOnExit(browser: string, session: string): SessionGuard {
  let done = false;
  const closeNow = (): void => {
    if (done) return;
    done = true;
    off();
    try { execFileSync(browser, ['--session', session, 'close'], { timeout: 15_000, stdio: 'ignore' }); } catch { /* already gone */ }
  };
  const onExit = (): void => closeNow();
  // A signal handler replaces the default of dying, so it closes and then dies the way the default would have.
  const onTerm = (): void => { closeNow(); process.exit(143); };
  const onInt = (): void => { closeNow(); process.exit(130); };
  const off = (): void => {
    process.off('exit', onExit);
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
    process.off('SIGHUP', onTerm);
  };
  process.on('exit', onExit);
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  process.on('SIGHUP', onTerm);
  return { close: closeNow };
}
