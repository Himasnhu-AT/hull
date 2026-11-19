// Electron main process: one window, the launcher and the project server per open project. The page is the Vite
// dev server in development (HULL_APP_URL) and the built files in out/renderer otherwise.

import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHost } from './host.ts';

// Dev only: lets a test driver (agent-browser) attach to the window.
if (process.env['HULL_CDP_PORT'] && !app.isPackaged) app.commandLine.appendSwitch('remote-debugging-port', process.env['HULL_CDP_PORT']);

// Lets tests keep recents (and the rest of userData) somewhere disposable.
if (process.env['HULL_USER_DATA']) app.setPath('userData', process.env['HULL_USER_DATA']);

const here = dirname(fileURLToPath(import.meta.url));
const host = createHost({ dataDir: app.getPath('userData'), log: (l) => console.log(`[hull] ${l}`) });
let win: BrowserWindow | null = null;

// A bad id from the page must not crash the process; the renderer shows the message.
const handle = (channel: string, fn: (...a: never[]) => unknown): void => {
  ipcMain.handle(`hull:${channel}`, async (_e, ...args) => {
    try { return await (fn as (...a: unknown[]) => unknown)(...args); }
    catch (e) { throw new Error(e instanceof Error ? e.message : String(e)); }
  });
};

function registerIpc(): void {
  handle('listTemplates', () => host.listTemplates());
  handle('listCommunity', () => host.listCommunity());
  handle('openCommunity', (id: string, reset?: boolean) => host.openCommunity(id, reset));
  handle('createProject', (opts: { template: string; title: string; parentDir: string }) => host.createProject(opts));
  handle('openProject', (root: string) => host.openProject(root));
  handle('closeProject', () => host.closeProject());
  handle('recents', () => host.recents());
  handle('forgetRecent', (root: string) => host.forgetRecent(root));
  handle('reveal', (path: string) => { shell.showItemInFolder(path); });
  handle('pickFolder', async (purpose: 'open' | 'location') => {
    const r = await dialog.showOpenDialog(win ?? undefined as never, {
      title: purpose === 'open' ? 'Open a Hull project' : 'Where should the project go?',
      properties: purpose === 'open' ? ['openDirectory'] : ['openDirectory', 'createDirectory'],
      buttonLabel: purpose === 'open' ? 'Open' : 'Choose',
    });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
}

async function createWindow(): Promise<void> {
  nativeTheme.themeSource = 'system';
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 620,
    title: 'Hull',
    // The title bar is ours: on macOS the traffic lights sit inside it, like Xcode.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 14 },
    backgroundColor: '#16181c',
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
  win.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' }; });
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
