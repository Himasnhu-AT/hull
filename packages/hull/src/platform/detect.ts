import type { HullShell } from './types.ts';

export type PlatformKind = 'browser' | 'desktop';

/** The shell bridge when the page runs inside a Hull desktop shell, otherwise undefined. */
export function shellBridge(win: { hullShell?: HullShell } | undefined = globalThis as { hullShell?: HullShell }): HullShell | undefined {
  const s = win?.hullShell;
  return s && typeof s.read === 'function' ? s : undefined;
}

export function detectKind(win?: { hullShell?: HullShell }): PlatformKind {
  return shellBridge(win) ? 'desktop' : 'browser';
}
