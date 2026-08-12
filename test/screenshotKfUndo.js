// Visual + state smoke test for: keyframe click-to-edit popup (easing +
// delete) and Ctrl+Z-equivalent undo/redo (calling History.undo/redo
// directly, since dispatching real keyboard events reliably in this
// headless harness is unreliable - the important thing to verify is that
// History itself actually captures and restores state correctly).
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

  const kfResult = await win.webContents.executeJavaScript(`
    (async () => {
      await window.importMediaFiles(['/tmp/cc-test/clipA.mp4']);
      const mediaId = Object.keys(window.project.media)[0];
      const track = window.project.timeline.tracks[0];
      const clip = window.project.addClipToTrack(track.id, mediaId, 0);
      clip.outPoint = 4;
      KF.add(clip, 'positionX', 0, -100);
      KF.add(clip, 'positionX', 2, 100);
      window.renderTimeline();
      window.selectClip(clip.id);
      window.project.emit('selection:changed');
      await new Promise((r) => setTimeout(r, 100));

      const dot = document.querySelector('.clip-kf-dot');
      const dotFound = !!dot;
      dot.click();
      await new Promise((r) => setTimeout(r, 100));
      const menu = document.querySelector('.kf-popup-menu');
      const menuOpened = !!menu;
      const select = menu.querySelector('select');
      const defaultEasing = select.value;
      select.value = 'ease-in';
      select.dispatchEvent(new Event('change'));
      const easingAfterChange = clip.keyframes.find((k) => Math.abs(k.timestamp - 0) < 0.01).easing;

      const delBtn = menu.querySelector('.kf-popup-delete');
      const kfCountBefore = clip.keyframes.length;
      delBtn.click();
      const kfCountAfter = clip.keyframes.length;
      const menuClosedAfterDelete = !document.querySelector('.kf-popup-menu');

      return { dotFound, menuOpened, defaultEasing, easingAfterChange, kfCountBefore, kfCountAfter, menuClosedAfterDelete };
    })()
  `);
  console.log('KF POPUP RESULT:', JSON.stringify(kfResult, null, 2));

  const undoResult = await win.webContents.executeJavaScript(`
    (async () => {
      const track = window.project.timeline.tracks[0];
      const beforeCount = track.clips.length;
      await new Promise((r) => setTimeout(r, 700)); // let History capture the current (pre-mutation) state

      const mediaId = Object.keys(window.project.media)[0];
      const newClip = window.project.addClipToTrack(track.id, mediaId, 10);
      const afterAddCount = track.clips.length;
      await new Promise((r) => setTimeout(r, 700)); // let History capture the post-mutation state

      window.History.undo();
      await new Promise((r) => setTimeout(r, 100));
      const afterUndoCount = window.project.timeline.tracks[0].clips.length;

      window.History.redo();
      await new Promise((r) => setTimeout(r, 100));
      const afterRedoCount = window.project.timeline.tracks[0].clips.length;

      return { beforeCount, afterAddCount, afterUndoCount, afterRedoCount };
    })()
  `);
  console.log('UNDO/REDO RESULT:', JSON.stringify(undoResult, null, 2));

  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage();
  fs.writeFileSync('/tmp/cc-test/kf_undo_screenshot.png', img.toPNG());
  console.log('Screenshot saved.');
  console.log('Console errors/warnings seen:', errors.length ? errors : 'none');

  app.quit();
});
