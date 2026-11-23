// Who may talk to the main process. The window shows only the app's own page; the game runs in an iframe of
// http://127.0.0.1:<port> and must never reach these handlers (they open folders, start terminals, change settings).
// Pure functions, so they are tested without Electron.
import { pathToFileURL } from 'node:url';

export interface AppPages {
  /** HULL_APP_URL in development: the Vite server the renderer comes from. */
  appUrl?: string;
  /** out/renderer in a built app. */
  rendererDir: string;
}

/** True when `url` is a page of the app itself: same origin as the dev server, or a file inside the renderer folder. */
export function isAppPage(url: string, pages: AppPages): boolean {
  try {
    const u = new URL(url);
    if (pages.appUrl) return u.origin === new URL(pages.appUrl).origin;
    if (u.protocol !== 'file:') return false;
    const base = pathToFileURL(pages.rendererDir.replace(/\/?$/, '/')).href;
    return u.href.startsWith(base);
  } catch { return false; }
}

/** Links that leave the app go to the person's browser, and only as web pages: no file:, no custom schemes. */
export const isWebLink = (url: string): boolean => { try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; } };

/**
 * A request to web mode's /__hull API. A page on another site can send a "simple" POST to 127.0.0.1, and a rebinding
 * attack can make its own host name resolve there, so both the Origin (when sent) and the Host must be this server's.
 */
export function isOwnWebRequest(h: { origin?: string; host?: string }, port: number): boolean {
  const hostOk = h.host === `127.0.0.1:${port}` || h.host === `localhost:${port}`;
  if (!hostOk) return false;
  if (h.origin === undefined) return true;
  return h.origin === `http://127.0.0.1:${port}` || h.origin === `http://localhost:${port}`;
}
