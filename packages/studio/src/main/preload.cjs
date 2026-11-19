// The only bridge between the page and the main process. Plain CommonJS because a sandboxed preload cannot be
// an ES module. The page gets `window.hullApp` and nothing else: no Node, no ipcRenderer.
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(`hull:${channel}`, ...args);

contextBridge.exposeInMainWorld('hullApp', {
  platform: process.platform,
  listTemplates: call('listTemplates'),
  pickFolder: call('pickFolder'),
  listCommunity: call('listCommunity'),
  openCommunity: call('openCommunity'),
  createProject: call('createProject'),
  createFromIdea: call('createFromIdea'),
  openProject: call('openProject'),
  closeProject: call('closeProject'),
  recents: call('recents'),
  forgetRecent: call('forgetRecent'),
  reveal: call('reveal'),
  agentList: call('agentList'),
  agentStart: call('agentStart'),
  agentPrompt: call('agentPrompt'),
  agentEnsure: call('agentEnsure'),
  agentSettings: call('agentSettings'),
  setAgentSettings: call('setAgentSettings'),
  agentCancel: call('agentCancel'),
  agentStop: call('agentStop'),
  agentAnswer: call('agentAnswer'),
  claudeInfo: call('claudeInfo'),
  cliStatus: call('cliStatus'),
  cliRun: call('cliRun'),
  termOpen: call('termOpen'),
  termWrite: call('termWrite'),
  termResize: call('termResize'),
  termKill: call('termKill'),
  onAgentEvent: (cb) => {
    const l = (_e, ev) => cb(ev);
    ipcRenderer.on('hull:agent-event', l);
    return () => ipcRenderer.removeListener('hull:agent-event', l);
  },
  initialProject: () => Promise.resolve(null),
});
