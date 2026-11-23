// Electron main process: one window, the launcher and the project server per open project. The page is the Vite
// dev server in development (HULL_APP_URL) and the built files in out/renderer otherwise.

import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, shell } from 'electron';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSettingsInput, CliAction, CliId, PromptOptions, TermProgram } from '../shared/agentApi.ts';
import { createHost } from './host.ts';
import { isAppPage, isWebLink, type AppPages } from './ipcGuard.ts';

// Dev only: lets a test driver (agent-browser) attach to the window.
if (process.env['HULL_CDP_PORT'] && !app.isPackaged) app.commandLine.appendSwitch('remote-debugging-port', process.env['HULL_CDP_PORT']);

// Lets tests keep recents (and the rest of userData) somewhere disposable.
if (process.env['HULL_USER_DATA']) app.setPath('userData', process.env['HULL_USER_DATA']);

const here = dirname(fileURLToPath(import.meta.url));
// The builder's API key is kept encrypted with the OS keychain (safeStorage), as base64 text in userData.
const host = createHost({
  dataDir: app.getPath('userData'), log: (l) => console.log(`[hull] ${l}`), trash: (p) => shell.trashItem(p), openUrl: (u) => shell.openExternal(u),
  crypto: {
    available: () => safeStorage.isAsyncEncryptionAvailable(),
    encrypt: async (s) => (await safeStorage.encryptStringAsync(s)).toString('base64'),
    decrypt: async (b) => (await safeStorage.decryptStringAsync(Buffer.from(b, 'base64'))).result,
  },
});
let win: BrowserWindow | null = null;
const pages = (): AppPages => ({ ...(process.env['HULL_APP_URL'] ? { appUrl: process.env['HULL_APP_URL'] } : {}), rendererDir: join(here, '../../out/renderer') });
// Folders the person chose in the system dialog this session: the only paths, besides Recent, openProject will start a server for.
const picked = new Set<string>();

// A bad id from the page must not crash the process; the renderer shows the message.
const handle = (channel: string, fn: (...a: never[]) => unknown): void => {
  ipcMain.handle(`hull:${channel}`, async (e, ...args) => {
    // Only the app's own top-level page may call in: not the game's iframe, not a page that navigated the window away.
    if (!win || e.senderFrame !== win.webContents.mainFrame || !isAppPage(e.senderFrame.url, pages())) throw new Error(`${channel}: refused, the caller is not the Hull app page`);
    try { return await (fn as (...a: unknown[]) => unknown)(...args); }
    catch (e) { throw new Error(e instanceof Error ? e.message : String(e)); }
  });
};

function registerIpc(): void {
  handle('listTemplates', () => host.listTemplates());
  handle('listCommunity', () => host.listCommunity());
  handle('openCommunity', (id: string, reset?: boolean, update?: boolean) => host.openCommunity(id, reset, update));
  handle('createProject', (opts: { template: string; title: string; parentDir: string }) => host.createProject(opts));
  handle('createFromIdea', (opts: { idea: string }) => host.createFromIdea(opts.idea));
  // The page names a path, so it may only name one the person has opened before or just picked in the folder dialog.
  handle('openProject', async (root: string) => {
    if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('openProject: a project folder is an absolute path');
    const path = resolve(root);
    if (!picked.has(path) && !(await host.recents()).some((r) => resolve(r.root) === path)) throw new Error(`openProject: ${path} is not in Recent and was not chosen in the folder dialog`);
    return host.openProject(path);
  });
  handle('closeProject', () => host.closeProject());
  handle('recents', () => host.recents());
  handle('forgetRecent', (root: string) => host.forgetRecent(root));
  handle('renameProject', (root: string, title: string) => host.renameProject(root, title));
  handle('trashProject', (root: string) => host.trashProject(root));
  handle('saveThumb', (root: string, jpeg: string) => host.saveThumb(root, jpeg));
  handle('openClaude', (prompt?: string) => host.openClaude(prompt));
  handle('agentList', () => host.agents.list());
  handle('agentStart', (id: string) => host.agents.start(id));
  handle('agentPrompt', (sid: string, text: string, options?: PromptOptions) => host.agents.prompt(sid, text, options));
  handle('agentEnsure', () => host.agents.ensure());
  handle('agentSettings', () => host.agentSettings());
  handle('setAgentSettings', (s: AgentSettingsInput) => host.setAgentSettings(s));
  handle('accountSignIn', () => host.accountSignIn());
  handle('accountCancel', () => host.accountCancel());
  handle('accountSignOut', () => host.accountSignOut());
  handle('agentCancel', (sid: string) => host.agents.cancel(sid));
  handle('agentStop', (sid: string) => host.agents.stop(sid));
  handle('agentAnswer', (sid: string, reqId: string, optionId: string | null) => host.agents.answer(sid, reqId, optionId));
  handle('claudeInfo', () => host.terminals.claudeInfo());
  handle('cliStatus', () => host.accounts.status());
  handle('cliRun', (id: CliId, action: CliAction) => host.accounts.run(id, action));
  handle('termOpen', (cols: number, rows: number, program?: TermProgram, prompt?: string) => host.terminals.open(cols, rows, program, prompt));
  handle('termWrite', (tid: string, data: string) => host.terminals.write(tid, data));
  handle('termResize', (tid: string, cols: number, rows: number) => host.terminals.resize(tid, cols, rows));
  handle('termKill', (tid: string) => host.terminals.kill(tid));
  host.onAgentEvent((e) => { if (win && !win.isDestroyed()) win.webContents.send('hull:agent-event', e); });
  handle('reveal', (path: string) => { shell.showItemInFolder(path); });
  handle('pickFolder', async (purpose: 'open' | 'location') => {
    const r = await dialog.showOpenDialog(win ?? undefined as never, {
      title: purpose === 'open' ? 'Open a Hull project' : 'Where should the project go?',
      properties: purpose === 'open' ? ['openDirectory'] : ['openDirectory', 'createDirectory'],
      buttonLabel: purpose === 'open' ? 'Open' : 'Choose',
    });
    const chosen = r.canceled ? null : (r.filePaths[0] ?? null);
    if (chosen) picked.add(resolve(chosen));
    return chosen;
  });
}

async function createWindow(): Promise<void> {
  nativeTheme.themeSource = 'light';
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 620,
    title: 'Hull',
    // The title bar is ours: on macOS the traffic lights sit inside it, like Xcode.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 14 },
    backgroundColor: '#f3f2ee',
    show: false,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The game runs in an iframe of http://127.0.0.1:<port>; nothing else is ever loaded.
      webSecurity: true,
    },
  });
  win.once('ready-to-show', () => win?.show());
  // Links that leave the app open in the browser, never in a window with our preload.
  win.webContents.setWindowOpenHandler(({ url }) => { if (isWebLink(url)) void shell.openExternal(url); return { action: 'deny' }; });
  // The window never leaves the app's page: a link or a script that tries goes to the browser instead (web links only).
  const stay = (e: { preventDefault(): void }, url: string): void => { if (isAppPage(url, pages())) return; e.preventDefault(); if (isWebLink(url)) void shell.openExternal(url); };
  win.webContents.on('will-navigate', (e, url) => stay(e, url));
  win.webContents.on('will-redirect', (e, url) => stay(e, url));
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  win.on('closed', () => { win = null; void host.closeProject(); });

  const dev = process.env['HULL_APP_URL'];
  if (dev) await win.loadURL(dev);
  else await win.loadFile(join(here, '../../out/renderer/index.html'));
}

app.whenReady().then(async () => {
  registerIpc();
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { void host.closeProject(); });
