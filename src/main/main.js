const { app, BrowserWindow, ipcMain, dialog, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const { probeMedia, generateThumbnail } = require('./ffmpegEngine');
const { runExport, cancelExport } = require('./exportGraph');

protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: false, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true, stream: true } },
]);

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#1b1d21',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // Local media files are loaded through the custom "media://" protocol
      // registered below, so renderer stays sandboxed from the raw filesystem.
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.webContents.on('did-finish-load', () => {
    if (process.env.CAPCUT_DEVTOOLS) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });
  if (process.env.CAPCUT_LOG_CONSOLE) {
    mainWindow.webContents.on('console-message', (evt, level, message, line, sourceId) => {
      console.log(`[renderer] ${sourceId}:${line} ${message}`);
    });
  }
}

app.whenReady().then(() => {
  const { protocol, net } = require('electron');
  protocol.handle('media', (request) => {
    const filePath = decodeURIComponent(request.url.slice('media://'.length));
    return net.fetch('file://' + filePath);
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- IPC: dialogs ----------

ipcMain.handle('dialog:openMedia', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Media',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Media', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'png', 'jpg', 'jpeg', 'gif', 'webp'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (res.canceled) return [];
  return res.filePaths;
});

ipcMain.handle('dialog:saveProject', async () => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Project',
    defaultPath: 'project.ccproj.json',
    filters: [{ name: 'OpenCut Project', extensions: ['json'] }],
  });
  if (res.canceled) return null;
  return res.filePath;
});

ipcMain.handle('dialog:openProject', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Project',
    properties: ['openFile'],
    filters: [{ name: 'OpenCut Project', extensions: ['json'] }],
  });
  if (res.canceled) return null;
  return res.filePaths[0];
});

ipcMain.handle('dialog:exportLocation', async (evt, suggestedName) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Video',
    defaultPath: suggestedName || 'export.mp4',
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
  });
  if (res.canceled) return null;
  return res.filePath;
});

// ---------- IPC: project persistence ----------

ipcMain.handle('project:save', async (evt, filePath, json) => {
  fs.writeFileSync(filePath, json, 'utf-8');
  return true;
});

ipcMain.handle('project:load', async (evt, filePath) => {
  return fs.readFileSync(filePath, 'utf-8');
});

// ---------- IPC: media probing / thumbnails ----------

ipcMain.handle('media:probe', async (evt, filePath) => {
  return probeMedia(filePath);
});

ipcMain.handle('media:thumbnail', async (evt, filePath, atSeconds) => {
  const tmpDir = path.join(app.getPath('temp'), 'opencut-engine-thumbs');
  fs.mkdirSync(tmpDir, { recursive: true });
  const outPath = path.join(tmpDir, `${path.basename(filePath)}.${Math.round((atSeconds || 0) * 1000)}.jpg`);
  await generateThumbnail(filePath, atSeconds || 0, outPath);
  return outPath;
});

// ---------- IPC: export ----------

ipcMain.handle('export:start', async (evt, project, outputPath) => {
  await runExport(project, outputPath, (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('export:progress', progress);
    }
  });
  return true;
});

ipcMain.handle('export:cancel', async () => {
  cancelExport();
  return true;
});
