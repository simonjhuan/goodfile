const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  serveBuffer: (fileName, mimeType, arrayBuffer) =>
    ipcRenderer.invoke('serve-buffer', fileName, mimeType, arrayBuffer),
  stopServer: () => ipcRenderer.invoke('stop-server'),
  getLanIP: () => ipcRenderer.invoke('get-lan-ip'),
  startReceiveServer: () => ipcRenderer.invoke('start-receive-server'),
  stopReceiveServer: () => ipcRenderer.invoke('stop-receive-server'),
  onFileReceived: (callback) => ipcRenderer.on('file-received', (_event, data) => callback(data)),
});
