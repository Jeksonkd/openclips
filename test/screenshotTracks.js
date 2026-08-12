// Visual + state smoke test for: 5 default tracks, auto-grow when the last
// track gets a clip, and project.moveClipToTrack() (the model-level half of
// the timeline's drag-to-retarget-track feature).
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
    if (level >= 3) errors.push(message);
  });
  await new Promise((r) => setTimeout(r, 600));

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const initialTrackCount = window.project.timeline.tracks.length;

      await window.importMediaFiles(['/tmp/cc-test/clipA.mp4']);
      const mediaId = Object.keys(window.project.media)[0];
      const lastTrack = window.project.timeline.tracks[window.project.timeline.tracks.length - 1];
      const clip = window.project.addClipToTrack(lastTrack.id, mediaId, 0);
      const afterInsertCount = window.project.timeline.tracks.length;

      const firstTrack = window.project.timeline.tracks[0];
      window.project.moveClipToTrack(clip.id, firstTrack.id);
      const movedOk = window.project.findClip(clip.id).track.id === firstTrack.id;
      const afterMoveCount = window.project.timeline.tracks.length;

      window.renderTimeline();
      await new Promise((r) => setTimeout(r, 150));

      return {
        initialTrackCount,
        afterInsertCount,
        afterMoveCount,
        movedOk,
        lastTrackEmpty: window.project.timeline.tracks[window.project.timeline.tracks.length - 1].clips.length === 0,
        trackRowCount: document.querySelectorAll('.track-row').length,
      };
    })()
  `);
  console.log('RESULT:', JSON.stringify(result, null, 2));

  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage();
  fs.writeFileSync('/tmp/cc-test/tracks_screenshot.png', img.toPNG());
  console.log('Screenshot saved.');
  console.log('Console errors/warnings seen:', errors.length ? errors : 'none');

  app.quit();
});
