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

  // Draw clips render on an arbitrary freehand path ffmpeg has no filter for
  // - the renderer pre-renders each frame to a PNG (drawEngine.js, the same
  // code the live preview uses) and ships the raw bytes here to be written
  // to a temp PNG sequence, which exportGraph.js then feeds to ffmpeg as a
  // plain image2 input, just like it already does for still images.
  writeDrawFrames: (clipId, frameBuffers) => ipcRenderer.invoke('draw:writeFrames', clipId, frameBuffers),

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
