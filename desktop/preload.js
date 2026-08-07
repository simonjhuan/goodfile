const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  serveBuffer: (fileName, mimeType, arrayBuffer) =>
    ipcRenderer.invoke('serve-buffer', fileName, mimeType, arrayBuffer),
  stopServer: () => ipcRenderer.invoke('stop-server'),
  getLanIP: () => ipcRenderer.invoke('get-lan-ip'),
});
