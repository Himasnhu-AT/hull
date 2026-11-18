// What the app's main process offers the renderer. The renderer has no Node access: this is the whole surface.
// In Electron it arrives as `window.hullApp` through the preload script; in the web dev mode a shim fills it in
// with fetch calls to the same functions (src/web/shim.ts).

export interface TemplateInfo { name: string; title: string; description: string }

export interface RecentProject { root: string; title: string; openedAt: string }

/** A project the main process has started a server for. The renderer talks only to `url` (protocol) and shows `gameUrl`. */
export interface OpenedProject { root: string; title: string; url: string; gameUrl: string }

export interface HullApp {
  /** 'darwin' | 'win32' | 'linux' | 'web'. The title bar leaves room for traffic lights on darwin only. */
  readonly platform: string;
  listTemplates(): Promise<TemplateInfo[]>;
  /** Asks where to put a new project, or which existing one to open. Null when cancelled. */
  pickFolder(purpose: 'open' | 'location'): Promise<string | null>;
  createProject(opts: { template: string; title: string; parentDir: string }): Promise<OpenedProject>;
  openProject(root: string): Promise<OpenedProject>;
  closeProject(): Promise<void>;
  recents(): Promise<RecentProject[]>;
  forgetRecent(root: string): Promise<void>;
  /** Shows a file or folder in Finder / Explorer. */
  reveal(path: string): Promise<void>;
  /** Web dev mode: the project to open without asking (`--project <dir>`). */
  initialProject(): Promise<OpenedProject | null>;
}

declare global {
  interface Window { hullApp?: HullApp }
}
