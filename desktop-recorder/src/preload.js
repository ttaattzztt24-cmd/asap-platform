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

  getZoomStatus: () => ipcRenderer.invoke('zoom:status'),

  beginRecording: (trigger) => ipcRenderer.invoke('rec:begin', { trigger }),
  writeChunk: (arrayBuffer) => ipcRenderer.invoke('rec:chunk', arrayBuffer),
  endRecording: () => ipcRenderer.invoke('rec:end'),

  listRecordings: () => ipcRenderer.invoke('recordings:list'),
  openFolder: () => ipcRenderer.invoke('recordings:open-folder'),
  reveal: (filePath) => ipcRenderer.invoke('recordings:reveal', filePath),
  deleteRecording: (filePath) => ipcRenderer.invoke('recordings:delete', filePath),

  onZoomStatus: on('zoom:status'),
  onControlStart: on('control:start'),
  onControlStop: on('control:stop'),
});
