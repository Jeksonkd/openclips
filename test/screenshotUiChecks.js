// Visual + state smoke test for this round's UI-facing changes: no more
// auto-track-add, effect clips can't be transformed via the preview overlay,
// and the renamed Mask & Blend tab shows mask controls for a media clip.
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
  win.webContents.on('console-message', (e, level, message) => { if (level >= 3) errors.push(message); });
  await new Promise((r) => setTimeout(r, 600));

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const initialTrackCount = window.project.timeline.tracks.length;
      const lastTrack = window.project.timeline.tracks[window.project.timeline.tracks.length - 1];
      const fxClip = window.project.addEffectClip(lastTrack.id, 0, 3);
      const afterInsertCount = window.project.timeline.tracks.length;

      await window.importMediaFiles(['/tmp/cc-test/clipA.mp4']);
      const mediaId = Object.keys(window.project.media)[0];
      const mediaTrack = window.project.timeline.tracks[0];
      const mediaClip = window.project.addClipToTrack(mediaTrack.id, mediaId, 0);
      mediaClip.outPoint = 3;

      window.renderTimeline();
      window.selectClip(fxClip.id);
      window.project.emit('selection:changed');
      await new Promise((r) => setTimeout(r, 100));
      const overlayHiddenForEffect = window.canvasOverlay.box.style.display === 'none';

      window.selectClip(mediaClip.id);
      window.project.emit('selection:changed');
      document.querySelector('#inspector-tabs [data-tab="blend"]').click();
      await new Promise((r) => setTimeout(r, 100));
      const blendTabLabel = document.querySelector('#inspector-tabs [data-tab="blend"]').textContent;
      const maskShapeSelectExists = !!Array.from(document.querySelectorAll('#inspector-panes select')).find(
        (s) => Array.from(s.options).some((o) => o.value === 'ellipse')
      );

      return {
        initialTrackCount, afterInsertCount, tracksUnchanged: initialTrackCount === afterInsertCount,
        overlayHiddenForEffect, blendTabLabel, maskShapeSelectExists,
      };
    })()
  `);
  console.log('RESULT:', JSON.stringify(result, null, 2));

  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage();
  fs.writeFileSync('/tmp/cc-test/ui_checks_screenshot.png', img.toPNG());
  console.log('Screenshot saved.');
  console.log('Console errors/warnings seen:', errors.length ? errors : 'none');

  app.quit();
});
