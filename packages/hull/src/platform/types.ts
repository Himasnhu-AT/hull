// What the desktop shell gives the page, and the storage both sides sit on. Pure types: no DOM here.

/** The two places Hull keeps player data. Saves are one file per slot; settings are one file. */
export type Area = 'saves' | 'settings';

/** Names of slots and files. Checked on both sides of the bridge so a name can never reach outside its folder. */
export const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** A synchronous key-value store of text. Sync on purpose: the shell's preload answers with `sendSync`. */
export interface Store {
  read(area: Area, name: string): string | null;
  /** Returns false when the write could not be kept (quota, disk full). */
  write(area: Area, name: string, text: string): boolean;
  remove(area: Area, name: string): void;
  list(area: Area): string[];
}

/** `window.hullShell`, exposed by shell/electron/preload.cjs. Nothing else of Node or Electron reaches the page. */
export interface HullShell extends Store {
  readonly platform: string;
  getFullscreen(): boolean;
  setFullscreen(on: boolean): void;
  quit(): void;
}

export type Report = (message: string) => void;
