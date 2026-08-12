// Visual smoke test for the new transitions/animations UI: launches the real
// app, builds two adjacent clips on a track, applies a transition between
// them (exercising the same project.applyTransition() path the timeline's
// "+" marker button calls), selects the second clip and switches the
// inspector to the new Animate tab, then screenshots the window.
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

  const errors = [];
  win.webContents.on('console-message', (e, level, message) => {
    console.log('[renderer]', message);
    if (level >= 3) errors.push(message);
  });
  await new Promise((r) => setTimeout(r, 600));

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      await window.importMediaFiles(['/tmp/cc-test/clipA.mp4', '/tmp/cc-test/clipB.mp4']);
      const mediaIds = Object.keys(window.project.media);
      const track = window.project.timeline.tracks[0];
      const clipA = window.project.addClipToTrack(track.id, mediaIds[0], 0);
      clipA.outPoint = 4;
      const clipB = window.project.addClipToTrack(track.id, mediaIds[1], 4);
      clipB.outPoint = 4;
      window.project.emit('tracks:changed');
      window.project.applyTransition(track.id, clipA.id, clipB.id, 'fade', 0.6);
      window.selectClip(clipB.id);
      window.project.emit('selection:changed');
      document.querySelector('#inspector-tabs [data-tab="animate"]').click();
      await new Promise((r) => setTimeout(r, 150));
      return {
        clipBStartTime: clipB.startTime,
        clipBAnimIn: clipB.animIn,
        clipAAnimOut: clipA.animOut,
        clipBTransitionIn: clipB.transitionIn,
        markerCount: document.querySelectorAll('.transition-marker').length,
        markerActive: document.querySelectorAll('.transition-marker.active').length,
        animateTabVisible: getComputedStyle(document.querySelector('#inspector-tabs [data-tab="animate"]')).display !== 'none',
      };
    })()
  `);
  console.log('RESULT:', JSON.stringify(result, null, 2));

  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage();
  fs.writeFileSync('/tmp/cc-test/transition_ui_screenshot.png', img.toPNG());
  console.log('Screenshot saved.');
  console.log('Console errors/warnings seen:', errors.length ? errors : 'none');

  app.quit();
});
