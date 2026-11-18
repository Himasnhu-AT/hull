// The only bridge between the page and the main process. Plain CommonJS because a sandboxed preload cannot be
// an ES module. The page gets `window.hullApp` and nothing else: no Node, no ipcRenderer.
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(`hull:${channel}`, ...args);

contextBridge.exposeInMainWorld('hullApp', {
  platform: process.platform,
  listTemplates: call('listTemplates'),
  pickFolder: call('pickFolder'),
  createProject: call('createProject'),
  openProject: call('openProject'),
  closeProject: call('closeProject'),
  recents: call('recents'),
  forgetRecent: call('forgetRecent'),
  reveal: call('reveal'),
  initialProject: () => Promise.resolve(null),
});
