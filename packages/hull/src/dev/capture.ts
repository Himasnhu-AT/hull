// What the page says about itself: console warnings and errors, uncaught errors, unhandled rejections. They land in one ring
// (errors.ts) that the control port's `errors` op reads. Installed when this module loads, which is before the game's
// `ready` runs (the dev page imports 'hull/dev' ahead of the game), because the warnings that matter most, like a material
// that does not exist, are printed while the game is being built.
//
// Dev only: a build never imports this file. Wall time and the window are fine here; nothing the simulation does reads it.
import { createErrorRing, type ErrorRing } from './errors.ts';

export interface Capture {
  ring: ErrorRing;
  /** The game's tick and time, stamped on each record. Before the game exists: 0, 0. */
  clock: () => [tick: number, time: number];
  /** Called once for each new (not repeated) record, so the connection can tell the studios. */
  onNew: ((level: 'error' | 'warn', message: string) => void) | null;
  record(level: 'error' | 'warn', message: string, stack?: string, announce?: boolean): void;
  /** The console as it was before capture, for our own lines. */
  real: { error: typeof console.error; warn: typeof console.warn; info: typeof console.info };
  uninstall(): void;
}

let current: Capture | null = null;

/** One console argument as the line a person would read. */
export const show = (a: unknown): string => {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  try { return JSON.stringify(a) ?? String(a); } catch { return String(a); }
};

export function ensureCapture(): Capture {
  if (current) return current;
  const ring = createErrorRing();
  const real = { error: console.error, warn: console.warn, info: console.info };
  const cap: Capture = {
    ring,
    clock: () => [0, 0],
    onNew: null,
    real,
    record(level, message, stack, announce = true) {
      const [tick, time] = cap.clock();
      if (ring.add(level, message, stack, tick, time) && announce) cap.onNew?.(level, message);
    },
    uninstall() {
      win?.removeEventListener('error', onWindowError as EventListener);
      win?.removeEventListener('unhandledrejection', onRejection as EventListener);
      if (console.error === patched.error) console.error = real.error;
      if (console.warn === patched.warn) console.warn = real.warn;
      if (current === cap) current = null;
    },
  };
  const wrap = (level: 'error' | 'warn') => function (this: unknown, ...args: unknown[]): void {
    try {
      const withStack = args.find((a): a is Error => a instanceof Error);
      // The caller's frames, without this file's: that is where the warning came from.
      const own = new Error().stack?.split('\n').filter((l) => !l.includes('/dev/capture.ts')).join('\n');
      cap.record(level, args.map(show).join(' '), withStack?.stack ?? own);
    } catch { /* capturing must never break the game's own logging */ }
    real[level].apply(console, args);
  };
  const patched = { error: wrap('error'), warn: wrap('warn') };
  console.error = patched.error;
  console.warn = patched.warn;
  const win = (globalThis as { window?: Window }).window;
  const onWindowError = (e: ErrorEvent): void => {
    // A cross-origin "Script error." carries nothing to act on.
    if (e.error === undefined && e.message === 'Script error.') return;
    const err = e.error as unknown;
    cap.record('error', err instanceof Error ? `${err.name}: ${err.message}` : e.message, err instanceof Error ? err.stack : `at ${e.filename}:${e.lineno}:${e.colno}`);
  };
  const onRejection = (e: PromiseRejectionEvent): void => {
    const r = e.reason as unknown;
    cap.record('error', r instanceof Error ? `${r.name}: ${r.message}` : `Unhandled rejection: ${show(r)}`, r instanceof Error ? r.stack : undefined);
  };
  win?.addEventListener('error', onWindowError as EventListener);
  win?.addEventListener('unhandledrejection', onRejection as EventListener);
  current = cap;
  return cap;
}

// In a page, start capturing as soon as the dev module loads.
if (typeof window !== 'undefined') ensureCapture();
