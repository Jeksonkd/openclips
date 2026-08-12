// Launches the REAL app (requires the actual main.js, so every ipcMain
// handler + the media:// protocol are registered exactly as in production),
// imports test media through the actual renderer code path, and screenshots
// the window so we can visually inspect what's happening (can't otherwise
// interactively drag/click in this sandbox).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');

require('../src/main/main.js');

app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 50 && !win; i++) {
    win = BrowserWindow.getAllWindows()[0];
    if (!win) await new Promise((r) => setTimeout(r, 100));
  }
  if (!win) { console.error('No window found'); app.exit(1); return; }

  win.webContents.on('console-message', (e, level, message) => console.log('[renderer]', message));
  await new Promise((r) => setTimeout(r, 600));

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      await window.importMediaFiles(['/tmp/cc-test/clipA.mp4', '/tmp/cc-test/logo.png']);
      window.renderAssetList();
      const items = Array.from(document.querySelectorAll('.asset-item')).map((item) => {
        const img = item.querySelector('img.asset-thumb');
        return {
          name: item.querySelector('.asset-name').textContent,
          imgSrc: img ? img.src : null,
          naturalWidth: img ? img.naturalWidth : null,
          complete: img ? img.complete : null,
        };
      });
      return { mediaCount: Object.keys(window.project.media).length, items, thumbPaths: Object.values(window.project.media).map(m => m.thumbPath) };
    })()
  `);
  console.log('RESULT:', JSON.stringify(result, null, 2));

  await new Promise((r) => setTimeout(r, 800));
  const img = await win.webContents.capturePage();
  fs.writeFileSync('/tmp/cc-test/asset_panel_screenshot.png', img.toPNG());
  console.log('Screenshot saved.');

  app.quit();
});
