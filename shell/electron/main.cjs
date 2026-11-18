// Hull desktop shell: one window that shows the game built into ./web (dist/web of the project). The page runs
// sandboxed with no Node; saves and window control reach it only through preload.cjs.
const { app, BrowserWindow, ipcMain, net, protocol, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const pkg = require('./package.json');
const WEB = process.env.HULL_WEB_DIR ? path.resolve(process.env.HULL_WEB_DIR) : path.join(__dirname, 'web');
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const AREAS = { saves: 'saves', settings: 'settings' };

// A module script cannot load from file:// (its origin is "null"), so the game is served from its own scheme.
protocol.registerSchemesAsPrivileged([{ scheme: 'hull', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

if (process.env.HULL_SHELL_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.HULL_SHELL_DEBUG_PORT);

// Player data lives in the OS's app-data folder, under the game's name.
const dataDir = (area) => path.join(app.getPath('userData'), AREAS[area]);
const fileFor = (area, name) => {
  if (!AREAS[area] || typeof name !== 'string' || !NAME_RE.test(name)) return null;
  return path.join(dataDir(area), `${name}.json`);
};

let win = null;

function handle(channel, fn) {
  ipcMain.on(`hull-shell:${channel}`, (event, ...args) => {
    // Only our own window may ask.
    if (!win || event.sender !== win.webContents) { event.returnValue = null; return; }
    try { event.returnValue = fn(...args); } catch (e) { console.error(`[hull shell] ${channel}: ${e.message}`); event.returnValue = null; }
  });
}

handle('read', (area, name) => {
  const f = fileFor(area, name);
  if (!f) return null;
  try { return fs.readFileSync(f, 'utf8'); } catch { return null; }
});
handle('write', (area, name, text) => {
  const f = fileFor(area, name);
  if (!f || typeof text !== 'string' || text.length > 16 * 1024 * 1024) return false;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  // Write beside, then rename: a crash mid-write leaves the old save, never half of a new one.
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, f);
  return true;
});
handle('remove', (area, name) => {
  const f = fileFor(area, name);
  if (f) fs.rmSync(f, { force: true });
  return true;
});
handle('list', (area) => {
  if (!AREAS[area]) return [];
  try { return fs.readdirSync(dataDir(area)).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((n) => NAME_RE.test(n)).sort(); } catch { return []; }
});
handle('fullscreen:get', () => (win ? win.isFullScreen() : false));
handle('fullscreen:set', (on) => { win?.setFullScreen(!!on); return true; });
handle('quit', () => { app.quit(); return true; });

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 640,
    minHeight: 360,
    show: false,
    backgroundColor: '#111111',
    title: pkg.productName || pkg.name,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  // F11 toggles fullscreen everywhere; the game's own settings screen uses the bridge instead.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); event.preventDefault(); }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('hull://game/')) e.preventDefault(); });
  void win.loadURL('hull://game/index.html');

  // Self-check for `hull package`: save a screenshot after a moment, then quit.
  const shot = process.env.HULL_SHELL_SCREENSHOT;
  if (shot) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try { fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG()); } catch (e) { console.error(`[hull shell] screenshot: ${e.message}`); }
        app.quit();
      }, Number(process.env.HULL_SHELL_SCREENSHOT_DELAY_MS) || 2500);
    });
  }
}

app.whenReady().then(() => {
  protocol.handle('hull', (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(WEB, rel);
    // Nothing outside the game's folder is ever served.
    if (file !== WEB && !file.startsWith(WEB + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString()).then((r) => {
      const headers = new Headers(r.headers);
      headers.set('Content-Security-Policy', "default-src 'self' data: blob: 'unsafe-inline' 'wasm-unsafe-eval'");
      return new Response(r.body, { status: r.status, headers });
    });
  });
  // A game has no application menu beyond quit and fullscreen; Windows and Linux get none.
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
      { label: 'View', submenu: [{ role: 'togglefullscreen' }] },
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
