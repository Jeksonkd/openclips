const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('engine', {
  openMediaDialog: () => ipcRenderer.invoke('dialog:openMedia'),
  saveProjectDialog: () => ipcRenderer.invoke('dialog:saveProject'),
  openProjectDialog: () => ipcRenderer.invoke('dialog:openProject'),
  exportLocationDialog: (suggestedName) => ipcRenderer.invoke('dialog:exportLocation', suggestedName),

  saveProject: (filePath, json) => ipcRenderer.invoke('project:save', filePath, json),
  loadProject: (filePath) => ipcRenderer.invoke('project:load', filePath),

  probeMedia: (filePath) => ipcRenderer.invoke('media:probe', filePath),
  thumbnail: (filePath, atSeconds) => ipcRenderer.invoke('media:thumbnail', filePath, atSeconds),

  startExport: (project, outputPath) => ipcRenderer.invoke('export:start', project, outputPath),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  onExportProgress: (cb) => {
    const listener = (evt, progress) => cb(progress);
    ipcRenderer.on('export:progress', listener);
    return () => ipcRenderer.removeListener('export:progress', listener);
  },

  toMediaUrl: (filePath) => 'media://' + encodeURIComponent(filePath),
  getPathForFile: (file) => webUtils.getPathForFile(file),
});
