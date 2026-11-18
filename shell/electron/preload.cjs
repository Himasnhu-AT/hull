// The only bridge between the game page and the shell. Plain CommonJS because a sandboxed preload cannot be an ES
// module. The page gets `window.hullShell` and nothing else: no Node, no ipcRenderer. Calls are synchronous
// (`sendSync`) because the platform's save API is synchronous; saves are small and rare.
const { contextBridge, ipcRenderer } = require('electron');

const sync = (channel, ...args) => ipcRenderer.sendSync(`hull-shell:${channel}`, ...args);

contextBridge.exposeInMainWorld('hullShell', {
  platform: process.platform,
  read: (area, name) => sync('read', area, name),
  write: (area, name, text) => sync('write', area, name, text) === true,
  remove: (area, name) => { sync('remove', area, name); },
  list: (area) => sync('list', area) || [],
  getFullscreen: () => sync('fullscreen:get') === true,
  setFullscreen: (on) => { sync('fullscreen:set', !!on); },
  quit: () => { sync('quit'); },
});
