const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (handler) => {
  const listener = (_e, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('recorderApi', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  chooseFolder: () => ipcRenderer.invoke('settings:choose-folder'),

  getMeetingStatus: () => ipcRenderer.invoke('meeting:status'),
  log: (message) => ipcRenderer.invoke('log:write', message),
  findMeetingMic: (args) => ipcRenderer.invoke('mic:meeting', args),
  addMeeting: (name, link) => ipcRenderer.invoke('meetings:add', { name, link }),
  addCurrentMeeting: (name) => ipcRenderer.invoke('meetings:add-current', { name }),
  removeMeeting: (kind, id) => ipcRenderer.invoke('meetings:remove', { kind, id }),
  openLog: () => ipcRenderer.invoke('log:open'),

  beginRecording: (trigger, title) => ipcRenderer.invoke('rec:begin', { trigger, title }),
  writeChunk: (arrayBuffer) => ipcRenderer.invoke('rec:chunk', arrayBuffer),
  endRecording: () => ipcRenderer.invoke('rec:end'),

  listRecordings: () => ipcRenderer.invoke('recordings:list'),
  openFolder: () => ipcRenderer.invoke('recordings:open-folder'),
  reveal: (filePath) => ipcRenderer.invoke('recordings:reveal', filePath),
  deleteRecording: (filePath) => ipcRenderer.invoke('recordings:delete', filePath),
  exportBegin: (filePath) => ipcRenderer.invoke('export:begin', filePath),
  exportRead: (filePath, offset, length) => ipcRenderer.invoke('export:read', filePath, offset, length),
  exportWrite: (id, data) => ipcRenderer.invoke('export:write', id, data),
  exportEnd: (id, ok) => ipcRenderer.invoke('export:end', id, ok),

  onMeetingStatus: on('meeting:status'),
  onBrowserProblem: on('meeting:browser-problem'),
  onControlStart: on('control:start'),
  onControlStop: on('control:stop'),
});
